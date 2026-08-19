/**
 * Real acpx HarnessRuntime adapter.
 *
 * Drives the `acpx` CLI (v0.13+) via child_process instead of the
 * programmatic `acpx/runtime` API which is not publicly exported.
 *
 * Session lifecycle:
 *   ensure  → acpx <agent> sessions ensure --name <key>
 *   prompt  → acpx <agent> prompt <text> -s <key>  (streaming)
 *   cancel  → acpx <agent> cancel -s <key>
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

export interface AcpMcpServerConfig {
  readonly name: string;
  readonly url: string;
  readonly type?: 'http' | 'sse' | 'acp';
}

export interface AcpxRuntimeAdapterConfig {
  readonly id: string;
  /** ACP agent name: 'codex', 'claude', 'gemini', etc. Defaults to 'codex'. */
  readonly agent?: string;
  readonly sessionStoreDir?: string;
  readonly permissionMode?: 'auto' | 'manual' | 'interactive';
  readonly timeoutMs?: number;
  readonly mcpServers?: readonly AcpMcpServerConfig[];
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

const ACPX_CAPABILITIES: HarnessCapability[] = [
  'sessions.persistent',
  'sessions.resume',
  'sessions.cancel',
  'sessions.live-instructions',
  'model.selection',
  'usage.reporting',
  'skills.mcp',
  'skills.plugins',
];

interface AcpxSession extends HarnessSession {
  state: HarnessSessionState;
  sessionKey: string;
  abortController?: AbortController;
}

/**
 * Dark Kitchen HarnessRuntime backed by the acpx CLI.
 */
export class AcpxRuntimeAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly capabilities = makeCapabilitySet(ACPX_CAPABILITIES);

  private readonly config: AcpxRuntimeAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, AcpxSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly agent: string;

  public constructor(config: AcpxRuntimeAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.agent = config.agent ?? 'codex';
    if (config.sessionStoreDir) {
      mkdirSync(config.sessionStoreDir, { recursive: true });
    }
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const sessionId = createAgentSessionId(`acpx-${input.runId}-${input.taskId}-${Date.now()}`);
    const sessionKey = `dk-${input.taskId}`;

    // Ensure the persistent session exists
    await this.runCli(['sessions', 'ensure', '--name', sessionKey], {
      cwd: input.workspaceId as string,
    });

    const session: AcpxSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      sessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });

    if (input.prompt) {
      void this.sendPromptInternal(sessionId, input.prompt, session, input.instructions);
    }

    return { ...session };
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.sendPromptInternal(sessionId, prompt, session);
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abortController?.abort();
    await this.runCli(['cancel', '-s', session.sessionKey]).catch(() => {});
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    const session = this.getSessionOrThrow(sessionId);
    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });
    return { ...session };
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abortController?.abort();
    session.state = 'cancelled';
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
    return () => this.subscribers.get(sessionId)?.delete(handler);
  }

  public async probe(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.runCli(['status']);
      return { healthy: true, message: `acpx ${this.agent} available` };
    } catch (err) {
      return { healthy: false, message: String(err) };
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async sendPromptInternal(
    sessionId: AgentSessionId,
    prompt: string,
    session: AcpxSession,
    instructions?: string,
  ): Promise<void> {
    const ac = new AbortController();
    session.abortController = ac;
    session.state = 'running';

    // Build args: acpx <agent> prompt <text> -s <key>
    // Prepend system instructions if provided (first turn only)
    const fullPrompt = instructions ? `${instructions}\n\n---\n\n${prompt}` : prompt;

    const args = ['prompt', fullPrompt, '-s', session.sessionKey];

    const env: NodeJS.ProcessEnv = { ...process.env };

    (async () => {
      let outputBuffer = '';
      try {
        await this.runCliStreaming(
          args,
          {
            cwd: session.workspaceId as string,
            signal: ac.signal,
            env,
          },
          (chunk) => {
            outputBuffer += chunk;
            this.emit(sessionId, { sessionId, state: 'running', output: chunk });
          },
        );

        session.state = 'completed';
        this.emit(sessionId, { sessionId, state: 'completed', output: outputBuffer });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          session.state = 'cancelled';
          this.emit(sessionId, { sessionId, state: 'cancelled' });
        } else {
          session.state = 'failed';
          this.emit(sessionId, {
            sessionId,
            state: 'failed',
            error: classifyAcpError(String(err)),
          });
        }
      } finally {
        delete session.abortController;
      }
    })().catch(() => {});
  }

  /**
   * Run `acpx <agent> <args>` and return stdout as a string.
   */
  private runCli(
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('acpx', [this.agent, ...args], {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`acpx ${this.agent} ${args[0]} exited ${code}: ${stderr.trim()}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * Run `acpx <agent> <args>` and stream stdout chunks to `onData`.
   */
  private runCliStreaming(
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('acpx', [this.agent, ...args], {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      opts.signal?.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });

      proc.stdout.on('data', (d: Buffer) => onData(d.toString()));
      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        // Surface errors to the output stream so they appear in the dashboard
        if (text.trim()) onData(`[stderr] ${text}`);
      });

      proc.on('close', (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`acpx ${this.agent} exited ${code}`));
      });
      proc.on('error', reject);
    });
  }

  private getSessionOrThrow(sessionId: AgentSessionId): AcpxSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`AcpxRuntimeAdapter: session ${sessionId} not found`);
    return s;
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    for (const handler of this.subscribers.get(sessionId) ?? []) handler(event);
  }
}

export function classifyAcpError(message: string): AcpClassifiedError {
  const lower = message.toLowerCase();
  if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('api key') || lower.includes('token')) {
    return new AcpClassifiedError(message, 'auth');
  }
  if (lower.includes('quota') || lower.includes('credit') || lower.includes('billing') || lower.includes('insufficient')) {
    return new AcpClassifiedError(message, 'quota');
  }
  if (lower.includes('rate') || lower.includes('429') || lower.includes('too many')) {
    return new AcpClassifiedError(message, 'rate-limit');
  }
  return new AcpClassifiedError(message, 'generic');
}

export { AcpxRuntimeAdapter as default };
