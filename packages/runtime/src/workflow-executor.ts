/**
 * Workflow executor.
 *
 * Bridges the workflow engine to the actual harness (acpx).
 * Each task gets:
 *   1. A git worktree (via WorkspaceManager)
 *   2. A durable SQLite journal keyed to the run
 *   3. A workflow run through the workflow engine
 *   4. Real agent calls routed via the RoleRouter → AcpxRuntimeAdapter
 *   5. Commit + push of the agent's work to the SCM remote
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskId, RunId } from '@dark-kitchen/core';
import { createProjectId, createRepositoryId } from '@dark-kitchen/core';
import { controlArgument, defineProcess, executeProcess } from '@dark-kitchen/process-execution';
import { runWorkflow, type RoleResolver } from '@dark-kitchen/workflow-engine';
import type { WorkflowFn } from '@dark-kitchen/workflow-engine';
import { SqliteDurableJournal } from './durable-journal.js';
import type { WorkflowOutcome } from './daemon-loop.js';
import {
  VerificationEnvironmentController,
  type VerificationEnvironmentConfig,
} from './verification-environment.js';

export interface WorkflowExecutorConfig {
  readonly databasePath: string;
  readonly worktreesBaseDir: string;
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly targetBranch?: string;
  readonly branchPrefix?: string;
  /** Git remote name. Defaults to `origin`. */
  readonly pushRemote?: string;
  /** Optional GitHub token passed only through the child environment, never argv. */
  readonly pushToken?: string;
  /** Optional task-requested verification profile; absent tasks stay lightweight. */
  readonly verificationProfileId?: string;
  /** Configured semantic verifier role used by the built-in verification workflow. */
  readonly verificationRoleId?: string;
  /** Sanitized task requirements, profile policy, and inspected capability state for the verifier. */
  readonly verificationContext?: Readonly<Record<string, unknown>>;
  /** Whether a failed/missing result blocks workflow success and PR readiness. Defaults to true. */
  readonly verificationBlocking?: boolean;
  /** Configured verifier runtime bound. */
  readonly verificationTimeoutMs?: number;
  /** Trusted verifier resources selected by the project configuration. */
  readonly verificationResources?: {
    readonly skills?: readonly string[];
    readonly mcpServers?: readonly string[];
    readonly tools?: readonly string[];
  };
  /** Shell-free environment lifecycle run lazily around independent verification. */
  readonly verificationEnvironment?: VerificationEnvironmentConfig;
}

export interface WorkflowExecutorDeps {
  // Using unknown to avoid circular dependency — cast at call site
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly workspaceManager: any;
  readonly roleResolver: RoleResolver;
  readonly workflow: WorkflowFn<WorkflowExecutorResult>;
}

/** Task context passed into the workflow so agents know what to implement. */
export interface WorkflowTask {
  readonly id: TaskId;
  readonly title: string;
  readonly description?: string;
}

/** Workflow result shape as produced by the workflow function (not to be confused with WorkflowOutcome). */
export interface WorkflowExecutorResult {
  readonly summary: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly noCodeOutcome?: boolean;
  readonly verificationPassed?: boolean;
  readonly verificationSummary?: string;
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
}

/**
 * Execute a workflow for a task:
 * 1. Allocate/reuse the task's primary worktree
 * 2. Load/create a durable journal for this run
 * 3. Run the workflow (replay completed steps from journal)
 * 4. Commit + push the agent's work to the SCM remote
 * 5. Return a WorkflowOutcome with the worktree branch as sourceBranch
 */
export async function executeWorkflow(
  task: WorkflowTask,
  runId: RunId,
  config: WorkflowExecutorConfig,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowOutcome> {
  const projectId = createProjectId('default');
  const repositoryId = createRepositoryId(config.repositoryId);

  // 1. Allocate worktree (idempotent — reuses existing on retry)
  const workspace = await deps.workspaceManager.allocatePrimaryWorktree({
    projectId,
    taskId: task.id,
    repositoryId,
  });

  // 2. Durable journal backed by the run's SQLite database
  const journalPath = config.databasePath.replace('.db', `-journal-${runId}.db`);
  const journal = new SqliteDurableJournal(journalPath, runId);
  const verificationEnvironment = config.verificationEnvironment
    ? new VerificationEnvironmentController(config.verificationEnvironment)
    : undefined;
  let executionFailed = false;
  let executionError: unknown;
  let teardownFailed = false;
  let teardownError: unknown;
  let outcome: WorkflowOutcome | undefined;

  try {
    // 3. Read AGENTS.md from the worktree for additional context injection
    const agentsMd = await readAgentsMd(workspace.path);

    // 4. Wrap the resolver to inject task context, AGENTS.md and the workspace
    //    path into every agent call. The task title/description is what tells
    //    the agent what to actually implement.
    const taskPrompt = buildTaskPrompt(task);
    const resolverWithContext: typeof deps.roleResolver = async (role) => {
      const configuredRole =
        role === 'verifier' && config.verificationRoleId ? config.verificationRoleId : role;
      const inner = await deps.roleResolver(configuredRole);
      return async (input, signal) => {
        const effectiveSignal =
          role === 'verifier' && config.verificationTimeoutMs
            ? AbortSignal.any([signal, AbortSignal.timeout(config.verificationTimeoutMs)])
            : signal;
        const environmentResults =
          role === 'verifier' && verificationEnvironment
            ? await verificationEnvironment.prepare(workspace.path, effectiveSignal)
            : undefined;
        const parts = [taskPrompt, agentsMd, input.prompt].filter(Boolean);
        const verificationContext =
          role === 'verifier' && config.verificationContext
            ? {
                verification: {
                  ...config.verificationContext,
                  ...(environmentResults ? { environmentResults } : {}),
                },
              }
            : undefined;
        const augmented = {
          ...input,
          prompt: parts.join('\n\n---\n\n'),
          context: {
            ...(input.context ?? {}),
            ...(verificationContext ?? {}),
          },
          workspacePath: workspace.path,
          runId,
          taskId: task.id,
          ...(role === 'verifier' && config.verificationResources
            ? { runtimeResources: config.verificationResources }
            : {}),
        };
        return inner(augmented, effectiveSignal);
      };
    };

    // 5. Run workflow with real agent resolver
    const result = await runWorkflow(deps.workflow, {
      runId,
      journal,
      resolver: resolverWithContext,
    });

    const verificationRequired =
      config.verificationProfileId !== undefined && config.verificationBlocking !== false;
    const verificationPassed = !verificationRequired || result.verificationPassed === true;
    const workflowSucceeded =
      result.repositoryTestsPassed && result.reviewPassed && verificationPassed;

    // 6. Dark Kitchen owns publishing. A failed review/test/verification run
    //    remains in its durable worktree for a controlled retry and must never
    //    push an unready branch merely because the workflow function returned.
    const sourceBranch = await getCurrentBranch(workspace.path);
    if (workflowSucceeded && !result.noCodeOutcome) {
      await commitWorkingChanges(workspace.path, task.id);
      await pushBranch(
        workspace.path,
        config.pushRemote ?? 'origin',
        sourceBranch,
        config.pushToken,
      );
    }
    const worktreeClean = await isWorkingTreeClean(workspace.path);

    // 7. Collect commits made in this run. Agents may have committed directly;
    //    these still remain local when the workflow gate failed.
    const commits = await getNewCommits(workspace.path, config.targetBranch ?? 'main');

    const verificationSummary =
      result.verificationGateSummary ??
      result.verificationSummary ??
      (verificationRequired && result.verificationPassed === undefined
        ? 'The selected workflow did not produce an independent verification verdict.'
        : undefined);
    const verificationResults = config.verificationProfileId
      ? [
          {
            profileId: config.verificationProfileId,
            status:
              result.verificationPassed === true
                ? ('passed' as const)
                : result.verificationPassed === false
                  ? ('failed' as const)
                  : ('blocked' as const),
            ...(verificationSummary ? { summary: verificationSummary } : {}),
            evidenceRefs: result.evidenceRefs ?? [],
          },
        ]
      : undefined;

    outcome = {
      success: workflowSucceeded,
      summary: result.summary,
      commits,
      sourceBranch,
      repositoryTestsPassed: result.repositoryTestsPassed,
      reviewPassed: result.reviewPassed,
      worktreeClean,
      journalPath,
      ...(result.noCodeOutcome ? { noCodeOutcome: true } : {}),
      ...(verificationSummary ? { verificationGateSummary: verificationSummary } : {}),
      ...(result.evidenceRefs ? { evidenceRefs: result.evidenceRefs } : {}),
      ...(verificationResults ? { verificationResults } : {}),
      ...(verificationRequired && config.verificationProfileId
        ? { requiredVerificationProfiles: [config.verificationProfileId] }
        : {}),
    };
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    try {
      await verificationEnvironment?.teardown(workspace.path);
    } catch (error) {
      teardownFailed = true;
      teardownError = error;
    } finally {
      journal.close();
    }
  }
  if (executionFailed && teardownFailed) {
    throw new AggregateError(
      [executionError, teardownError],
      'Workflow execution and verification environment teardown both failed',
    );
  }
  if (executionFailed) throw executionError;
  if (teardownFailed) throw teardownError;
  if (!outcome) throw new Error('Workflow completed without producing an outcome');
  return outcome;
}

function buildTaskPrompt(task: WorkflowTask): string {
  const lines: string[] = [
    'You are a Dark Kitchen coding agent.',
    'You are running autonomously in a CI-like environment with no human available to answer questions.',
    'Do NOT wait for user approval or pause for confirmation. Make reasonable assumptions and proceed to fully implement the task.',
    'If you genuinely need a product decision, clarification, or approval that you cannot reasonably assume, call the `dk_ask_human` MCP tool (server "dark-kitchen") with your question; it notifies the human and returns their reply before you continue.',
    '',
    `TASK TITLE: ${task.title}`,
  ];
  if (task.description) {
    lines.push('', 'TASK DESCRIPTION:', task.description);
  }
  return lines.join('\n');
}

/**
 * Read AGENTS.md (or .dark-kitchen/AGENTS.md) from the worktree.
 * Returns null if neither file exists.
 */
async function readAgentsMd(worktreePath: string): Promise<string | null> {
  const candidates = [
    join(worktreePath, '.dark-kitchen', 'AGENTS.md'),
    join(worktreePath, 'AGENTS.md'),
    join(worktreePath, '.github', 'AGENTS.md'),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // try next
    }
  }
  return null;
}

async function gitExec(
  cwd: string,
  args: readonly string[],
  environment?: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  const result = await executeProcess({
    definition: defineProcess({
      executable: 'git',
      args: args.map(controlArgument),
      label: 'git-lifecycle',
    }),
    cwd,
    ...(environment ? { environment } : {}),
  });
  const stdout = Buffer.from(result.stdout).toString('utf8');
  const stderr = Buffer.from(result.stderr).toString('utf8');
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? 'command'} exited ${String(result.exitCode)}: ${stderr.trim()}`,
    );
  }
  return stdout;
}

/**
 * Stage and commit any uncommitted changes left by the agent. No-op when the
 * worktree is already clean (e.g. the agent committed its own work).
 */
async function commitWorkingChanges(worktreePath: string, taskId: TaskId): Promise<void> {
  const status = (await gitExec(worktreePath, ['status', '--porcelain'])).trim();
  if (status.length === 0) return;
  await gitExec(worktreePath, ['add', '--all']);
  await gitExec(worktreePath, [
    '-c',
    'user.name=Dark Kitchen',
    '-c',
    'user.email=dark-kitchen@users.noreply.github.com',
    'commit',
    '-m',
    `Implement ${taskId}`,
  ]);
}

async function isWorkingTreeClean(worktreePath: string): Promise<boolean> {
  return (await gitExec(worktreePath, ['status', '--porcelain'])).trim().length === 0;
}

async function pushBranch(
  worktreePath: string,
  remote: string,
  branch: string,
  token?: string,
): Promise<void> {
  if (branch === 'unknown' || branch === 'HEAD') {
    throw new Error('Cannot push a detached or unknown worktree branch');
  }
  const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    environment['GIT_CONFIG_COUNT'] = '1';
    environment['GIT_CONFIG_KEY_0'] = 'http.https://github.com/.extraheader';
    environment['GIT_CONFIG_VALUE_0'] =
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  await gitExec(worktreePath, ['push', remote, `HEAD:refs/heads/${branch}`], environment);
}

async function getCurrentBranch(worktreePath: string): Promise<string> {
  try {
    return (await gitExec(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return 'unknown';
  }
}

async function getNewCommits(worktreePath: string, targetBranch: string): Promise<string[]> {
  try {
    const baseRef = `origin/${targetBranch}`;
    await gitExec(worktreePath, ['rev-parse', '--verify', baseRef]);
    const output = (await gitExec(worktreePath, ['log', '--format=%H', `${baseRef}..HEAD`])).trim();
    return output ? output.split('\n') : [];
  } catch {
    const output = (await gitExec(worktreePath, ['rev-list', '--max-count=5', 'HEAD'])).trim();
    return output ? output.split('\n') : [];
  }
}
