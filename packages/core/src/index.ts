/** A stable identifier for work tracked by a provider. */
export type TaskId = string;

export type TaskStatus = 'backlog' | 'ready' | 'active' | 'blocked' | 'completed';

export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly status: TaskStatus;
}

/** Framework-neutral tracker operations implemented by provider adapters. */
export interface Tracker {
  getTask(taskId: TaskId): Promise<Task>;
  updateTaskStatus(taskId: TaskId, status: TaskStatus): Promise<void>;
}

/** SCM operations are deliberately separate from tracker/work-management operations. */
export interface Scm {
  getRepository(repository: string): Promise<unknown>;
  getPullRequest(repository: string, pullRequestId: string): Promise<unknown>;
}

/** The API composition boundary is intentionally free of a concrete harness or runtime. */
export interface Runtime {
  start(taskId: TaskId): Promise<void>;
  stop(taskId: TaskId): Promise<void>;
}
