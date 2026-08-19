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
import { join } from 'node:path';
import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessRuntime,
  HarnessSession,
  HarnessSessionState,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapability } from './capabilities.js';
import { makeCapabilitySet } from './capabilities.js';

// ─── acpx types (imported lazily to keep this file tree-shakeable) ───────────

type AcpxRuntime = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: 'persistent' | 'oneshot';
    cwd?: string;
    sessionOptions?: {
      systemPrompt?: { type: 'text'; text: string };
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
      status?: string;
      message?: string;
    }>;
    cancel(input?: { reason?: string }): Promise<void>;
  };
  probeAvailability?(): Promise<void>;
  isHealthy?(): boolean;
  doctor?(): Promise<{
    healthy: boolean;
    checks: Array<{ name: string; ok: boolean; message?: string }>;
  }>;
};

export interface AcpxRuntimeAdapterConfig {
  readonly id: string;
  /**
   * ACP agent name to use. E.g. 'codex', 'claude-code', 'gemini-cli'.
   * Defaults to 'codex'.
   */
  readonly agent?: string;
  /**
   * Base directory where acpx stores session state.
   * Defaults to `~/.dark-kitchen/acpx-sessions`.
   */
  readonly sessionStoreDir?: string;
  /**
   * Permission mode for the acpx runtime.
   * 'auto' = auto-approve all tool calls (for autonomous runs).
   * 'interactive' = ask for permission (not suitable for daemon use).
   */
  readonly permissionMode?: 'auto' | 'manual' | 'interactive';
  readonly timeoutMs?: number;
}

const ACPX_CAPABILITIES: HarnessCapability[] = [
  'sessions.persistent',
  'sessions.resume',
  'sessions.cancel',
  'sessions.live-instructions',
  'model.selection',
  'reasoning.selection',
  'usage.reporting',
  'skills.mcp',
  'skills.plugins',
];

/**
 * Dark Kitchen HarnessRuntime backed by acpx.
 *
 * Each task gets a persistent ACP session keyed by `runId:taskId`.
 * Sessions survive Dark Kitchen restarts and can be resumed.
 */
export class AcpxRuntimeAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly capabilities = makeCapabilitySet(ACPX_CAPABILITIES);

  private readonly config: AcpxRuntimeAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, AcpxSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private runtime?: AcpxRuntime;

  public constructor(config: AcpxRuntimeAdapterConfig) {
    this.config = config;
    this.id = config.id;
  }

  /** Lazy-initialize the acpx runtime on first use. */
  private async getRuntime(): Promise<AcpxRuntime> {
    if (this.runtime) return this.runtime;

    const stateDir =
      this.config.sessionStoreDir ??
      join(process.env['HOME'] ?? '/tmp', '.dark-kitchen', 'acpx-sessions');
    mkdirSync(stateDir, { recursive: true });

    // Dynamic import so acpx is only required at runtime, not at build time
    const { createAcpRuntime, createRuntimeStore, createAgentRegistry } = await import(
      'acpx/runtime'
    );

    const sessionStore = createRuntimeStore({ stateDir });
    const agentRegistry = createAgentRegistry();

    this.runtime = createAcpRuntime({
      cwd: process.cwd(),
      sessionStore,
      agentRegistry,
      permissionMode: (this.config.permissionMode ?? 'auto') as never,
      timeoutMs: this.config.timeoutMs ?? 120_000,
    } as never) as unknown as AcpxRuntime;

    return this.runtime;
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const runtime = await this.getRuntime();
    const sessionId = createAgentSessionId(`acpx-${input.runId}-${input.taskId}-${Date.now()}`);

    // Deterministic session key so acpx can resume across restarts
    const sessionKey = `dk-${input.runId}-${input.taskId}`;

    const handle = await runtime.ensureSession({
      sessionKey,
      agent: this.config.agent ?? 'codex',
      mode: 'persistent',
      cwd: input.workspaceId as string, // workspaceId is the worktree path in practice
      ...(input.instructions
        ? {
            sessionOptions: {
              systemPrompt: { type: 'text', text: input.instructions },
            },
          }
        : {}),
    });

    const session: AcpxSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      acpxHandle: handle,
      sessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });

    // Send the initial prompt
    if (input.prompt) {
      await this.sendPromptInternal(sessionId, input.prompt, session);
    }

    return { ...session };
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    const session = this.getSessionState(sessionId);
    await this.sendPromptInternal(sessionId, prompt, session);
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeTurn?.cancel({ reason: 'user-cancel' }).catch(() => {});
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    const session = this.getSessionState(sessionId);
    const runtime = await this.getRuntime();

    // Re-ensure the session (acpx will reconnect to the existing persistent session)
    const handle = await runtime.ensureSession({
      sessionKey: session.sessionKey,
      agent: this.config.agent ?? 'codex',
      mode: 'persistent',
    });

    session.acpxHandle = handle;
    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });
    return { ...session };
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeTurn?.cancel({ reason: 'stop' }).catch(() => {});
    session.state = 'cancelled';
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
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
          healthy: report.healthy,
          message: report.checks
            .map((c) => `${c.name}: ${c.ok ? 'ok' : (c.message ?? 'fail')}`)
            .join(', '),
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

  private async sendPromptInternal(
    sessionId: AgentSessionId,
    prompt: string,
    session: AcpxSession,
  ): Promise<void> {
    const runtime = await this.getRuntime();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const turn = runtime.startTurn({
      handle: session.acpxHandle!,
      text: prompt,
      mode: 'prompt',
      requestId,
      timeoutMs: this.config.timeoutMs ?? 120_000,
    });

    session.activeTurn = turn;
    session.state = 'running';

    // Stream events
    (async () => {
      let outputBuffer = '';
      try {
        for await (const event of turn.events) {
          if (event.type === 'text_delta' && event.text) {
            outputBuffer += event.text;
            this.emit(sessionId, { sessionId, state: 'running', output: event.text });
          } else if (event.type === 'status' && event.status) {
            // Map acpx status events to DK states
            const mappedState = mapAcpStatus(event.status);
            if (mappedState) {
              session.state = mappedState;
              this.emit(sessionId, { sessionId, state: mappedState });
            }
          } else if (event.type === 'error' && event.message) {
            session.state = 'failed';
            const err = classifyAcpError(event.message);
            this.emit(sessionId, { sessionId, state: 'failed', error: err });
          }
        }

        const result = await turn.result;
        if (result.status === 'completed') {
          session.state = 'completed';
          this.emit(sessionId, { sessionId, state: 'completed', output: outputBuffer });
        } else if (result.status === 'cancelled') {
          session.state = 'cancelled';
          this.emit(sessionId, { sessionId, state: 'cancelled' });
        } else if (result.status === 'failed') {
          session.state = 'failed';
          this.emit(sessionId, {
            sessionId,
            state: 'failed',
            error: new Error(result.error?.message ?? 'acpx turn failed'),
          });
        }
      } catch (err) {
        session.state = 'failed';
        this.emit(sessionId, { sessionId, state: 'failed', error: err });
      } finally {
        delete (session as Partial<AcpxSession>).activeTurn;
      }
    })().catch(() => {});
  }

  private getSessionState(sessionId: AgentSessionId): AcpxSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`AcpxRuntimeAdapter: session ${sessionId} not found`);
    return s;
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
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
  activeTurn?: {
    result: Promise<{ status: string; error?: { message: string } }>;
    events: AsyncIterable<{ type: string; text?: string; status?: string; message?: string }>;
    cancel(input?: { reason?: string }): Promise<void>;
  };
}

export type AcpErrorKind = 'auth' | 'quota' | 'rate-limit' | 'generic';

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
  return new AcpClassifiedError(message, 'generic');
}

function mapAcpStatus(status: string): HarnessSessionState | undefined {
  if (status === 'idle' || status === 'waiting_for_input') return 'waiting';
  if (status === 'running' || status === 'working') return 'running';
  return undefined;
}

// Re-export for convenience
export { AcpxRuntimeAdapter as default };
