import type {
  Project,
  ProjectId,
  Task,
  TaskId,
  TaskDependency,
  TaskDependencyId,
  TrackerReference,
} from '@dark-kitchen/core';

export type { Task, TaskDependency };

export interface TrackerTaskUpdate {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: Task['status'];
  readonly labels?: readonly string[];
}

export interface AddDependencyInput {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly kind?: TaskDependency['kind'];
}

export interface CreateTaskInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description?: string;
  readonly labels?: readonly string[];
}

export interface CommentInput {
  readonly taskId: TaskId;
  readonly body: string;
}

/**
 * Full tracker adapter contract including dependency management.
 * Extends the core TrackerAdapter with create/comment/dependency operations.
 */
export interface FullTrackerAdapter {
  readonly provider: string;
  getProject(reference: TrackerReference): Promise<Project>;
  getTask(reference: TrackerReference): Promise<Task>;
  getTaskById(taskId: TaskId): Promise<Task | undefined>;
  listTasks(projectId: ProjectId): Promise<readonly Task[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(taskId: TaskId, update: TrackerTaskUpdate): Promise<Task>;
  closeTask(taskId: TaskId): Promise<Task>;
  reopenTask(taskId: TaskId): Promise<Task>;
  addComment(input: CommentInput): Promise<void>;
  addDependency(input: AddDependencyInput): Promise<TaskDependency>;
  removeDependency(dependencyId: TaskDependencyId): Promise<void>;
  listDependencies(taskId: TaskId): Promise<readonly TaskDependency[]>;
}

export class TrackerError extends Error {
  public constructor(
    message: string,
    public readonly trackerCause?: unknown,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

export class CyclicDependencyError extends TrackerError {
  public constructor(taskId: TaskId, dependsOnTaskId: TaskId) {
    super(`Adding dependency ${taskId} -> ${dependsOnTaskId} would create a cycle`);
    this.name = 'CyclicDependencyError';
  }
}

/**
 * Detect if adding a new edge (from → to) would create a cycle.
 * `deps` is the current dependency map: taskId → set of task IDs it depends on.
 */
export function wouldCreateCycle(
  deps: ReadonlyMap<TaskId, ReadonlySet<TaskId>>,
  from: TaskId,
  to: TaskId,
): boolean {
  // If `to` already depends on `from` (directly or transitively), adding from→to would cycle.
  const visited = new Set<TaskId>();
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of deps.get(current) ?? []) {
      stack.push(dep);
    }
  }
  return false;
}
