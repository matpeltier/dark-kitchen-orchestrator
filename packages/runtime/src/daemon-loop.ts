/**
 * Dark Kitchen daemon main loop.
 *
 * Polls the tracker, schedules ready tasks, allocates worktrees, launches
 * durable workflows through acpx, and handles the PR/merge lifecycle.
 * This is the glue layer that connects all the packages together.
 */

import type { Task, TaskDependency, TaskId, ProjectId, RunId } from '@dark-kitchen/core';
import { createRunId } from '@dark-kitchen/core';
import type { RunSupervisor } from './scheduler.js';
import type { InterventionService } from './interventions.js';
import type { PrLifecycleOrchestrator } from './pr-lifecycle.js';

export interface DaemonLoopConfig {
  /** How often to poll the tracker for new/changed tasks (ms). */
  readonly pollIntervalMs: number;
  readonly projectId: ProjectId;
  readonly repositoryId: string;
  readonly sourceBranchPrefix?: string;
  readonly targetBranch?: string;
  readonly requiredChecks?: readonly string[];
  readonly autoMerge?: boolean;
}

export interface DaemonDependencies {
  readonly supervisor: RunSupervisor;
  readonly getTaskGraph: () => Promise<{ tasks: Task[]; dependencies: TaskDependency[] }>;
  readonly runWorkflowForTask: (taskId: TaskId, runId: RunId) => Promise<WorkflowOutcome>;
  readonly lifecycleOrchestrator: PrLifecycleOrchestrator;
  readonly interventionService: InterventionService;
}

export interface WorkflowOutcome {
  readonly success: boolean;
  readonly summary: string;
  readonly commits: readonly string[];
  readonly sourceBranch: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
  readonly noCodeOutcome?: boolean;
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

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const { tasks, dependencies } = await this.deps.getTaskGraph();
      const newTaskIds = await this.deps.supervisor.tick(tasks, dependencies);

      for (const taskId of newTaskIds) {
        void this.runTask(taskId);
      }
    } catch (err) {
      // Tracker/network error — log and continue on next tick
      process.stderr.write(`[DaemonLoop] tick error: ${String(err)}\n`);
    }
  }

  private async runTask(taskId: TaskId): Promise<void> {
    const runId = createRunId(`run-${taskId}-${Date.now()}`);
    this.activeTasks.set(taskId, runId);

    try {
      const outcome = await this.deps.runWorkflowForTask(taskId, runId);

      if (!outcome.success) {
        await this.deps.interventionService.create({
          scope: 'run',
          targetId: runId,
          kind: 'agent-failure',
          summary: `Workflow failed for task ${taskId}: ${outcome.summary}`,
          deduplicationKey: `workflow-failure:${taskId}`,
        });
        this.deps.supervisor.failTask(taskId);
        return;
      }

      // PR lifecycle
      const lifecycleResult = await this.deps.lifecycleOrchestrator.run(
        {
          taskId,
          summary: outcome.summary,
          repositoryTestsPassed: outcome.repositoryTestsPassed,
          reviewPassed: outcome.reviewPassed,
          commits: outcome.commits,
          ...(outcome.verificationGateSummary
            ? { verificationGateSummary: outcome.verificationGateSummary }
            : {}),
          ...(outcome.evidenceRefs ? { evidenceRefs: outcome.evidenceRefs } : {}),
          ...(outcome.noCodeOutcome ? { noCodeOutcome: outcome.noCodeOutcome } : {}),
        },
        {
          repositoryId: this.config.repositoryId as never,
          sourceBranch: outcome.sourceBranch,
          targetBranch: this.config.targetBranch ?? 'main',
          autoMerge: this.config.autoMerge ?? false,
          ...(this.config.requiredChecks ? { requiredChecks: this.config.requiredChecks } : {}),
        },
      );

      if (lifecycleResult.state === 'merged' || lifecycleResult.state === 'no-code-outcome') {
        this.deps.supervisor.completeTask(taskId);
      } else if (lifecycleResult.state === 'awaiting-approval') {
        // PR is open, waiting for manual merge approval — keep task active
        // A follow-up tick will not re-schedule it (it's still "active")
      } else {
        // checks-failed, merge-refused, tracker-close-failed
        await this.deps.interventionService.create({
          scope: 'run',
          targetId: runId,
          kind: 'agent-failure',
          summary: `PR lifecycle failed (${lifecycleResult.state}): ${lifecycleResult.errorMessage ?? 'unknown'}`,
          deduplicationKey: `lifecycle-failure:${taskId}`,
        });
        this.deps.supervisor.failTask(taskId);
      }
    } catch (err) {
      await this.deps.interventionService.create({
        scope: 'run',
        targetId: runId,
        kind: 'agent-failure',
        summary: `Unexpected error for task ${taskId}: ${String(err)}`,
        deduplicationKey: `error:${taskId}`,
      });
      this.deps.supervisor.failTask(taskId);
    } finally {
      this.activeTasks.delete(taskId);
    }
  }
}
