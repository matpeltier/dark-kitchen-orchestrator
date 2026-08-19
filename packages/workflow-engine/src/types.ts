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
}

export interface AgentCallOutput {
  readonly role: AgentRole;
  readonly result: unknown;
  readonly callKey: string;
}

/** A harness runner receives an agent call and returns a result. */
export type HarnessRunner = (
  input: AgentCallInput,
  signal: AbortSignal,
) => Promise<unknown>;

/** Resolves a role name to a HarnessRunner. */
export type RoleResolver = (role: AgentRole) => HarnessRunner;

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
