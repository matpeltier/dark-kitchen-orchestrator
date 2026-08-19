/**
 * ACP/acpx harness adapter.
 *
 * Integrates with acpx for ACP-compatible coding agents (Codex, Claude Code,
 * Gemini CLI, etc.) through structured persistent sessions. Payload content
 * (prompts, task bodies, diffs) travels through stdin/IPC, never through argv.
 *
 * acpx upstream: https://github.com/openclaw/acpx
 *
 * This adapter follows the process-execution invariant: executable + bounded
 * control args are separate from arbitrary runtime payload data.
 */

import { spawn } from 'node:child_process';
import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapability } from './capabilities.js';
import { makeCapabilitySet, requireCapability } from './capabilities.js';

export interface AcpAdapterConfig {
  readonly id: string;
  /**
   * acpx executable path, e.g. `/usr/local/bin/acpx`.
   * Defaults to `acpx` (resolved via PATH).
   */
  readonly executable?: string;
  /**
   * Named ACP profile/agent (e.g. 'codex', 'claude-code', 'gemini-cli',
   * or a custom user-registered profile). Passed as a control arg.
   */
  readonly profile: string;
  /**
   * Additional bounded control args (no payload content).
   */
  readonly extraArgs?: readonly string[];
  /**
   * Working directory for the ACP session.
   */
  readonly cwd?: string;
  /**
   * Supported capabilities for this ACP adapter instance.
   */
  readonly capabilities?: readonly HarnessCapability[];
}

const DEFAULT_ACP_CAPABILITIES: HarnessCapability[] = [
  'sessions.persistent',
  'sessions.cancel',
  'sessions.live-instructions',
  'sessions.resume',
  'model.selection',
  'reasoning.selection',
  'usage.reporting',
];

export interface AcpSessionMetadata {
  readonly externalSessionId: string;
  readonly profile: string;
  readonly startedAt: string;
}

/**
 * ACP-compatible harness runtime.
 *
 * In production: launches the acpx executable with `shell: false`,
 * sends the prompt through stdin, reads structured JSON/NDJSON output,
 * and maps ACP events to Dark Kitchen session state.
 *
 * In test/fake mode: the same contract applies but a fake ACP server is used.
 */
export class AcpHarnessAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly capabilities: ReturnType<typeof makeCapabilitySet>;
  private readonly config: AcpAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, AcpSessionState>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly metadata = new Map<AgentSessionId, AcpSessionMetadata>();

  public constructor(config: AcpAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = makeCapabilitySet(config.capabilities ?? DEFAULT_ACP_CAPABILITIES);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const sessionId = createAgentSessionId(
      `acp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const session: AcpSessionState = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'starting',
    };
    this.sessions.set(sessionId, session);

    // Build control args (bounded metadata only)
    const controlArgs = [
      '--profile',
      this.config.profile,
      '--session-id',
      sessionId,
      '--output-format',
      'ndjson',
      ...(input.model ? ['--model', input.model] : []),
      ...(this.config.extraArgs ?? []),
    ];

    const executable = this.config.executable ?? 'acpx';

    // Spawn with shell:false; prompt travels via stdin
    const child = spawn(executable, controlArgs, {
      shell: false,
      cwd: input.workspaceId ? undefined : (this.config.cwd ?? process.cwd()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    Object.assign(session, { childProcess: child, outputBuffer: '' });

    const handleOutput = (data: Buffer): void => {
      const text = data.toString('utf8');
      (session as AcpSessionState & { outputBuffer: string }).outputBuffer += text;
      this.parseAcpEvents(sessionId, text);
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    child.on('error', (err) => {
      this.mapError(sessionId, err);
    });

    child.on('close', (code) => {
      if (session.state !== 'cancelled' && session.state !== 'completed') {
        session.state = code === 0 ? 'completed' : 'failed';
        this.emit(sessionId, {
          sessionId,
          state: session.state,
          ...(code !== 0
            ? { error: new Error(`ACP process exited with code ${code ?? 'null'}`) }
            : {}),
        });
      }
    });

    // Write prompt payload to stdin
    if (child.stdin) {
      child.stdin.write(input.prompt, 'utf8');
      child.stdin.end();
    }

    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });

    const meta: AcpSessionMetadata = {
      externalSessionId: sessionId,
      profile: this.config.profile,
      startedAt: new Date().toISOString(),
    };
    this.metadata.set(sessionId, meta);

    const startResult: HarnessSession = { ...session };
    Object.assign(startResult, { externalSessionId: meta.externalSessionId });
    return startResult;
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    const session = this.getSessionState(sessionId);
    const child = (session as AcpSessionState & { childProcess?: ReturnType<typeof spawn> })
      .childProcess;
    if (child?.stdin?.writable) {
      // Payload goes through stdin, not args
      child.stdin.write(prompt + '\n', 'utf8');
    }
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.getSessionState(sessionId);
    const child = (session as AcpSessionState & { childProcess?: ReturnType<typeof spawn> })
      .childProcess;
    child?.kill('SIGTERM');
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const meta = this.metadata.get(sessionId);
    if (!meta) throw new Error(`No metadata for ACP session ${sessionId}`);
    const session = this.getSessionState(sessionId);
    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });
    const resumed: HarnessSession = { ...session };
    Object.assign(resumed, { externalSessionId: meta.externalSessionId });
    return resumed;
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const child = (session as AcpSessionState & { childProcess?: ReturnType<typeof spawn> })
      .childProcess;
    child?.kill('SIGKILL');
    session.state = 'cancelled';
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const meta = this.metadata.get(sessionId);
    const result: HarnessSession = { ...s };
    if (meta?.externalSessionId)
      Object.assign(result, { externalSessionId: meta.externalSessionId });
    return result;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
    return () => {
      this.subscribers.get(sessionId)?.delete(handler);
    };
  }

  public getSavedMetadata(sessionId: AgentSessionId): AcpSessionMetadata | undefined {
    return this.metadata.get(sessionId);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getSessionState(sessionId: AgentSessionId): AcpSessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`ACP session ${sessionId} not found`);
    return s;
  }

  private parseAcpEvents(sessionId: AgentSessionId, text: string): void {
    // Parse NDJSON ACP events and map to Dark Kitchen states.
    // Each line is a JSON object; we handle recognized event types.
    const lines = text.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as AcpEvent;
        this.handleAcpEvent(sessionId, event);
      } catch {
        // Not JSON – ignore or treat as plain output
      }
    }
  }

  private handleAcpEvent(sessionId: AgentSessionId, event: AcpEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (event.type) {
      case 'session.start':
        if (event.externalId) session.externalSessionId = event.externalId;
        break;
      case 'activity':
        if (event.content) {
          this.emit(sessionId, { sessionId, state: 'running', output: event.content });
        } else {
          this.emit(sessionId, { sessionId, state: 'running' });
        }
        break;
      case 'tool.call':
        this.emit(sessionId, { sessionId, state: 'running' });
        break;
      case 'session.complete':
        session.state = 'completed';
        if (event.content) {
          this.emit(sessionId, { sessionId, state: 'completed', output: event.content });
        } else {
          this.emit(sessionId, { sessionId, state: 'completed' });
        }
        break;
      case 'session.error':
        session.state = 'failed';
        this.emit(sessionId, {
          sessionId,
          state: 'failed',
          error: new Error(event.message ?? 'ACP session error'),
        });
        break;
      case 'auth.error':
      case 'quota.error':
      case 'rate-limit':
        session.state = 'failed';
        this.emit(sessionId, {
          sessionId,
          state: 'failed',
          error: new AcpOperationalError(event.type, event.message ?? event.type),
        });
        break;
    }
  }

  private mapError(sessionId: AgentSessionId, err: Error): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'failed';
    this.emit(sessionId, { sessionId, state: 'failed', error: err });
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    for (const handler of this.subscribers.get(sessionId) ?? []) {
      handler(event);
    }
  }
}

interface AcpSessionState extends HarnessSession {
  childProcess?: ReturnType<typeof spawn>;
  outputBuffer?: string;
}

interface AcpEvent {
  type: string;
  externalId?: string;
  content?: string | null;
  message?: string;
}

export class AcpOperationalError extends Error {
  public readonly errorType: string;
  public constructor(errorType: string, message: string) {
    super(message);
    this.name = 'AcpOperationalError';
    this.errorType = errorType;
  }
}
