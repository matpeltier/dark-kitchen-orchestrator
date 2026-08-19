import type { AgentSessionId, RunId, TaskId, WorkspaceId } from '@dark-kitchen/core';
import type { HarnessCapabilitySet } from './capabilities.js';

/**
 * Harness profile variants. Managed profiles are owned and configured by
 * Dark Kitchen; user-managed profiles delegate to the user's existing harness
 * without touching its local configuration.
 */
export interface ManagedHarnessProfile {
  readonly managed: true;
  readonly id: string;
  readonly kind: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly instructions?: string;
  readonly skills?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly plugins?: readonly string[];
}

export interface UserManagedHarnessProfile {
  readonly managed: false;
  readonly id: string;
  readonly kind: string;
  /** Human-readable description only; no DK-managed config. */
  readonly description?: string;
}

export type HarnessProfile = ManagedHarnessProfile | UserManagedHarnessProfile;

/**
 * A resolved role maps a semantic role name to a harness profile + optional overrides.
 * Overrides are only permitted for managed profiles.
 */
export interface ResolvedRole {
  readonly roleId: string;
  readonly profile: HarnessProfile;
  readonly modelOverride?: string;
  readonly reasoningOverride?: string;
  readonly instructionsOverride?: string;
}

/**
 * Lifecycle event emitted by a harness session.
 */
export type HarnessSessionState =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface HarnessSessionEvent {
  readonly sessionId: string;
  readonly state: HarnessSessionState;
  readonly output?: string;
  readonly error?: unknown;
}

export type HarnessEventHandler = (event: HarnessSessionEvent) => void;

/**
 * Input for starting a harness session.
 */
export interface StartSessionInput {
  readonly runId: RunId;
  readonly taskId: TaskId;
  /** Path to the task's git worktree. Used as cwd for the agent. */
  readonly workspaceId: WorkspaceId;
  readonly profile: HarnessProfile;
  /** Initial prompt to send when the session starts. */
  readonly prompt: string;
  readonly model?: string;
  readonly reasoning?: string;
  /** System-level instructions injected at session creation time. */
  readonly instructions?: string;
}

/**
 * A live harness session.
 */
export interface HarnessSession {
  readonly id: AgentSessionId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly profile: HarnessProfile;
  state: HarnessSessionState;
  externalSessionId?: string;
}

/**
 * The full harness runtime contract.
 * All implementations must declare their capabilities.
 */
export interface HarnessRuntime {
  readonly id: string;
  readonly capabilities: HarnessCapabilitySet;

  startSession(input: StartSessionInput): Promise<HarnessSession>;
  sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void>;
  cancelSession(sessionId: AgentSessionId): Promise<void>;
  resumeSession(sessionId: AgentSessionId): Promise<HarnessSession>;
  stopSession(sessionId: AgentSessionId): Promise<void>;
  getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined>;
  subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void;
}
