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

import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import {
  controlArgument,
  defineProcess,
  executeProcess,
  stdinPayload,
} from '@dark-kitchen/process-execution';
import type {
  HarnessEventHandler,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapability } from './capabilities.js';
import {
  makeCapabilitySet,
  requireCapability,
  UnsupportedCapabilityError,
} from './capabilities.js';

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

const DEFAULT_ACP_CAPABILITIES: HarnessCapability[] = ['sessions.cancel', 'model.selection'];

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
  public readonly kind: string;
  public readonly capabilities: ReturnType<typeof makeCapabilitySet>;
  private readonly config: AcpAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, AcpSessionState>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly lastEvents = new Map<AgentSessionId, Parameters<HarnessEventHandler>[0]>();
  private readonly metadata = new Map<AgentSessionId, AcpSessionMetadata>();

  public constructor(config: AcpAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.kind = config.profile;
    const capabilities = config.capabilities ?? DEFAULT_ACP_CAPABILITIES;
    for (const capability of capabilities) {
      if (!DEFAULT_ACP_CAPABILITIES.includes(capability)) {
        throw new UnsupportedCapabilityError(capability, config.id);
      }
    }
    this.capabilities = makeCapabilitySet(capabilities);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    this.validateInputCapabilities(input);
    const sessionId = createAgentSessionId(
      `acp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const session: AcpSessionState = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      controller: new AbortController(),
    };
    this.sessions.set(sessionId, session);

    // Build control args (bounded metadata only)
    const controlArgs = [
      '--format',
      'json',
      ...(input.model ? ['--model', input.model] : []),
      ...(this.config.extraArgs ?? []),
      this.config.profile,
      'prompt',
      '--session',
      sessionId,
      '--file',
      '-',
    ];

    this.emit(sessionId, { sessionId, state: 'running' });

    const meta: AcpSessionMetadata = {
      externalSessionId: sessionId,
      profile: this.config.profile,
      startedAt: new Date().toISOString(),
    };
    this.metadata.set(sessionId, meta);
    void this.runCliSession(sessionId, session, input, controlArgs);

    const startResult: HarnessSession = { ...session };
    Object.assign(startResult, { externalSessionId: meta.externalSessionId });
    return startResult;
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    this.getSessionState(sessionId);
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    void prompt;
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session || isTerminalAcpState(session.state)) return;
    session.controller.abort();
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
    if (!session || isTerminalAcpState(session.state)) return;
    session.controller.abort();
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
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
    this.getSessionState(sessionId);
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);
    const lastEvent = this.lastEvents.get(sessionId);
    if (lastEvent && isTerminalAcpState(lastEvent.state)) {
      queueMicrotask(() => {
        if (this.lastEvents.get(sessionId) === lastEvent) handler(lastEvent);
      });
    }
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

  private async runCliSession(
    sessionId: AgentSessionId,
    session: AcpSessionState,
    input: StartSessionInput,
    controlArgs: readonly string[],
  ): Promise<void> {
    try {
      const result = await executeProcess({
        definition: defineProcess({
          executable: this.config.executable ?? 'acpx',
          args: controlArgs.map(controlArgument),
          label: this.id,
        }),
        cwd: this.config.cwd ?? (input.workspaceId as string),
        payload: stdinPayload(
          input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt,
        ),
        signal: session.controller.signal,
      });
      if (session.controller.signal.aborted || session.state === 'cancelled') return;
      const stdout = Buffer.from(result.stdout).toString('utf8');
      const stderr = Buffer.from(result.stderr).toString('utf8');
      if (result.exitCode === 0) {
        session.state = 'completed';
        this.emit(sessionId, { sessionId, state: 'completed', output: stdout });
      } else {
        session.state = 'failed';
        this.emit(sessionId, {
          sessionId,
          state: 'failed',
          error: classifyAcpCliError(
            stderr || `ACP process exited with code ${String(result.exitCode)}`,
          ),
        });
      }
    } catch (error) {
      if (session.controller.signal.aborted || session.state === 'cancelled') return;
      session.state = 'failed';
      this.emit(sessionId, { sessionId, state: 'failed', error });
    }
  }

  private validateInputCapabilities(input: StartSessionInput): void {
    if (input.model || (input.profile.managed && input.profile.model)) {
      requireCapability(this.capabilities, 'model.selection', this.id);
    }
    if (input.reasoning || (input.profile.managed && input.profile.reasoning)) {
      requireCapability(this.capabilities, 'reasoning.selection', this.id);
    }
    if (
      (input.profile.managed && (input.profile.skills?.length ?? 0) > 0) ||
      (input.resources?.skills?.length ?? 0) > 0
    ) {
      requireCapability(this.capabilities, 'skills.custom', this.id);
    }
    if (
      (input.profile.managed && (input.profile.mcpServers?.length ?? 0) > 0) ||
      (input.resources?.mcpServers?.length ?? 0) > 0
    ) {
      requireCapability(this.capabilities, 'skills.mcp', this.id);
    }
    if (input.profile.managed && (input.profile.plugins?.length ?? 0) > 0) {
      requireCapability(this.capabilities, 'skills.plugins', this.id);
    }
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    this.lastEvents.set(sessionId, event);
    for (const handler of this.subscribers.get(sessionId) ?? []) {
      handler(event);
    }
  }
}

interface AcpSessionState extends HarnessSession {
  readonly controller: AbortController;
}

export class AcpOperationalError extends Error {
  public readonly errorType: string;
  public constructor(errorType: string, message: string) {
    super(message);
    this.name = 'AcpOperationalError';
    this.errorType = errorType;
  }
}

function classifyAcpCliError(message: string): AcpOperationalError {
  const lower = message.toLowerCase();
  if (/auth|unauthorized|api[ -]?key|credential|token/.test(lower)) {
    return new AcpOperationalError('auth', message);
  }
  if (/quota|credit|billing|insufficient/.test(lower)) {
    return new AcpOperationalError('quota', message);
  }
  if (/rate.?limit|too many requests|\b429\b/.test(lower)) {
    return new AcpOperationalError('rate-limit', message);
  }
  return new AcpOperationalError('process', message);
}

function isTerminalAcpState(state: HarnessSession['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
