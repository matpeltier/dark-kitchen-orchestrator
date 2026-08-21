/**
 * Core types for the Dark Kitchen workflow engine.
 *
 * Adapted from concepts in six-ddc/codex-dynamic-workflows (MIT License).
 * Original: https://github.com/six-ddc/codex-dynamic-workflows
 * Changes: removed provider enums and OpenAI/Codex SDK dependencies;
 * replaced with generic HarnessRunner/role routing contract.
 */

export type WorkflowStepResult = unknown;

/** Semantic role for an agent call. Harness/model selection is resolved at the router layer. */
export type AgentRole = string;

export interface AgentCallInput {
  readonly role: AgentRole;
  readonly prompt: string;
  readonly context?: Record<string, unknown>;
  /** Filesystem path where the agent should run (the task's worktree). */
  readonly workspacePath?: string;
  /** Run identifier for the task (used to key persistent agent sessions). */
  readonly runId?: string;
  /** Task identifier (used to key persistent agent sessions per task). */
  readonly taskId?: string;
  /** Stable engine identity for this call (used to persist session checkpoints). */
  readonly callKey?: string;
  /** Session checkpoint from an interrupted previous attempt, if any. */
  readonly resumeCheckpoint?: unknown;
  /** Report a restart-safe session checkpoint once the session exists. */
  readonly onCheckpoint?: (checkpoint: unknown) => void | Promise<void>;
}

export interface AgentCallOutput {
  readonly role: AgentRole;
  readonly result: unknown;
  readonly callKey: string;
}

/** A harness runner receives an agent call and returns a result. */
export type HarnessRunner = (input: AgentCallInput, signal: AbortSignal) => Promise<unknown>;

/**
 * Resolves a semantic role to a harness runner.
 *
 * Resolution may be asynchronous because native/custom harness plugins can be
 * loaded lazily. The engine still treats the resolved runner as opaque: no
 * harness or model identifier enters the workflow API.
 */
export type RoleResolver = (role: AgentRole) => HarnessRunner | PromiseLike<HarnessRunner>;

export interface WorkflowContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly journal: JournalStore;
  readonly resolver: RoleResolver;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEventKind =
  | 'step.start'
  | 'step.complete'
  | 'step.retry'
  | 'step.error'
  | 'workflow.start'
  | 'workflow.complete'
  | 'workflow.cancel';

export interface ProgressEvent {
  readonly kind: ProgressEventKind;
  readonly callKey: string;
  readonly role?: AgentRole;
  readonly attempt?: number;
  readonly error?: unknown;
}

/** Durable journal for replaying completed workflow steps. */
export interface JournalStore {
  get(callKey: string): Promise<WorkflowStepResult | undefined>;
  set(callKey: string, result: WorkflowStepResult): Promise<void>;
  /**
   * Optional presence probe used to distinguish a cached `undefined` result
   * from an absent entry. Existing durable journals can omit it.
   */
  has?(callKey: string): boolean | Promise<boolean>;
  /**
   * Optional in-flight tracking for crash recovery. A checkpoint recorded
   * before the harness turn completes is offered back to the resolver on the
   * next attempt so a persistent session can be reattached mid-run.
   */
  markInFlight?(callKey: string, checkpoint: unknown): Promise<void>;
  getInFlight?(callKey: string): Promise<unknown | undefined>;
  clearInFlight?(callKey: string): Promise<void>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs?: number;
}

export interface AgentStepOptions {
  /** Semantic role required. No fallback to label or arrival order. */
  readonly role: AgentRole;
  readonly prompt: string;
  readonly context?: Record<string, unknown>;
  readonly retryPolicy?: RetryPolicy;
}

export interface WorkflowStepOptions {
  readonly retryPolicy?: RetryPolicy;
}

export interface ParallelOptions {
  readonly concurrency?: number;
}

// Unique symbol used internally to mark cancelled sentinel results
export const CANCELLED = Symbol('WORKFLOW_CANCELLED');
export type Cancelled = typeof CANCELLED;
