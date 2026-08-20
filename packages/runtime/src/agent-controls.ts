/**
 * Durable, capability-negotiated agent and run controls.
 *
 * Controls never inspect terminals and never guess a runtime from session
 * state. The daemon registers each session's exact runtime/profile binding at
 * launch; restart, retry and switch operations create a distinct session while
 * preserving run, task, execution-node and workspace identity.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentSession,
  AgentSessionId,
  AgentSessionRuntimeBinding,
  AgentSessionRuntimeBindingStore,
  Run,
  RunId,
  RuntimeStore,
} from '@dark-kitchen/core';
import { createAgentSessionId, createEventId } from '@dark-kitchen/core';
import type { HarnessProfile, HarnessRuntime } from '@dark-kitchen/harness';
import { UnsupportedCapabilityError, toAgentSessionState } from '@dark-kitchen/harness';

export interface AgentControlRequestOptions {
  /** Stable caller-generated key used to make a retried request idempotent. */
  readonly requestId?: string;
}

export interface RegisterAgentSessionInput {
  readonly session: AgentSession;
  readonly runtime: HarnessRuntime;
  readonly profile: HarnessProfile;
  readonly initialPrompt: string;
  readonly roleId?: string;
  readonly model?: string;
  readonly reasoning?: string;
}

export interface AgentInspection {
  readonly session: AgentSession;
  readonly roleId?: string;
  readonly harness?: {
    readonly runtimeId: string;
    readonly kind: string;
    readonly profileId: string;
    readonly model?: string;
    readonly reasoning?: string;
  };
  readonly lastActivityAt: string;
  readonly error?: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly controls: {
    readonly sendInstruction: boolean;
    readonly interruptAndSend: boolean;
    readonly stop: boolean;
    readonly restart: boolean;
    readonly retry: boolean;
    readonly switchProfile: boolean;
  };
}

export interface AgentControlService {
  registerSession(input: RegisterAgentSessionInput): Promise<void>;
  listSessions(runId?: RunId): Promise<readonly AgentSession[]>;
  getSession(sessionId: AgentSessionId): Promise<AgentSession | undefined>;
  listAgents(runId?: string): Promise<readonly AgentInspection[]>;
  getAgent(sessionId: string): Promise<AgentInspection | undefined>;
  sendInstruction(
    sessionId: AgentSessionId,
    instruction: string,
    options?: AgentControlRequestOptions,
  ): Promise<void>;
  interruptAndSend(
    sessionId: AgentSessionId,
    instruction: string,
    options?: AgentControlRequestOptions,
  ): Promise<void>;
  stopSession(sessionId: AgentSessionId, options?: AgentControlRequestOptions): Promise<void>;
  restartSession(
    sessionId: AgentSessionId,
    options?: AgentControlRequestOptions,
  ): Promise<AgentSession>;
  retrySession(
    sessionId: AgentSessionId,
    options?: AgentControlRequestOptions,
  ): Promise<AgentSession>;
  restartAgent(sessionId: string): Promise<AgentSession>;
  retryAgent(sessionId: string): Promise<AgentSession>;
  switchAgentProfile(sessionId: string, harnessProfileId: string): Promise<AgentSession>;
  pauseRun(runId: string): Promise<Run>;
  resumeRun(runId: string): Promise<Run>;
  retryRun(runId: string): Promise<AgentSession>;
}

export interface ResolvedControlTarget {
  readonly runtime: HarnessRuntime;
  readonly profile: HarnessProfile;
  readonly model?: string;
  readonly reasoning?: string;
}

export interface DefaultAgentControlServiceOptions {
  readonly store: RuntimeStore & AgentSessionRuntimeBindingStore;
  /** Must resolve the exact runtime instance id; kind is diagnostic context. */
  readonly resolveRuntime: (runtimeId: string, runtimeKind: string) => HarnessRuntime | undefined;
  /** Required only for switch-profile controls. */
  readonly resolveProfile?: (
    profileId: string,
  ) => ResolvedControlTarget | undefined | Promise<ResolvedControlTarget | undefined>;
  readonly now?: () => string;
  readonly requestId?: () => string;
  readonly reportRuntimeFailure?: (failure: {
    readonly kind: 'auth' | 'quota' | 'rate-limit' | 'stuck-agent' | 'agent-failure';
    readonly sessionId: AgentSessionId;
    readonly runId: RunId;
    readonly summary: string;
  }) => void | Promise<void>;
}

export class AgentControlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentControlError';
  }
}

type ReplacementAction = 'restart' | 'retry' | 'switch-profile';
type AuditAction =
  | 'send-instruction'
  | 'interrupt-and-send'
  | 'stop'
  | ReplacementAction
  | 'pause-run'
  | 'resume-run'
  | 'retry-run';

export class DefaultAgentControlService implements AgentControlService {
  private readonly store: RuntimeStore & AgentSessionRuntimeBindingStore;
  private readonly resolveRuntime: DefaultAgentControlServiceOptions['resolveRuntime'];
  private readonly resolveProfile?: DefaultAgentControlServiceOptions['resolveProfile'];
  private readonly now: () => string;
  private readonly createRequestId: () => string;
  private readonly reportRuntimeFailure?: DefaultAgentControlServiceOptions['reportRuntimeFailure'];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly suppressedCancellationEvents = new Set<AgentSessionId>();
  private readonly controlLog: Array<{ sessionId: string; action: string; at: string }> = [];

  public constructor(options: DefaultAgentControlServiceOptions);
  /** @deprecated Register durable bindings and use the options constructor. */
  public constructor(store: RuntimeStore, getRuntime: (kind: string) => HarnessRuntime | undefined);
  public constructor(
    optionsOrStore: DefaultAgentControlServiceOptions | RuntimeStore,
    legacyGetRuntime?: (kind: string) => HarnessRuntime | undefined,
  ) {
    if ('store' in optionsOrStore && 'resolveRuntime' in optionsOrStore) {
      this.store = optionsOrStore.store;
      this.resolveRuntime = optionsOrStore.resolveRuntime;
      this.resolveProfile = optionsOrStore.resolveProfile;
      this.now = optionsOrStore.now ?? (() => new Date().toISOString());
      this.createRequestId = optionsOrStore.requestId ?? randomUUID;
      this.reportRuntimeFailure = optionsOrStore.reportRuntimeFailure;
      return;
    }
    this.store = optionsOrStore as RuntimeStore & AgentSessionRuntimeBindingStore;
    this.resolveRuntime = (_runtimeId, runtimeKind) => legacyGetRuntime?.(runtimeKind);
    this.now = () => new Date().toISOString();
    this.createRequestId = randomUUID;
  }

  public async registerSession(input: RegisterAgentSessionInput): Promise<void> {
    if (input.session.id.trim().length === 0 || input.initialPrompt.trim().length === 0) {
      throw new AgentControlError('A session binding requires a session id and initial prompt');
    }
    const now = this.now();
    await this.store.saveAgentSession(input.session);
    await this.store.saveAgentSessionRuntimeBinding({
      sessionId: input.session.id,
      runtimeId: input.runtime.id,
      runtimeKind: input.runtime.kind,
      profileId: input.profile.id,
      profileSnapshot: { ...input.profile },
      initialPrompt: redactSensitivePrompt(input.initialPrompt),
      ...(input.roleId ? { roleId: input.roleId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      lastActivityAt: now,
      createdAt: input.session.createdAt,
      updatedAt: now,
    });
    this.subscribeToLifecycle(input.runtime, input.session.id);
  }

  public async listSessions(runId?: RunId): Promise<readonly AgentSession[]> {
    const sessions = await this.store.listAgentSessions();
    return runId ? sessions.filter((session) => session.runId === runId) : sessions;
  }

  public async getSession(sessionId: AgentSessionId): Promise<AgentSession | undefined> {
    return this.store.getAgentSession(sessionId);
  }

  public async listAgents(runId?: string): Promise<readonly AgentInspection[]> {
    const sessions = await this.listSessions(runId as RunId | undefined);
    return Promise.all(sessions.map((session) => this.inspect(session)));
  }

  public async getAgent(sessionId: string): Promise<AgentInspection | undefined> {
    const session = await this.store.getAgentSession(createAgentSessionId(sessionId));
    return session ? this.inspect(session) : undefined;
  }

  public async sendInstruction(
    sessionId: AgentSessionId,
    instruction: string,
    options: AgentControlRequestOptions = {},
  ): Promise<void> {
    const prompt = requireInstruction(instruction);
    const key = options.requestId ?? `${sessionId}:send:${prompt}`;
    await this.once(key, async () => {
      const session = await this.requireActiveSession(sessionId);
      const { binding, runtime } = await this.requireBoundRuntime(sessionId);
      this.requireCapability(runtime, 'sessions.live-instructions');
      await runtime.sendPrompt(sessionId, prompt);
      await this.touchBinding(binding);
      await this.audit('send-instruction', session, binding, options.requestId);
      this.log(sessionId, `sendInstruction: "${prompt.slice(0, 80)}"`);
    });
  }

  public async interruptAndSend(
    sessionId: AgentSessionId,
    instruction: string,
    options: AgentControlRequestOptions = {},
  ): Promise<void> {
    const prompt = requireInstruction(instruction);
    const key = options.requestId ?? `${sessionId}:interrupt:${prompt}`;
    await this.once(key, async () => {
      const session = await this.requireActiveSession(sessionId);
      const { binding, runtime } = await this.requireBoundRuntime(sessionId);
      this.requireCapability(runtime, 'sessions.cancel');
      this.requireCapability(runtime, 'sessions.resume');
      this.requireCapability(runtime, 'sessions.live-instructions');
      this.suppressedCancellationEvents.add(sessionId);
      try {
        await runtime.cancelSession(sessionId);
      } catch (error) {
        this.suppressedCancellationEvents.delete(sessionId);
        throw error;
      }
      await runtime.resumeSession(sessionId);
      await runtime.sendPrompt(sessionId, prompt);
      await this.saveSessionState(session, 'running');
      await this.touchBinding(binding);
      await this.audit('interrupt-and-send', session, binding, options.requestId);
      this.log(sessionId, `interruptAndSend: "${prompt.slice(0, 80)}"`);
    });
  }

  public async stopSession(
    sessionId: AgentSessionId,
    options: AgentControlRequestOptions = {},
  ): Promise<void> {
    const key = options.requestId ?? `${sessionId}:stop`;
    await this.once(key, async () => {
      const session = await this.requireSession(sessionId);
      if (isTerminal(session.state)) return;
      const { binding, runtime } = await this.requireBoundRuntime(sessionId);
      // The harness contract has no implicit terminal semantics. A runtime that
      // cannot cancel must reject stop rather than pretending the process ended.
      this.requireCapability(runtime, 'sessions.cancel');
      await runtime.stopSession(sessionId);
      await this.saveSessionState(session, 'stopped');
      await this.touchBinding(binding);
      await this.audit('stop', session, binding, options.requestId);
      this.log(sessionId, 'stop');
    });
  }

  public async restartSession(
    sessionId: AgentSessionId,
    options: AgentControlRequestOptions = {},
  ): Promise<AgentSession> {
    return this.startReplacement(sessionId, 'restart', options);
  }

  public async retrySession(
    sessionId: AgentSessionId,
    options: AgentControlRequestOptions = {},
  ): Promise<AgentSession> {
    return this.startReplacement(sessionId, 'retry', options);
  }

  public async restartAgent(sessionId: string): Promise<AgentSession> {
    return this.restartSession(createAgentSessionId(sessionId));
  }

  public async retryAgent(sessionId: string): Promise<AgentSession> {
    return this.retrySession(createAgentSessionId(sessionId));
  }

  public async switchAgentProfile(
    sessionId: string,
    harnessProfileId: string,
  ): Promise<AgentSession> {
    const profileId = harnessProfileId.trim();
    if (!profileId) throw new AgentControlError('Harness profile id must not be empty');
    if (!this.resolveProfile) {
      throw new AgentControlError('Profile switching is not configured; no session was created');
    }
    const target = await this.resolveProfile(profileId);
    if (!target || target.profile.id !== profileId) {
      throw new AgentControlError(`Harness profile "${profileId}" is unavailable`);
    }
    if (target.runtime.kind !== target.profile.kind) {
      throw new AgentControlError(
        `Harness profile "${profileId}" cannot run on runtime kind "${target.runtime.kind}"`,
      );
    }
    return this.startReplacement(createAgentSessionId(sessionId), 'switch-profile', {}, target);
  }

  public async pauseRun(runId: string): Promise<Run> {
    const stableRunId = runId as RunId;
    return this.once(`${runId}:pause-run`, async () => {
      const run = await this.requireRun(stableRunId);
      if (run.state === 'waiting') return run;
      if (isTerminal(run.state)) throw new AgentControlError(`Run ${runId} is already terminal`);
      const active = (await this.listSessions(stableRunId)).filter((session) =>
        isActive(session.state),
      );
      const bound = await Promise.all(
        active.map(async (session) => ({
          session,
          ...(await this.requireBoundRuntime(session.id)),
        })),
      );
      for (const item of bound) {
        this.requireCapability(item.runtime, 'sessions.cancel');
        this.requireCapability(item.runtime, 'sessions.resume');
      }
      for (const item of bound) {
        this.suppressedCancellationEvents.add(item.session.id);
        try {
          await item.runtime.cancelSession(item.session.id);
        } catch (error) {
          this.suppressedCancellationEvents.delete(item.session.id);
          throw error;
        }
        await this.saveSessionState(item.session, 'waiting');
      }
      const updated = await this.saveRunState(run, 'waiting');
      await this.audit('pause-run', undefined, undefined, undefined, updated.id);
      return updated;
    });
  }

  public async resumeRun(runId: string): Promise<Run> {
    const stableRunId = runId as RunId;
    return this.once(`${runId}:resume-run`, async () => {
      const run = await this.requireRun(stableRunId);
      if (run.state === 'running') return run;
      if (run.state !== 'waiting' && run.state !== 'blocked') {
        throw new AgentControlError(`Run ${runId} cannot resume from state "${run.state}"`);
      }
      const waiting = (await this.listSessions(stableRunId)).filter(
        (session) => session.state === 'waiting' || session.state === 'blocked',
      );
      const bound = await Promise.all(
        waiting.map(async (session) => ({
          session,
          ...(await this.requireBoundRuntime(session.id)),
        })),
      );
      for (const item of bound) this.requireCapability(item.runtime, 'sessions.resume');
      for (const item of bound) {
        await item.runtime.resumeSession(item.session.id);
        await this.saveSessionState(item.session, 'running');
      }
      const updated = await this.saveRunState(run, 'running');
      await this.audit('resume-run', undefined, undefined, undefined, updated.id);
      return updated;
    });
  }

  public async retryRun(runId: string): Promise<AgentSession> {
    const stableRunId = runId as RunId;
    return this.once(`${runId}:retry-run`, async () => {
      const run = await this.requireRun(stableRunId);
      const sessions = await this.listSessions(stableRunId);
      const active = sessions.find((session) => isActive(session.state));
      if (active) return active;
      const latest = sessions.at(-1);
      if (!latest) throw new AgentControlError(`Run ${runId} has no agent session to retry`);
      const replacement = await this.startReplacement(latest.id, 'retry', {
        requestId: `retry-run:${runId}:${latest.id}`,
      });
      const { completedAt: _completedAt, ...withoutCompletion } = run;
      await this.store.saveRun({ ...withoutCompletion, state: 'running', updatedAt: this.now() });
      const binding = await this.store.getAgentSessionRuntimeBinding(replacement.id);
      await this.audit('retry-run', latest, binding, undefined, run.id, replacement.id);
      return replacement;
    });
  }

  public getControlLog(): ReadonlyArray<{ sessionId: string; action: string; at: string }> {
    return this.controlLog;
  }

  private async startReplacement(
    sessionId: AgentSessionId,
    action: ReplacementAction,
    options: AgentControlRequestOptions,
    target?: ResolvedControlTarget,
  ): Promise<AgentSession> {
    const requestKey =
      options.requestId ?? `${sessionId}:${action}:${target?.profile.id ?? 'same'}`;
    return this.once(requestKey, async () => {
      const source = await this.requireSession(sessionId);
      if (!isTerminal(source.state)) {
        throw new AgentControlError(
          `Cannot ${action} session ${sessionId} in state "${source.state}"; stop it first`,
        );
      }
      const sourceBinding = await this.requireBinding(sessionId);
      const existing = await this.findExistingReplacement(
        source,
        action,
        target?.profile.id ?? sourceBinding.profileId,
        options.requestId,
      );
      if (existing) return existing;

      const runtime = target?.runtime ?? this.requireExactRuntime(sourceBinding);
      const profile = target?.profile ?? requireHarnessProfile(sourceBinding.profileSnapshot);
      const model = target?.model ?? sourceBinding.model;
      const reasoning = target?.reasoning ?? sourceBinding.reasoning;
      const started = await runtime.startSession({
        runId: source.runId,
        taskId: source.taskId,
        workspaceId: source.workspaceId,
        profile,
        prompt: sourceBinding.initialPrompt,
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
      });
      if (started.id === source.id) {
        await runtime.stopSession(started.id).catch(() => undefined);
        throw new AgentControlError('Harness reused the old session id; restart was aborted');
      }

      const now = this.now();
      const replacement: AgentSession = {
        id: started.id,
        runId: source.runId,
        taskId: source.taskId,
        executionNodeId: source.executionNodeId,
        workspaceId: source.workspaceId,
        state: toAgentSessionState(started.state),
        createdAt: now,
        updatedAt: now,
        ...(isTerminal(toAgentSessionState(started.state)) ? { completedAt: now } : {}),
      };
      const binding: AgentSessionRuntimeBinding = {
        sessionId: replacement.id,
        runtimeId: runtime.id,
        runtimeKind: runtime.kind,
        profileId: profile.id,
        profileSnapshot: { ...profile },
        initialPrompt: sourceBinding.initialPrompt,
        ...(sourceBinding.roleId ? { roleId: sourceBinding.roleId } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
        lastActivityAt: now,
        sourceSessionId: source.id,
        sourceAction: action,
        ...(options.requestId ? { controlRequestId: options.requestId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      try {
        // The SQLite implementation enforces one replacement for a given
        // source/action/profile. This closes the race across daemon instances;
        // the losing external session is stopped and never gets a record.
        await this.store.saveAgentSessionRuntimeBinding(binding);
      } catch (error) {
        await runtime.stopSession(replacement.id).catch(() => undefined);
        const winner = await this.findExistingReplacement(
          source,
          action,
          profile.id,
          options.requestId,
        );
        if (winner) return winner;
        throw error;
      }
      await this.store.saveAgentSession(replacement);
      const node = await this.store.getExecutionNode(source.executionNodeId);
      if (node) {
        await this.store.saveExecutionNode({
          ...node,
          agentSessionId: replacement.id,
          state: replacement.state,
          updatedAt: now,
        });
      }
      const run = await this.store.getRun(source.runId);
      if (run && run.state !== 'running') {
        const { completedAt: _completedAt, ...withoutCompletion } = run;
        await this.store.saveRun({ ...withoutCompletion, state: 'running', updatedAt: now });
      }
      this.subscribeToLifecycle(runtime, replacement.id);
      await this.audit(action, source, binding, options.requestId, source.runId, replacement.id);
      this.log(source.id, `${action} -> ${replacement.id}`);
      return replacement;
    });
  }

  private async findExistingReplacement(
    source: AgentSession,
    action: ReplacementAction,
    profileId: string,
    requestId?: string,
  ): Promise<AgentSession | undefined> {
    const candidates = await this.store.listAgentSessionRuntimeBindings(
      requestId ? { controlRequestId: requestId } : { sourceSessionId: source.id },
    );
    for (const binding of candidates) {
      if (
        binding.sourceSessionId === source.id &&
        binding.sourceAction === action &&
        binding.profileId === profileId
      ) {
        const session = await this.store.getAgentSession(binding.sessionId);
        if (session) return session;
      }
    }
    if (requestId && candidates.length > 0) {
      throw new AgentControlError(`Control request "${requestId}" was already used`);
    }
    return undefined;
  }

  private async inspect(session: AgentSession): Promise<AgentInspection> {
    const binding = await this.store.getAgentSessionRuntimeBinding(session.id);
    const runtime = binding
      ? this.resolveRuntime(binding.runtimeId, binding.runtimeKind)
      : undefined;
    const supported = runtime?.capabilities.supported;
    return {
      session,
      ...(binding?.roleId ? { roleId: binding.roleId } : {}),
      ...(binding
        ? {
            harness: {
              runtimeId: binding.runtimeId,
              kind: binding.runtimeKind,
              profileId: binding.profileId,
              ...(binding.model ? { model: binding.model } : {}),
              ...(binding.reasoning ? { reasoning: binding.reasoning } : {}),
            },
          }
        : {}),
      lastActivityAt: binding?.lastActivityAt ?? session.updatedAt,
      ...(binding?.lastError ? { error: binding.lastError } : {}),
      ...(binding?.usage ? { usage: binding.usage } : {}),
      controls: {
        sendInstruction:
          isActive(session.state) && Boolean(supported?.has('sessions.live-instructions')),
        interruptAndSend:
          isActive(session.state) &&
          Boolean(
            supported?.has('sessions.cancel') &&
              supported.has('sessions.resume') &&
              supported.has('sessions.live-instructions'),
          ),
        stop: isActive(session.state) && Boolean(supported?.has('sessions.cancel')),
        restart: isTerminal(session.state) && Boolean(binding && runtime),
        retry: isTerminal(session.state) && Boolean(binding && runtime),
        switchProfile: isTerminal(session.state) && Boolean(binding && this.resolveProfile),
      },
    };
  }

  private async requireSession(sessionId: AgentSessionId): Promise<AgentSession> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) throw new AgentControlError(`Session ${sessionId} not found`);
    return session;
  }

  private async requireActiveSession(sessionId: AgentSessionId): Promise<AgentSession> {
    const session = await this.requireSession(sessionId);
    if (!isActive(session.state)) {
      throw new AgentControlError(`Session ${sessionId} is not active (${session.state})`);
    }
    return session;
  }

  private async requireBinding(sessionId: AgentSessionId): Promise<AgentSessionRuntimeBinding> {
    const binding = await this.store.getAgentSessionRuntimeBinding(sessionId);
    if (!binding) {
      throw new AgentControlError(
        `Session ${sessionId} has no durable runtime binding; control was not simulated`,
      );
    }
    return binding;
  }

  private requireExactRuntime(binding: AgentSessionRuntimeBinding): HarnessRuntime {
    const runtime = this.resolveRuntime(binding.runtimeId, binding.runtimeKind);
    if (!runtime || runtime.id !== binding.runtimeId) {
      throw new AgentControlError(
        `Runtime "${binding.runtimeId}" for session ${binding.sessionId} is unavailable`,
      );
    }
    return runtime;
  }

  private async requireBoundRuntime(
    sessionId: AgentSessionId,
  ): Promise<{ binding: AgentSessionRuntimeBinding; runtime: HarnessRuntime }> {
    const binding = await this.requireBinding(sessionId);
    return { binding, runtime: this.requireExactRuntime(binding) };
  }

  private requireCapability(
    runtime: HarnessRuntime,
    capability: 'sessions.cancel' | 'sessions.live-instructions' | 'sessions.resume',
  ): void {
    if (!runtime.capabilities.supported.has(capability)) {
      throw new UnsupportedCapabilityError(capability, runtime.id);
    }
  }

  private subscribeToLifecycle(runtime: HarnessRuntime, sessionId: AgentSessionId): void {
    runtime.subscribe(sessionId, (event) => {
      if (event.state === 'cancelled' && this.suppressedCancellationEvents.delete(sessionId)) {
        return;
      }
      void (async () => {
        const session = await this.store.getAgentSession(sessionId);
        const binding = await this.store.getAgentSessionRuntimeBinding(sessionId);
        if (!session || !binding) return;
        const state = toAgentSessionState(event.state);
        await this.saveSessionState(session, state);
        const now = this.now();
        await this.store.saveAgentSessionRuntimeBinding({
          ...binding,
          lastActivityAt: now,
          ...(event.error ? { lastError: safeError(event.error) } : {}),
          updatedAt: now,
        });
        if (event.state === 'failed' && this.reportRuntimeFailure) {
          const summary = safeError(event.error ?? 'Agent session failed');
          await this.reportRuntimeFailure({
            kind: classifyRuntimeFailure(summary),
            sessionId,
            runId: session.runId,
            summary,
          });
        }
      })().catch(() => undefined);
    });
  }

  private async saveSessionState(
    session: AgentSession,
    state: AgentSession['state'],
  ): Promise<AgentSession> {
    const current = (await this.store.getAgentSession(session.id)) ?? session;
    if (current.state === state) return current;
    if (isTerminal(current.state)) return current;
    const now = this.now();
    const updated: AgentSession = {
      ...current,
      state,
      updatedAt: now,
      ...(isTerminal(state) ? { completedAt: now } : {}),
    };
    await this.store.saveAgentSession(updated);
    return updated;
  }

  private async touchBinding(binding: AgentSessionRuntimeBinding): Promise<void> {
    const now = this.now();
    await this.store.saveAgentSessionRuntimeBinding({
      ...binding,
      lastActivityAt: now,
      updatedAt: now,
    });
  }

  private async requireRun(runId: RunId): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new AgentControlError(`Run ${runId} not found`);
    return run;
  }

  private async saveRunState(run: Run, state: Run['state']): Promise<Run> {
    const now = this.now();
    const updated: Run = { ...run, state, updatedAt: now };
    await this.store.saveRun(updated);
    return updated;
  }

  private async audit(
    action: AuditAction,
    session?: AgentSession,
    binding?: AgentSessionRuntimeBinding,
    requestId?: string,
    runId?: RunId,
    resultingSessionId?: AgentSessionId,
  ): Promise<void> {
    const id = requestId ?? this.createRequestId();
    const targetRunId = runId ?? session?.runId;
    if (!targetRunId) throw new AgentControlError('Audit event requires a run id');
    await this.store.appendEvent({
      id: createEventId(`agent-control:${id}:${action}`),
      type: 'agent.control',
      occurredAt: this.now(),
      payload: {
        requestId: id,
        action,
        ...(session ? { sessionId: session.id } : {}),
        ...(resultingSessionId ? { resultingSessionId } : {}),
        runId: targetRunId,
        ...(binding ? { runtimeId: binding.runtimeId, profileId: binding.profileId } : {}),
      },
    });
  }

  private once<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const current = this.inFlight.get(key) as Promise<T> | undefined;
    if (current) return current;
    const pending = operation().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private log(sessionId: string, action: string): void {
    this.controlLog.push({ sessionId, action, at: this.now() });
  }
}

function redactSensitivePrompt(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, '[REDACTED]')
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/giu, '$1[REDACTED]');
}

function requireInstruction(value: string): string {
  const instruction = value.trim();
  if (!instruction) throw new AgentControlError('Instruction must not be empty');
  return instruction;
}

function requireHarnessProfile(value: unknown): HarnessProfile {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { id?: unknown }).id !== 'string' ||
    typeof (value as { kind?: unknown }).kind !== 'string' ||
    typeof (value as { managed?: unknown }).managed !== 'boolean'
  ) {
    throw new AgentControlError('Stored harness profile is invalid; no session was created');
  }
  return value as HarnessProfile;
}

function isActive(state: AgentSession['state'] | Run['state']): boolean {
  return state === 'starting' || state === 'running' || state === 'waiting' || state === 'blocked';
}

function isTerminal(state: AgentSession['state'] | Run['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function classifyRuntimeFailure(
  message: string,
): 'auth' | 'quota' | 'rate-limit' | 'stuck-agent' | 'agent-failure' {
  if (/\b(auth|authentication|credential|unauthori[sz]ed|forbidden|login)\b/i.test(message)) {
    return 'auth';
  }
  if (/\b(quota|credits?|billing|payment required)\b/i.test(message)) return 'quota';
  if (/\b(rate[ -]?limit|too many requests|429)\b/i.test(message)) return 'rate-limit';
  if (/\b(stuck|hung|no progress|timeout|timed out)\b/i.test(message)) return 'stuck-agent';
  return 'agent-failure';
}
