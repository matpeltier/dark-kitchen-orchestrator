/**
 * Dark Kitchen daemon main loop.
 *
 * Polls the tracker, schedules ready tasks, allocates worktrees, launches
 * durable workflows through acpx, and handles the PR/merge lifecycle.
 * This is the glue layer that connects all the packages together.
 */

import type {
  Task,
  TaskDependency,
  TaskId,
  ProjectId,
  RunId,
  RuntimeStore,
} from '@dark-kitchen/core';
import { createRunId } from '@dark-kitchen/core';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { WorkflowAgentError } from '@dark-kitchen/workflow-engine';

import type { RunSupervisor } from './scheduler.js';
import type { InterventionService } from './interventions.js';
import type { PrLifecycleOrchestrator } from './pr-lifecycle.js';
import type { VerificationProof } from './pr-lifecycle.js';

export interface DaemonLoopConfig {
  /** How often to poll the tracker for new/changed tasks (ms). */
  readonly pollIntervalMs: number;
  readonly projectId: ProjectId;
  readonly repositoryId: string;
  readonly sourceBranchPrefix?: string;
  readonly targetBranch?: string;
  readonly requiredChecks?: readonly string[];
  readonly autoMerge?: boolean;
  readonly deleteHeadBranchAfterMerge?: boolean;
}

export interface DaemonDependencies {
  readonly supervisor: RunSupervisor;
  readonly getTaskGraph: () => Promise<{ tasks: Task[]; dependencies: TaskDependency[] }>;
  readonly runWorkflowForTask: (task: Task, runId: RunId) => Promise<WorkflowOutcome>;
  readonly lifecycleOrchestrator: PrLifecycleOrchestrator;
  readonly interventionService: InterventionService;
  /** Cleanup boundary invoked only after merge/no-code completion is fully verified. */
  readonly releaseWorktree?: (taskId: TaskId) => Promise<void>;
  /** Durable store used to reconcile interrupted runs on startup. */
  readonly store?: RuntimeStore;
}

export interface WorkflowOutcome {
  readonly success: boolean;
  readonly summary: string;
  readonly commits: readonly string[];
  readonly sourceBranch: string;
  /** Absolute path of the task worktree the outcome was produced in. */
  readonly worktreePath?: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly worktreeClean?: boolean;
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
  /** Content digests (`sha256:<hex>`) keyed by evidence reference when readable. */
  readonly evidenceAttestations?: Readonly<Record<string, string>>;
  readonly verificationResults?: readonly VerificationProof[];
  readonly requiredVerificationProfiles?: readonly string[];
  readonly noCodeOutcome?: boolean;
  /** Structured failure classification for unsuccessful outcomes. */
  readonly failureKind?: import('@dark-kitchen/core').FailureKind;
  /** Journal file path, deleted once the task completes (enables fresh re-runs). */
  readonly journalPath?: string;
}

/** Deterministic, filesystem-safe run id for a task (enables journal replay). */
export function runIdForTask(taskId: TaskId): string {
  return `run-${taskId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`;
}

/**
 * The main daemon scheduling loop.
 *
 * - Polls `getTaskGraph()` every `pollIntervalMs`
 * - Delegates ready-task selection to `RunSupervisor`
 * - Launches each task's workflow via `runWorkflowForTask`
 * - On success, runs the PR lifecycle via `lifecycleOrchestrator`
 * - On failure, creates an intervention
 */
export class DaemonLoop {
  private readonly config: DaemonLoopConfig;
  private readonly deps: DaemonDependencies;
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly activeTasks = new Map<TaskId, RunId>();

  public constructor(config: DaemonLoopConfig, deps: DaemonDependencies) {
    this.config = config;
    this.deps = deps;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  public stop(): void {
    this.running = false;
    clearInterval(this.timer);
  }

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Reconcile runs persisted by a previous daemon process.
   *
   * Crash-safe recovery semantics:
   * - A run left `running`/`queued`/`starting`/`interrupted` was cut off
   *   mid-execution and is resumed with the task's deterministic run id, so
   *   the durable journal replays completed steps and only the in-flight step
   *   re-executes.
   * - A run left `waiting`/`blocked` is gated on a human decision and is
   *   re-seeded as paused instead of being silently re-scheduled.
   *
   * Returns counts for observability; failures inside a resumed run surface
   * as ordinary interventions rather than aborting reconciliation.
   */
  public async reconcile(): Promise<{
    readonly resumed: number;
    readonly paused: number;
    readonly skipped: number;
  }> {
    if (!this.deps.store) return { resumed: 0, paused: 0, skipped: 0 };

    const runs = await this.deps.store.listRuns();
    const recoverableStates = new Set([
      'queued',
      'starting',
      'running',
      'interrupted',
      'waiting',
      'blocked',
    ]);
    const resumeStates = new Set(['queued', 'starting', 'running', 'interrupted']);

    // A tracker outage must not prevent the daemon from starting. Recovered
    // runs are retried on the next normal tick once the tracker recovers.
    let taskById: Map<TaskId, Task>;
    try {
      const { tasks } = await this.deps.getTaskGraph();
      taskById = new Map(tasks.map((t) => [t.id, t]));
    } catch (err) {
      process.stderr.write(`[DaemonLoop] reconcile graph error: ${String(err)}\n`);
      return { resumed: 0, paused: 0, skipped: 0 };
    }

    let resumed = 0;
    let paused = 0;
    let skipped = 0;
    for (const run of runs) {
      if (!recoverableStates.has(run.state)) continue;
      const task = taskById.get(run.taskId);
      // Task no longer exists or is already done upstream: nothing to resume.
      if (!task || task.status === 'completed' || task.status === 'cancelled') {
        skipped++;
        continue;
      }
      if (resumeStates.has(run.state)) {
        this.deps.supervisor.recoverActive(run.taskId, run.id);
        void this.runTask(task);
        resumed++;
      } else {
        this.deps.supervisor.recoverPaused(run.taskId);
        paused++;
      }
    }
    return { resumed, paused, skipped };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const { tasks, dependencies } = await this.deps.getTaskGraph();
      const newTaskIds = await this.deps.supervisor.tick(tasks, dependencies);

      const taskById = new Map(tasks.map((t) => [t.id, t]));
      for (const taskId of newTaskIds) {
        const task = taskById.get(taskId);
        if (task) void this.runTask(task);
      }
    } catch (err) {
      // Tracker/network error — log and continue on next tick
      process.stderr.write(`[DaemonLoop] tick error: ${String(err)}\n`);
    }
  }

  private async runTask(task: Task): Promise<void> {
    const taskId = task.id;
    // A new execution after a resolved incident must be able to open a fresh
    // intervention. Keep keys stable only within this execution attempt.
    const executionId = randomUUID();
    // Deterministic run id: the same task maps to the same run across daemon
    // restarts, so the SQLite workflow journal can replay completed agent
    // steps instead of re-running them from scratch.
    const runId = createRunId(runIdForTask(taskId));
    this.activeTasks.set(taskId, runId);

    try {
      const outcome = await this.deps.runWorkflowForTask(task, runId);

      if (!outcome.success) {
        await this.deps.interventionService.create({
          scope: 'task',
          targetId: taskId,
          kind: outcome.failureKind ?? 'agent-failure',
          summary: `Workflow failed for task ${taskId}: ${outcome.summary}`,
          deduplicationKey: `workflow-failure:${taskId}:${executionId}`,
        });
        // Pause: don't auto-retry — wait for the human to reply retry/stop.
        this.deps.supervisor.failTask(taskId);
        this.deps.supervisor.pauseTask(taskId);
        return;
      }

      // PR lifecycle
      const lifecycleResult = await this.deps.lifecycleOrchestrator.run(
        {
          taskId,
          summary: outcome.summary,
          repositoryTestsPassed: outcome.repositoryTestsPassed,
          reviewPassed: outcome.reviewPassed,
          ...(outcome.worktreeClean !== undefined ? { worktreeClean: outcome.worktreeClean } : {}),
          commits: outcome.commits,
          ...(outcome.verificationGateSummary
            ? { verificationGateSummary: outcome.verificationGateSummary }
            : {}),
          ...(outcome.evidenceRefs ? { evidenceRefs: outcome.evidenceRefs } : {}),
          ...(outcome.evidenceAttestations
            ? { evidenceAttestations: outcome.evidenceAttestations }
            : {}),
          ...(outcome.verificationResults
            ? { verificationResults: outcome.verificationResults }
            : {}),
          ...(outcome.noCodeOutcome ? { noCodeOutcome: outcome.noCodeOutcome } : {}),
        },
        {
          repositoryId: this.config.repositoryId as never,
          sourceBranch: outcome.sourceBranch,
          targetBranch: this.config.targetBranch ?? 'main',
          autoMerge: this.config.autoMerge ?? false,
          ...(outcome.worktreePath ? { worktreePath: outcome.worktreePath } : {}),
          ...(this.config.requiredChecks ? { requiredChecks: this.config.requiredChecks } : {}),
          ...(this.config.deleteHeadBranchAfterMerge !== undefined
            ? { deleteHeadBranchAfterMerge: this.config.deleteHeadBranchAfterMerge }
            : {}),
          ...(outcome.requiredVerificationProfiles
            ? { requiredVerificationProfiles: outcome.requiredVerificationProfiles }
            : {}),
        },
        this.deps.releaseWorktree,
      );

      if (lifecycleResult.state === 'merged' || lifecycleResult.state === 'no-code-outcome') {
        this.deps.supervisor.completeTask(taskId);
        // The run is done — clear its journal so a future re-open starts fresh
        // instead of replaying stale completed steps.
        if (outcome.journalPath) {
          await rm(outcome.journalPath, { force: true }).catch(() => {});
        }
      } else if (lifecycleResult.state === 'awaiting-approval') {
        // PR is open, waiting for manual merge approval — keep task active
        // A follow-up tick will not re-schedule it (it's still "active")
      } else {
        // checks-failed, merge-refused, tracker-close-failed
        await this.deps.interventionService.create({
          scope: 'task',
          targetId: taskId,
          kind: lifecycleResult.state === 'merge-conflict' ? 'merge-conflict' : 'agent-failure',
          summary: `PR lifecycle failed (${lifecycleResult.state}): ${lifecycleResult.errorMessage ?? 'unknown'}`,
          deduplicationKey: `lifecycle-failure:${taskId}:${executionId}`,
        });
        this.deps.supervisor.failTask(taskId);
        this.deps.supervisor.pauseTask(taskId);
      }
    } catch (err) {
      if (isWorkflowInterventionRequired(err)) {
        // The workflow already created a durable, human-visible gate. Preserve
        // its deterministic run/worktree/journal and wait for Telegram/MCP to
        // resume the task instead of creating a misleading failure incident.
        this.deps.supervisor.failTask(taskId);
        this.deps.supervisor.pauseTask(taskId);
        return;
      }
      await this.deps.interventionService.create({
        scope: 'task',
        targetId: taskId,
        kind:
          err instanceof WorkflowAgentError && err.failureKind !== undefined
            ? err.failureKind
            : 'agent-failure',
        summary: `Unexpected error for task ${taskId}: ${String(err)}`,
        deduplicationKey: `error:${taskId}:${executionId}`,
      });
      this.deps.supervisor.failTask(taskId);
      this.deps.supervisor.pauseTask(taskId);
    } finally {
      this.activeTasks.delete(taskId);
    }
  }
}

function isWorkflowInterventionRequired(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'WorkflowInterventionRequired' && 'outcome' in error
  );
}
