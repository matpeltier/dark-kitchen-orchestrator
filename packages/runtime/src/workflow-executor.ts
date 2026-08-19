/**
 * Workflow executor.
 *
 * Bridges the workflow engine to the actual harness (acpx).
 * Each task gets:
 *   1. A git worktree (via WorkspaceManager)
 *   2. A durable SQLite journal keyed to the run
 *   3. A workflow run through the workflow engine
 *   4. Real agent calls routed via the RoleRouter → AcpxRuntimeAdapter
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskId, RunId } from '@dark-kitchen/core';
import { createProjectId, createRepositoryId } from '@dark-kitchen/core';
import { runWorkflow, type RoleResolver } from '@dark-kitchen/workflow-engine';
import type { WorkflowFn } from '@dark-kitchen/workflow-engine';
import { SqliteDurableJournal } from './durable-journal.js';
import type { WorkflowOutcome } from './daemon-loop.js';

export interface WorkflowExecutorConfig {
  readonly databasePath: string;
  readonly worktreesBaseDir: string;
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly targetBranch?: string;
  readonly branchPrefix?: string;
}

export interface WorkflowExecutorDeps {
  // Using unknown to avoid circular dependency — cast at call site
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly workspaceManager: any;
  readonly roleResolver: RoleResolver;
  readonly workflow: WorkflowFn<WorkflowExecutorResult>;
}

/** Workflow result shape as produced by the workflow function (not to be confused with WorkflowOutcome). */
export interface WorkflowExecutorResult {
  readonly summary: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly noCodeOutcome?: boolean;
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
}

/**
 * Execute a workflow for a task:
 * 1. Allocate/reuse the task's primary worktree
 * 2. Load/create a durable journal for this run
 * 3. Run the workflow (replay completed steps from journal)
 * 4. Return a WorkflowOutcome with the worktree branch as sourceBranch
 */
export async function executeWorkflow(
  taskId: TaskId,
  runId: RunId,
  config: WorkflowExecutorConfig,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowOutcome> {
  const projectId = createProjectId('default');
  const repositoryId = createRepositoryId(config.repositoryId);

  // 1. Allocate worktree (idempotent — reuses existing on retry)
  const workspace = await deps.workspaceManager.allocatePrimaryWorktree({
    projectId,
    taskId,
    repositoryId,
  });

  // 2. Durable journal backed by the run's SQLite database
  const journalPath = config.databasePath.replace('.db', `-journal-${runId}.db`);
  const journal = new SqliteDurableJournal(journalPath, runId);

  try {
    // 3. Read AGENTS.md from the worktree for additional context injection
    const agentsMd = await readAgentsMd(workspace.path);

    // Wrap the resolver to inject AGENTS.md instructions into every role
    const resolverWithAgentsMd: typeof deps.roleResolver = agentsMd
      ? (role) => {
          const inner = deps.roleResolver(role);
          return async (input, signal) => {
            // Prepend AGENTS.md to the prompt as context
            const augmented = { ...input, prompt: `${agentsMd}\n\n---\n\n${input.prompt}` };
            return inner(augmented, signal);
          };
        }
      : deps.roleResolver;

    // 4. Run workflow with real agent resolver
    const result = await runWorkflow(deps.workflow, {
      runId,
      journal,
      resolver: resolverWithAgentsMd,
    });

    // 4. Get current branch from worktree
    const sourceBranch = await getCurrentBranch(workspace.path);

    // 5. Get commits since base
    const commits = await getNewCommits(workspace.path);

    return {
      success: result.repositoryTestsPassed && result.reviewPassed,
      summary: result.summary,
      commits,
      sourceBranch,
      repositoryTestsPassed: result.repositoryTestsPassed,
      reviewPassed: result.reviewPassed,
      ...(result.noCodeOutcome ? { noCodeOutcome: true } : {}),
      ...(result.verificationGateSummary
        ? { verificationGateSummary: result.verificationGateSummary }
        : {}),
      ...(result.evidenceRefs ? { evidenceRefs: result.evidenceRefs } : {}),
    };
  } finally {
    journal.close();
  }
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

async function getCurrentBranch(worktreePath: string): Promise<string> {
  const { execSync } = await import('node:child_process');
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function getNewCommits(worktreePath: string): Promise<string[]> {
  const { execSync } = await import('node:child_process');
  try {
    const output = execSync(
      'git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline HEAD~5..HEAD',
      {
        cwd: worktreePath,
        encoding: 'utf8',
      },
    ).trim();
    return output ? output.split('\n').map((l) => l.split(' ')[0] ?? l) : [];
  } catch {
    return [];
  }
}
