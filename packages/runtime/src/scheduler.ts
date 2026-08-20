/**
 * Task graph scheduler and autonomous run supervisor.
 *
 * Computes ready tasks from the normalized tracker graph, enforces concurrency
 * limits, and launches durable workflow runs without double-scheduling.
 */

import type { Task, TaskId, TaskDependency, RunId, ProjectId } from '@dark-kitchen/core';
import { validateTaskGraph, createTaskGraphId, DomainValidationError } from '@dark-kitchen/core';

export interface SchedulerConfig {
  readonly maxParallelTasks: number;
  readonly projectId: ProjectId;
}

export interface ScheduledRun {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly startedAt: string;
}

export type RunLauncher = (taskId: TaskId) => Promise<RunId>;

export class CyclicGraphError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CyclicGraphError';
  }
}

/**
 * Determines which tasks are ready to execute given the current task graph and
 * running/completed states. A task is ready when:
 * - It has status 'ready'
 * - All tasks it depends on (via 'blocks' edges) are 'completed'
 * - It is not currently active or blocked
 */
export function computeReadyTasks(
  tasks: readonly Task[],
  dependencies: readonly TaskDependency[],
  activeTasks: ReadonlySet<TaskId>,
): readonly Task[] {
  // Validate graph first (catches cycles)
  try {
    validateTaskGraph({
      id: createTaskGraphId('scheduler-check'),
      projectId: tasks[0]?.projectId ?? ('unknown' as ProjectId),
      taskIds: tasks.map((t) => t.id),
      dependencies,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof DomainValidationError && err.message.includes('cycle')) {
      throw new CyclicGraphError(err.message);
    }
    throw err;
  }

  const completedTaskIds = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));

  // Build "blocked by" map: taskId -> set of taskIds it depends on
  const blockedBy = new Map<TaskId, Set<TaskId>>();
  for (const dep of dependencies) {
    if (dep.kind !== 'blocks') continue;
    if (!blockedBy.has(dep.taskId)) blockedBy.set(dep.taskId, new Set());
    blockedBy.get(dep.taskId)!.add(dep.dependsOnTaskId);
  }

  return tasks.filter((task) => {
    if (task.status !== 'ready') return false;
    if (activeTasks.has(task.id)) return false;
    const blockers = blockedBy.get(task.id) ?? new Set();
    return [...blockers].every((blockerId) => completedTaskIds.has(blockerId));
  });
}

/**
 * Autonomous run supervisor.
 * Polls the tracker, computes ready tasks, and launches runs within concurrency limits.
 */
export class RunSupervisor {
  private readonly config: SchedulerConfig;
  private readonly launcher: RunLauncher;
  private readonly activeRuns = new Map<TaskId, RunId>();
  private readonly completedTasks = new Set<TaskId>();
  private readonly manuallyPaused = new Set<TaskId>();
  private running = false;
  private abortController = new AbortController();

  public constructor(config: SchedulerConfig, launcher: RunLauncher) {
    this.config = config;
    this.launcher = launcher;
  }

  /**
   * Execute one scheduling tick: compute ready tasks and launch up to the
   * concurrency limit. Returns the IDs of newly launched tasks.
   */
  public async tick(
    tasks: readonly Task[],
    dependencies: readonly TaskDependency[],
  ): Promise<readonly TaskId[]> {
    const activeTasks = new Set([...this.activeRuns.keys()]);
    const readyTasks = computeReadyTasks(tasks, dependencies, activeTasks);

    const available = this.config.maxParallelTasks - this.activeRuns.size;
    const toSchedule = readyTasks
      .filter((t) => !this.manuallyPaused.has(t.id))
      .filter((t) => !this.completedTasks.has(t.id))
      .slice(0, Math.max(0, available));

    const launched: TaskId[] = [];
    for (const task of toSchedule) {
      if (this.activeRuns.has(task.id)) continue; // double-schedule guard
      const runId = await this.launcher(task.id);
      this.activeRuns.set(task.id, runId);
      launched.push(task.id);
    }
    return launched;
  }

  /** Mark a task run as completed (removes from active set). */
  public completeTask(taskId: TaskId): void {
    this.activeRuns.delete(taskId);
    this.completedTasks.add(taskId);
  }

  /** Mark a task run as failed (removes from active set, does not complete). */
  public failTask(taskId: TaskId): void {
    this.activeRuns.delete(taskId);
  }

  /** Manually pause a task to prevent scheduling. */
  public pauseTask(taskId: TaskId): void {
    this.manuallyPaused.add(taskId);
  }

  /** Resume a manually paused task. */
  public resumeTask(taskId: TaskId): void {
    this.manuallyPaused.delete(taskId);
  }

  /**
   * Stop a task: pause it AND drop it from the active/completed sets so a later
   * explicit restart is required (pause + retry semantics). The tracker status
   * itself is NOT touched — callers should set the task blocked there too.
   */
  public stopTask(taskId: TaskId): void {
    this.activeRuns.delete(taskId);
    this.completedTasks.delete(taskId);
    this.manuallyPaused.add(taskId);
  }

  /** Retry a completed/failed/paused task: clears all bookkeeping, scheduler will re-run it. */
  public retryTask(taskId: TaskId): void {
    this.activeRuns.delete(taskId);
    this.completedTasks.delete(taskId);
    this.manuallyPaused.delete(taskId);
  }

  public getActiveRuns(): ReadonlyMap<TaskId, RunId> {
    return this.activeRuns;
  }

  public getPausedTasks(): ReadonlySet<TaskId> {
    return this.manuallyPaused;
  }

  public getCompletedTasks(): ReadonlySet<TaskId> {
    return this.completedTasks;
  }

  public getMaxParallelTasks(): number {
    return this.config.maxParallelTasks;
  }

  public isActive(taskId: TaskId): boolean {
    return this.activeRuns.has(taskId);
  }

  /**
   * Re-seed state recovered from the durable store on daemon restart.
   * `active` prevents the scheduler from double-scheduling a task whose
   * workflow is being resumed; `paused` keeps a human-gated task out of the
   * ready set until an explicit retry.
   */
  public recoverActive(taskId: TaskId, runId: RunId): void {
    this.activeRuns.set(taskId, runId);
    this.completedTasks.delete(taskId);
  }

  public recoverPaused(taskId: TaskId): void {
    this.activeRuns.delete(taskId);
    this.completedTasks.delete(taskId);
    this.manuallyPaused.add(taskId);
  }
}
