/**
 * Real acpx HarnessRuntime adapter.
 *
 * Uses `createAcpRuntime` from the `acpx` package to manage persistent
 * ACP sessions for Cursor Composer, Claude Code, Gemini CLI, and any
 * other ACP-compatible agent.
 *
 * Payload content (prompts, task bodies) travels through acpx's programmatic
 * API — never through shell command strings or argv.
 */

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessProfile,
  HarnessRuntime,
  HarnessSession,
  HarnessSessionState,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapability } from './capabilities.js';
import { makeCapabilitySet, requireCapability } from './capabilities.js';

// ─── acpx types (imported lazily to keep this file tree-shakeable) ───────────

type AcpxRuntime = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: 'persistent' | 'oneshot';
    cwd?: string;
    sessionOptions?: {
      model?: string;
      systemPrompt?: { type: 'text'; text: string } | { append: string };
    };
  }): Promise<{ sessionKey: string; backend: string; runtimeSessionName: string; cwd?: string }>;
  startTurn(input: {
    handle: { sessionKey: string; backend: string; runtimeSessionName: string; cwd?: string };
    text: string;
    mode: 'prompt' | 'steer';
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): {
    result: Promise<{ status: 'completed' | 'cancelled' | 'failed'; error?: { message: string } }>;
    events: AsyncIterable<{
      type: 'text_delta' | 'status' | 'tool_call' | 'done' | 'error';
      text?: string;
      stream?: 'output' | 'thought';
      tag?: string;
      status?: string;
      message?: string;
    }>;
    cancel(input?: { reason?: string }): Promise<void>;
  };
  probeAvailability?(): Promise<void>;
  isHealthy?(): boolean;
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};

export interface AcpMcpServerConfig {
  readonly name: string;
  readonly url: string;
  /** 'http' (default), 'sse', or 'acp' */
  readonly type?: 'http' | 'sse' | 'acp';
  /** Control-plane server injected into every session (for example dk_ask_human). */
  readonly always?: boolean;
}

export interface AcpxRuntimeFactoryOptions {
  readonly mcpServers: readonly AcpMcpServerConfig[];
}

export interface AcpxRuntimeAdapterConfig {
  readonly id: string;
  /**
   * ACP agent name to use. E.g. 'codex', 'claude-code', 'gemini-cli'.
   * Defaults to 'codex'.
   */
  readonly agent?: string;
  /**
   * Optional trusted ACP server command for a custom agent name. This is
   * launch configuration only; prompts are still sent through the runtime API.
   */
  readonly agentCommand?: string | readonly string[];
  /**
   * Base directory where acpx stores session state.
   * Defaults to `~/.dark-kitchen/acpx-sessions`.
   */
  readonly sessionStoreDir?: string;
  /**
   * Permission mode for the acpx runtime.
   * Uses acpx 0.13's native values. Legacy Dark Kitchen aliases are accepted
   * and normalized (`auto` → `approve-all`, manual/interactive → `approve-reads`).
   */
  readonly permissionMode?:
    | 'approve-all'
    | 'approve-reads'
    | 'deny-all'
    | 'auto'
    | 'manual'
    | 'interactive';
  /**
   * Timeout for short acpx infrastructure operations (session connect/close,
   * model selection, etc.) — NOT the agent turn itself. Defaults to 120s.
   * Do not raise this to bound agent work; agent turns are unbounded.
   */
  readonly timeoutMs?: number;
  /**
   * Watchdog for a single agent turn. The agent itself is allowed to run as
   * long as it needs (subagents, exploration, etc.). This watchdog only fires
   * if the backend dies or stalls without emitting any terminal event, so Dark
   * Kitchen fails the session instead of hanging forever. Defaults to 2 hours.
   */
  readonly turnTimeoutMs?: number;
  /** Available MCP endpoints. Only `always` endpoints and the current session selection are injected. */
  readonly mcpServers?: readonly AcpMcpServerConfig[];
  /** Injectable programmatic boundary for compatibility tests/custom hosts. */
  readonly runtimeFactory?: (options: AcpxRuntimeFactoryOptions) => Promise<AcpxRuntimeBoundary>;
}

/** Minimal acpx runtime surface consumed by the adapter. */
export type AcpxRuntimeBoundary = AcpxRuntime;

/** Serializable metadata required to reconnect an acpx session after restart. */
export interface AcpxSessionCheckpoint {
  readonly id: AgentSessionId;
  readonly runId: HarnessSession['runId'];
  readonly taskId: HarnessSession['taskId'];
  readonly workspaceId: HarnessSession['workspaceId'];
  readonly profile: HarnessProfile;
  readonly sessionKey: string;
  readonly mcpServers?: readonly string[];
}

const ACPX_CAPABILITIES: HarnessCapability[] = [
  'sessions.persistent',
  'sessions.resume',
  'sessions.cancel',
  'sessions.live-instructions',
  'model.selection',
  'skills.mcp',
];

const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function buildResourceInstructions(input: StartSessionInput): string | undefined {
  const tools = [...new Set(input.resources?.tools ?? [])];
  const lines = [
    tools.length > 0
      ? `Required verified tools/capabilities: ${tools.join(', ')}. Use them and return evidence from their real execution.`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function requestedMcpServers(input: StartSessionInput): readonly string[] {
  return [
    ...new Set([
      ...(input.profile.managed ? (input.profile.mcpServers ?? []) : []),
      ...(input.resources?.mcpServers ?? []),
    ]),
  ];
}

/**
 * Dark Kitchen HarnessRuntime backed by acpx.
 *
 * Each task gets a persistent ACP session keyed by `runId:taskId`.
 * Sessions survive Dark Kitchen restarts and can be resumed.
 */
export class AcpxRuntimeAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly kind: string;
  public readonly capabilities = makeCapabilitySet(ACPX_CAPABILITIES);

  private readonly config: AcpxRuntimeAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, AcpxSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly lastEvents = new Map<AgentSessionId, Parameters<HarnessEventHandler>[0]>();
  private readonly runtimes = new Map<string, Promise<AcpxRuntime>>();

  public constructor(config: AcpxRuntimeAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.kind = config.agent ?? 'codex';
  }

  /** Lazy-initialize an acpx runtime isolated to the requested MCP set. */
  private getRuntime(selectedMcpServers: readonly string[] = []): Promise<AcpxRuntime> {
    const requested = new Set(selectedMcpServers);
    const mcpServers = (this.config.mcpServers ?? []).filter(
      (server) => server.always === true || requested.has(server.name) || requested.has(server.url),
    );
    const runtimeKey = mcpServers
      .map((server) => `${server.name}\u0000${server.url}\u0000${server.type ?? 'http'}`)
      .sort()
      .join('\u0001');
    const existing = this.runtimes.get(runtimeKey);
    if (existing) return existing;
    const created = this.createRuntime(mcpServers).catch((error: unknown) => {
      this.runtimes.delete(runtimeKey);
      throw error;
    });
    this.runtimes.set(runtimeKey, created);
    return created;
  }

  private async createRuntime(
    selectedMcpServers: readonly AcpMcpServerConfig[],
  ): Promise<AcpxRuntime> {
    if (this.config.runtimeFactory) {
      return this.config.runtimeFactory({ mcpServers: selectedMcpServers });
    }

    const stateDir =
      this.config.sessionStoreDir ??
      join(process.env['HOME'] ?? '/tmp', '.dark-kitchen', 'acpx-sessions');
    mkdirSync(stateDir, { recursive: true });

    // Dynamic import so acpx is only required at runtime, not at build time
    let acpxModule: typeof import('acpx/runtime');
    try {
      acpxModule = await import('acpx/runtime');
    } catch (error) {
      throw new AcpClassifiedError(
        `Unable to load the pinned acpx runtime API: ${String(error)}`,
        'compatibility',
      );
    }
    const { createAcpRuntime, createRuntimeStore, createAgentRegistry } = acpxModule;

    const sessionStore = createRuntimeStore({ stateDir });
    const agentName = this.config.agent ?? 'codex';
    const agentRegistry = createAgentRegistry(
      this.config.agentCommand
        ? { overrides: { [agentName]: [...toCommand(this.config.agentCommand)] } }
        : undefined,
    );

    const mcpServers = selectedMcpServers.map((s) => ({
      type: s.type ?? 'http',
      name: s.name,
      url: s.url,
      // ACP requires the headers field (can be empty) for HTTP/SSE servers
      headers: [] as Array<{ name: string; value: string }>,
    }));

    return createAcpRuntime({
      cwd: process.cwd(),
      sessionStore,
      agentRegistry,
      probeAgent: agentName,
      permissionMode: normalizePermissionMode(this.config.permissionMode),
      timeoutMs: this.config.timeoutMs ?? 120_000,
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    } as never) as unknown as AcpxRuntime;
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    this.validateInputCapabilities(input);
    const selectedMcpServers = requestedMcpServers(input);
    const runtime = await this.getRuntime(selectedMcpServers);
    const invocationId = randomUUID();
    const sessionId = createAgentSessionId(`acpx-${input.runId}-${input.taskId}-${invocationId}`);

    // Unique per invocation: the durable SQLite journal (not acpx) is what
    // resumes completed work across daemon restarts. A fresh acpx session each
    // time avoids reusing a stale backend.
    const sessionKey = `dk-${input.runId}-${input.taskId}-${invocationId}`;

    const model = input.model ?? (input.profile.managed ? input.profile.model : undefined);
    const configuredInstructions =
      input.instructions ?? (input.profile.managed ? input.profile.instructions : undefined);
    const resourceInstructions = buildResourceInstructions(input);
    const instructions = [configuredInstructions, resourceInstructions]
      .filter(Boolean)
      .join('\n\n');
    let handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>;
    try {
      handle = await runtime.ensureSession({
        sessionKey,
        agent: this.config.agent ?? 'codex',
        mode: 'persistent',
        cwd: input.workspaceId as string, // workspaceId is the worktree path in practice
        ...(instructions || model
          ? {
              sessionOptions: {
                ...(model ? { model } : {}),
                // 'append' mode: preserves the agent's built-in system prompt and appends ours
                ...(instructions ? { systemPrompt: { append: instructions } } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      throw toAcpClassifiedError(error);
    }

    const session: AcpxSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      acpxHandle: handle,
      sessionKey,
      mcpServers: selectedMcpServers,
    };

    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });

    // Send the initial prompt without delaying session publication. Any
    // follow-up submitted through sendPrompt() is serialized behind it.
    if (input.prompt) {
      void this.enqueuePrompt(sessionId, input.prompt, session);
    }

    return snapshotAcpSession(session);
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    const session = this.getSessionState(sessionId);
    await this.enqueuePrompt(sessionId, prompt, session);
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session || isTerminalHarnessState(session.state)) return;
    session.activeTurn?.cancel({ reason: 'user-cancel' }).catch(() => {});
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const session = this.getSessionState(sessionId);
    const runtime = await this.getRuntime(session.mcpServers);

    // Re-ensure the session (acpx will reconnect to the existing persistent session)
    let handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>;
    try {
      handle = await runtime.ensureSession({
        sessionKey: session.sessionKey,
        agent: this.config.agent ?? 'codex',
        mode: 'persistent',
        cwd: session.workspaceId as string,
      });
    } catch (error) {
      throw toAcpClassifiedError(error);
    }

    session.acpxHandle = handle;
    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });
    return snapshotAcpSession(session);
  }

  /** Export restart-safe metadata for the daemon's durable session record. */
  public checkpointSession(sessionId: AgentSessionId): AcpxSessionCheckpoint {
    const session = this.getSessionState(sessionId);
    return {
      id: session.id,
      runId: session.runId,
      taskId: session.taskId,
      workspaceId: session.workspaceId,
      profile: session.profile,
      sessionKey: session.sessionKey,
      ...(session.mcpServers.length > 0 ? { mcpServers: [...session.mcpServers] } : {}),
    };
  }

  /** Reconnect a checkpoint persisted by a previous adapter/process instance. */
  public async restoreSession(checkpoint: AcpxSessionCheckpoint): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const selectedMcpServers =
      checkpoint.mcpServers ??
      (checkpoint.profile.managed ? (checkpoint.profile.mcpServers ?? []) : []);
    const runtime = await this.getRuntime(selectedMcpServers);
    let handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>;
    try {
      handle = await runtime.ensureSession({
        sessionKey: checkpoint.sessionKey,
        agent: this.config.agent ?? 'codex',
        mode: 'persistent',
        cwd: checkpoint.workspaceId as string,
      });
    } catch (error) {
      throw toAcpClassifiedError(error);
    }
    const session: AcpxSession = {
      ...checkpoint,
      state: 'waiting',
      acpxHandle: handle,
      mcpServers: [...selectedMcpServers],
    };
    this.sessions.set(session.id, session);
    this.emit(session.id, { sessionId: session.id, state: 'waiting' });
    return snapshotAcpSession(session);
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || isTerminalHarnessState(session.state)) return;
    session.activeTurn?.cancel({ reason: 'stop' }).catch(() => {});
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? snapshotAcpSession(s) : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    this.getSessionState(sessionId);
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
    const lastEvent = this.lastEvents.get(sessionId);
    if (lastEvent && isTerminalHarnessState(lastEvent.state)) {
      queueMicrotask(() => {
        if (this.lastEvents.get(sessionId) === lastEvent) handler(lastEvent);
      });
    }
    return () => {
      this.subscribers.get(sessionId)?.delete(handler);
    };
  }

  /** Run the acpx doctor probe to check agent availability. */
  public async probe(): Promise<{ healthy: boolean; message: string }> {
    try {
      const runtime = await this.getRuntime();
      if (runtime.doctor) {
        const report = await runtime.doctor();
        return {
          healthy: report.ok,
          message: report.message,
        };
      }
      if (runtime.probeAvailability) {
        await runtime.probeAvailability();
      }
      return { healthy: true, message: 'acpx available' };
    } catch (err) {
      return { healthy: false, message: String(err) };
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private validateInputCapabilities(input: StartSessionInput): void {
    if (input.reasoning || (input.profile.managed && input.profile.reasoning)) {
      requireCapability(this.capabilities, 'reasoning.selection', this.id);
    }
    if (
      (input.profile.managed && (input.profile.skills?.length ?? 0) > 0) ||
      (input.resources?.skills?.length ?? 0) > 0
    ) {
      requireCapability(this.capabilities, 'skills.custom', this.id);
    }
    if (input.profile.managed && (input.profile.plugins?.length ?? 0) > 0) {
      requireCapability(this.capabilities, 'skills.plugins', this.id);
    }
    const requestedMcpServers = [
      ...(input.profile.managed ? (input.profile.mcpServers ?? []) : []),
      ...(input.resources?.mcpServers ?? []),
    ];
    if (requestedMcpServers.length > 0) {
      requireCapability(this.capabilities, 'skills.mcp', this.id);
      const configured = new Set(
        (this.config.mcpServers ?? []).flatMap((server) => [server.name, server.url]),
      );
      const missing = requestedMcpServers.filter((name) => !configured.has(name));
      if (missing.length > 0) {
        throw new AcpClassifiedError(
          `ACP MCP servers are not configured on runtime ${this.id}: ${missing.join(', ')}`,
          'compatibility',
        );
      }
    }
  }

  private enqueuePrompt(
    sessionId: AgentSessionId,
    prompt: string,
    session: AcpxSession,
  ): Promise<void> {
    if (session.state === 'cancelled') {
      return Promise.reject(
        new AcpClassifiedError('Cannot prompt a cancelled acpx session', 'generic'),
      );
    }
    if (session.state !== 'running') {
      session.state = 'running';
      this.emit(sessionId, { sessionId, state: 'running' });
    }
    const queued = (session.turnQueue ?? Promise.resolve()).then(async () => {
      if (session.state === 'cancelled') {
        throw new AcpClassifiedError('Cannot prompt a cancelled acpx session', 'generic');
      }
      await this.executeTurn(sessionId, prompt, session);
    });
    session.turnQueue = queued.catch(() => {});
    return queued;
  }

  private async executeTurn(
    sessionId: AgentSessionId,
    prompt: string,
    session: AcpxSession,
  ): Promise<void> {
    const runtime = await this.getRuntime(session.mcpServers);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const turnBudget = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    // Watchdog: if the agent backend dies or stalls without a terminal event,
    // fail the session so the caller can surface an intervention instead of
    // hanging forever.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      fn();
    };

    const timeoutController = new AbortController();
    let turn: ReturnType<AcpxRuntime['startTurn']> | undefined;
    const timeoutTimer =
      turnBudget > 0
        ? setTimeout(() => {
            settle(() => {
              timeoutController.abort();
              turn?.cancel({ reason: `turn timeout after ${turnBudget}ms` }).catch(() => {});
              session.state = 'failed';
              this.emit(sessionId, {
                sessionId,
                state: 'failed',
                error: new AcpClassifiedError(
                  `Agent turn timed out after ${turnBudget}ms`,
                  'generic',
                ),
              });
            });
          }, turnBudget)
        : undefined;

    try {
      turn = runtime.startTurn({
        handle: session.acpxHandle!,
        text: prompt,
        mode: 'prompt',
        requestId,
        // timeoutMs: 0 disables acpx's whole-turn timeout. The agent may run for
        // as long as it needs (subagents, long tasks); the only guard is the
        // watchdog above, which fires only when the backend dies/stalls.
        timeoutMs: 0,
        ...(turnBudget > 0 ? { signal: timeoutController.signal } : {}),
      });
    } catch (error) {
      settle(() => {
        session.state = 'failed';
        this.emit(sessionId, {
          sessionId,
          state: 'failed',
          error: toAcpClassifiedError(error),
        });
      });
      return;
    }

    session.activeTurn = turn;
    session.state = 'running';

    // Stream machine-readable events, then settle from the typed turn result.
    let outputBuffer = '';
    try {
      for await (const event of turn.events) {
        if (
          event.type === 'text_delta' &&
          event.text &&
          event.stream !== 'thought' &&
          event.tag !== 'agent_thought_chunk'
        ) {
          outputBuffer += event.text;
          this.emit(sessionId, { sessionId, state: 'running', output: event.text });
        } else if (event.type === 'status' && event.text) {
          const mappedState = mapAcpStatus(event.text);
          if (mappedState) {
            session.state = mappedState;
            this.emit(sessionId, { sessionId, state: mappedState });
          }
        } else if (event.type === 'error' && event.message) {
          settle(() => {
            session.state = 'failed';
            const err = classifyAcpError(event.message!);
            this.emit(sessionId, { sessionId, state: 'failed', error: err });
          });
        }
      }

      const result = await turn.result;
      if (session.state === 'cancelled') return;
      if (result.status === 'completed') {
        settle(() => {
          session.state = 'completed';
          this.emit(sessionId, { sessionId, state: 'completed', output: outputBuffer });
        });
      } else if (result.status === 'cancelled') {
        settle(() => {
          session.state = 'cancelled';
          this.emit(sessionId, { sessionId, state: 'cancelled' });
        });
      } else if (result.status === 'failed') {
        settle(() => {
          session.state = 'failed';
          this.emit(sessionId, {
            sessionId,
            state: 'failed',
            error: classifyAcpError(result.error?.message ?? 'acpx turn failed'),
          });
        });
      }
    } catch (err) {
      if (session.state === 'cancelled') return;
      settle(() => {
        session.state = 'failed';
        this.emit(sessionId, {
          sessionId,
          state: 'failed',
          error: classifyAcpError(err instanceof Error ? err.message : String(err)),
        });
      });
    } finally {
      clearTimeout(timeoutTimer);
      delete (session as Partial<AcpxSession>).activeTurn;
    }
  }

  private getSessionState(sessionId: AgentSessionId): AcpxSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`AcpxRuntimeAdapter: session ${sessionId} not found`);
    return s;
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    this.lastEvents.set(sessionId, event);
    for (const handler of this.subscribers.get(sessionId) ?? []) handler(event);
  }
}

interface AcpxSession extends HarnessSession {
  state: HarnessSession['state'];
  acpxHandle?: {
    sessionKey: string;
    backend: string;
    runtimeSessionName: string;
    cwd?: string;
  };
  sessionKey: string;
  readonly mcpServers: readonly string[];
  activeTurn?: {
    result: Promise<{ status: string; error?: { message: string } }>;
    events: AsyncIterable<{
      type: string;
      text?: string;
      status?: string;
      message?: string;
      stream?: 'output' | 'thought';
      tag?: string;
    }>;
    cancel(input?: { reason?: string }): Promise<void>;
  };
  turnQueue?: Promise<void>;
}

export type AcpErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'permission'
  | 'process'
  | 'compatibility'
  | 'generic';

export class AcpClassifiedError extends Error {
  public readonly kind: AcpErrorKind;
  public constructor(message: string, kind: AcpErrorKind) {
    super(message);
    this.name = 'AcpClassifiedError';
    this.kind = kind;
  }
}

/**
 * Classifies an acpx error message into an operational category
 * so the daemon can create the right intervention kind.
 */
function classifyAcpError(message: string): AcpClassifiedError {
  const lower = message.toLowerCase();
  if (
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('api key') ||
    lower.includes('token')
  ) {
    return new AcpClassifiedError(message, 'auth');
  }
  if (
    lower.includes('quota') ||
    lower.includes('credit') ||
    lower.includes('billing') ||
    lower.includes('insufficient')
  ) {
    return new AcpClassifiedError(message, 'quota');
  }
  if (lower.includes('rate') || lower.includes('429') || lower.includes('too many')) {
    return new AcpClassifiedError(message, 'rate-limit');
  }
  if (lower.includes('permission') || lower.includes('denied') || lower.includes('approval')) {
    return new AcpClassifiedError(message, 'permission');
  }
  if (
    lower.includes('spawn') ||
    lower.includes('executable') ||
    lower.includes('process exited') ||
    lower.includes('enoent')
  ) {
    return new AcpClassifiedError(message, 'process');
  }
  return new AcpClassifiedError(message, 'generic');
}

function toAcpClassifiedError(error: unknown): AcpClassifiedError {
  if (error instanceof AcpClassifiedError) return error;
  return classifyAcpError(error instanceof Error ? error.message : String(error));
}

function mapAcpStatus(status: string): HarnessSessionState | undefined {
  if (status === 'idle' || status === 'waiting_for_input') return 'waiting';
  if (status === 'running' || status === 'working') return 'running';
  return undefined;
}

function toCommand(command: string | readonly string[]): readonly string[] {
  return typeof command === 'string' ? [command] : command;
}

function normalizePermissionMode(
  mode: AcpxRuntimeAdapterConfig['permissionMode'],
): 'approve-all' | 'approve-reads' | 'deny-all' {
  if (mode === 'deny-all' || mode === 'approve-reads') return mode;
  if (mode === 'manual' || mode === 'interactive') return 'approve-reads';
  return 'approve-all';
}

function isTerminalHarnessState(state: HarnessSessionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function snapshotAcpSession(session: AcpxSession): HarnessSession {
  return {
    id: session.id,
    runId: session.runId,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    profile: session.profile,
    state: session.state,
    externalSessionId: session.sessionKey,
  };
}

// Re-export for convenience
export { AcpxRuntimeAdapter as default };
