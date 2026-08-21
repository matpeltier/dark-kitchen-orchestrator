/**
 * Quota-aware failover wrapper around HarnessRuntime instances.
 *
 * Wraps the runtime chain resolved for a single role:
 * [primary profile/model, ...primary fallbackModels, ...role fallback profiles].
 * When a session start or an agent turn fails with a quota-classified error,
 * the wrapper notifies its owner, restarts the turn on the next candidate
 * (the persistent session is recreated with the new profile/model), and only
 * surfaces the quota error once every fallback is exhausted.
 */

import { randomUUID } from 'node:crypto';
import type { AgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessProfile,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import { AcpClassifiedError, classifyAcpError } from './acp-runtime-adapter.js';

export interface FailoverCandidate {
  readonly profile: HarnessProfile;
  readonly model?: string;
  readonly runtime: HarnessRuntime;
}

export interface FailoverSwitchEvent {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromProfileId: string;
  readonly toProfileId: string;
  readonly fromModel?: string;
  readonly toModel?: string;
  readonly reason: string;
}

export interface FailoverHarnessRuntimeOptions {
  readonly id?: string;
  readonly kind?: string;
  /** Ordered chain; index 0 is the primary, the rest are fallbacks. */
  readonly candidates: readonly FailoverCandidate[];
  /** Notification hook (daemon logging) invoked before each switch attempt. */
  readonly onSwitch?: (event: FailoverSwitchEvent) => void;
}

interface FailoverState {
  readonly publicId: AgentSessionId;
  input: StartSessionInput;
  candidateIndex: number;
  session: HarnessSession;
  lastPrompt: string;
  switching: boolean;
  unsubscribe: () => void;
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof AcpClassifiedError) return error.kind === 'quota';
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  return classifyAcpError(message).kind === 'quota';
}

/**
 * Wraps per-role runtimes and transparently switches to the next candidate
 * on quota exhaustion. All other errors are propagated unchanged.
 */
export class FailoverHarnessRuntime implements HarnessRuntime {
  public readonly id: string;
  public readonly kind: string;
  public readonly capabilities: HarnessRuntime['capabilities'];

  private readonly candidates: readonly FailoverCandidate[];
  private readonly onSwitch?: (event: FailoverSwitchEvent) => void;
  private readonly states = new Map<AgentSessionId, FailoverState>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly lastEvents = new Map<AgentSessionId, Parameters<HarnessEventHandler>[0]>();

  public constructor(options: FailoverHarnessRuntimeOptions) {
    if (options.candidates.length === 0) {
      throw new Error('FailoverHarnessRuntime requires at least one candidate');
    }
    this.candidates = options.candidates;
    if (options.onSwitch) this.onSwitch = options.onSwitch;
    this.id = options.id ?? `failover:${options.candidates[0]!.runtime.id}`;
    this.kind = options.kind ?? options.candidates[0]!.runtime.kind;
    this.capabilities = options.candidates[0]!.runtime.capabilities;
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    let lastError: unknown;
    for (let i = 0; i < this.candidates.length; i++) {
      try {
        const session = await this.startOn(i, input);
        return session;
      } catch (error) {
        lastError = error;
        if (!isQuotaError(error) || i === this.candidates.length - 1) throw error;
        this.notifySwitch(i, i + 1, 'quota exhausted');
      }
    }
    throw lastError;
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    const state = this.getState(sessionId);
    state.lastPrompt = prompt;
    const candidate = this.candidates[state.candidateIndex]!;
    try {
      await candidate.runtime.sendPrompt(state.session.id, prompt);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      await this.failoverFrom(state.candidateIndex, state, error);
    }
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    const state = this.getState(sessionId);
    await this.candidates[state.candidateIndex]!.runtime.cancelSession(state.session.id);
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    const state = this.getState(sessionId);
    const candidate = this.candidates[state.candidateIndex]!;
    const session = await candidate.runtime.resumeSession(state.session.id);
    state.session = session;
    return this.snapshot(state);
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const state = this.getState(sessionId);
    await this.candidates[state.candidateIndex]!.runtime.stopSession(state.session.id);
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    const session = await this.candidates[state.candidateIndex]!.runtime.getSession(
      state.session.id,
    );
    return session ? this.snapshot(state, session.state) : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    this.getState(sessionId);
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
    const lastEvent = this.lastEvents.get(sessionId);
    if (lastEvent && isTerminalState(lastEvent.state)) {
      queueMicrotask(() => {
        if (this.lastEvents.get(sessionId) === lastEvent) handler(lastEvent);
      });
    }
    return () => {
      this.subscribers.get(sessionId)?.delete(handler);
    };
  }

  public checkpointSession(sessionId: AgentSessionId): unknown {
    const state = this.getState(sessionId);
    const candidate = this.candidates[state.candidateIndex]!;
    return candidate.runtime.checkpointSession?.(state.session.id);
  }

  public async restoreSession(checkpoint: unknown): Promise<HarnessSession> {
    let lastError: unknown;
    for (let i = 0; i < this.candidates.length; i++) {
      const candidate = this.candidates[i]!;
      if (!candidate.runtime.restoreSession) continue;
      try {
        const session = await candidate.runtime.restoreSession(checkpoint);
        const publicId = createAgentSessionId();
        const state: FailoverState = {
          publicId,
          input: {
            runId: session.runId,
            taskId: session.taskId,
            workspaceId: session.workspaceId,
            profile: candidate.profile,
            prompt: '',
          },
          candidateIndex: i,
          session,
          lastPrompt: '',
          switching: false,
          unsubscribe: () => {},
        };
        state.unsubscribe = this.watch(state);
        this.states.set(publicId, state);
        this.emit(publicId, { sessionId: publicId, state: session.state });
        return this.snapshot(state);
      } catch (error) {
        lastError = error;
        if (!isQuotaError(error)) throw error;
      }
    }
    throw lastError ?? new Error('FailoverHarnessRuntime: no candidate supports restoreSession');
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async startOn(
    index: number,
    input: StartSessionInput,
    reusePublicId?: AgentSessionId,
  ): Promise<HarnessSession> {
    const candidate = this.candidates[index]!;
    const sessionInput: StartSessionInput = {
      ...input,
      profile: candidate.profile,
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
    };
    const session = await candidate.runtime.startSession(sessionInput);
    const publicId = reusePublicId ?? createAgentSessionId();
    const state: FailoverState = {
      publicId,
      // Keep the pristine role-level input so later candidates apply their
      // own profile/model instead of inheriting this candidate's.
      input,
      candidateIndex: index,
      session,
      lastPrompt: input.prompt,
      switching: false,
      unsubscribe: () => {},
    };
    state.unsubscribe = this.watch(state);
    this.states.set(publicId, state);
    return this.snapshot(state);
  }

  /** Watch the active underlying session for asynchronous quota failures. */
  private watch(state: FailoverState): () => void {
    const candidate = this.candidates[state.candidateIndex]!;
    return candidate.runtime.subscribe(state.session.id, (event) => {
      if (event.state === 'failed' && isQuotaError(event.error)) {
        void this.failoverFrom(state.candidateIndex, state, event.error).catch(() => {});
        return;
      }
      this.emit(state.publicId, { ...event, sessionId: state.publicId });
    });
  }

  /**
   * Advance past `fromIndex`, restarting the pending turn on each subsequent
   * candidate until one accepts it. Emits the quota failure publicly when the
   * chain is exhausted.
   */
  private async failoverFrom(
    fromIndex: number,
    state: FailoverState,
    cause: unknown,
  ): Promise<void> {
    if (state.switching) return;
    state.switching = true;
    try {
      for (let i = fromIndex + 1; i < this.candidates.length; i++) {
        this.notifySwitch(fromIndex, i, 'quota exhausted');
        try {
          const previous = state.session;
          state.unsubscribe();
          const session = await this.startOn(i, state.input, state.publicId);
          // The failed persistent session is no longer needed; stop it quietly.
          void this.candidates[state.candidateIndex]!.runtime.stopSession(previous.id).catch(
            () => undefined,
          );
          state.candidateIndex = i;
          state.session = session;
          this.emit(state.publicId, { sessionId: state.publicId, state: 'running' });
          return;
        } catch (error) {
          if (!isQuotaError(error)) throw error;
        }
      }
      const quotaError =
        cause instanceof Error ? cause : new Error(String(cause ?? 'quota exhausted'));
      this.emit(state.publicId, {
        sessionId: state.publicId,
        state: 'failed',
        error: quotaError,
      });
    } finally {
      state.switching = false;
    }
  }

  private notifySwitch(fromIndex: number, toIndex: number, reason: string): void {
    const from = this.candidates[fromIndex]!;
    const to = this.candidates[toIndex]!;
    this.onSwitch?.({
      fromIndex,
      toIndex,
      fromProfileId: from.profile.id,
      toProfileId: to.profile.id,
      ...(from.model !== undefined ? { fromModel: from.model } : {}),
      ...(to.model !== undefined ? { toModel: to.model } : {}),
      reason,
    });
  }

  private snapshot(state: FailoverState, overrideState?: HarnessSession['state']): HarnessSession {
    return {
      id: state.publicId,
      runId: state.session.runId,
      taskId: state.session.taskId,
      workspaceId: state.session.workspaceId,
      profile: this.candidates[state.candidateIndex]!.profile,
      state: overrideState ?? state.session.state,
      ...(state.session.externalSessionId !== undefined
        ? { externalSessionId: state.session.externalSessionId }
        : {}),
    };
  }

  private getState(sessionId: AgentSessionId): FailoverState {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`FailoverHarnessRuntime: session ${sessionId} not found`);
    return state;
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    this.lastEvents.set(sessionId, event);
    for (const handler of this.subscribers.get(sessionId) ?? []) handler(event);
  }
}

function isTerminalState(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function createAgentSessionId(): AgentSessionId {
  return `agent-${randomUUID()}` as AgentSessionId;
}
