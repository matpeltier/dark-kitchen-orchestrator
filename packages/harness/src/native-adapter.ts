/**
 * Generic local process harness adapter.
 *
 * Launches a configured executable with shell:false and passes prompt/payload
 * content through stdin (not argv), satisfying the process-execution invariant.
 * User-managed harness directories/configurations are never touched.
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
import type { HarnessCapabilitySet, HarnessCapability } from './capabilities.js';
import {
  makeCapabilitySet,
  requireCapability,
  UnsupportedCapabilityError,
} from './capabilities.js';

export interface NativeAdapterConfig {
  readonly id: string;
  /** Adapter kind matched by profiles. Defaults to `id`. */
  readonly kind?: string;
  /** Executable path (absolute or on PATH). */
  readonly executable: string;
  /** Bounded control args only – no payload content. */
  readonly args?: readonly string[];
  /** Working directory override. */
  readonly cwd?: string;
  readonly capabilities?: readonly HarnessCapability[];
}

export class NativeHarnessAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly kind: string;
  public readonly capabilities: HarnessCapabilitySet;
  private readonly config: NativeAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, NativeSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly lastEvents = new Map<AgentSessionId, Parameters<HarnessEventHandler>[0]>();

  public constructor(config: NativeAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.kind = config.kind ?? config.id;
    const capabilities = config.capabilities ?? ['sessions.cancel'];
    for (const capability of capabilities) {
      if (capability !== 'sessions.cancel') {
        throw new UnsupportedCapabilityError(capability, config.id);
      }
    }
    this.capabilities = makeCapabilitySet(capabilities);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    this.validateInputCapabilities(input);
    const sessionId = createAgentSessionId(
      `native-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const session: NativeSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      controller: new AbortController(),
    };
    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });
    void this.runProcess(sessionId, input, session);
    return snapshotNativeSession(session);
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    this.getSessionState(sessionId);
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    void prompt;
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session || isNativeTerminalState(session.state)) return;
    session.controller.abort();
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return snapshotNativeSession(session);
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || isNativeTerminalState(session.state)) return;
    session.controller.abort();
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? snapshotNativeSession(s) : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    this.getSessionState(sessionId);
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(handler);
    const lastEvent = this.lastEvents.get(sessionId);
    if (lastEvent && isNativeTerminalState(lastEvent.state)) {
      queueMicrotask(() => {
        if (this.lastEvents.get(sessionId) === lastEvent) handler(lastEvent);
      });
    }
    return () => {
      this.subscribers.get(sessionId)?.delete(handler);
    };
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    this.lastEvents.set(sessionId, event);
    for (const handler of this.subscribers.get(sessionId) ?? []) {
      handler(event);
    }
  }

  private getSessionState(sessionId: AgentSessionId): NativeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private async runProcess(
    sessionId: AgentSessionId,
    input: StartSessionInput,
    session: NativeSession,
  ): Promise<void> {
    try {
      const result = await executeProcess({
        definition: defineProcess({
          executable: this.config.executable,
          args: (this.config.args ?? []).map(controlArgument),
          label: this.id,
        }),
        cwd: this.config.cwd ?? (input.workspaceId as string),
        payload: stdinPayload(
          input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt,
        ),
        signal: session.controller.signal,
      });
      if (session.state === 'cancelled' || session.controller.signal.aborted) return;
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
          output: stdout,
          error: new Error(stderr || `Process exited with code ${String(result.exitCode)}`),
        });
      }
    } catch (error) {
      if (session.state === 'cancelled' || session.controller.signal.aborted) return;
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
}

interface NativeSession extends HarnessSession {
  readonly controller: AbortController;
}

function isNativeTerminalState(state: HarnessSession['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function snapshotNativeSession(session: NativeSession): HarnessSession {
  return {
    id: session.id,
    runId: session.runId,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    profile: session.profile,
    state: session.state,
  };
}

// ─── Plugin registry ──────────────────────────────────────────────────────────

export interface HarnessPlugin {
  readonly id: string;
  readonly kind: string;
  create(config: NativeAdapterConfig): HarnessRuntime;
}

const pluginRegistry = new Map<string, HarnessPlugin>();

/** Register a native harness adapter plugin by kind. */
export function registerHarnessPlugin(plugin: HarnessPlugin): void {
  if (pluginRegistry.has(plugin.kind)) {
    throw new Error(`A harness plugin for kind "${plugin.kind}" is already registered.`);
  }
  pluginRegistry.set(plugin.kind, plugin);
}

/** Look up a registered plugin by kind. */
export function getHarnessPlugin(kind: string): HarnessPlugin | undefined {
  return pluginRegistry.get(kind);
}

/** List all registered plugin kinds. */
export function listHarnessPluginKinds(): string[] {
  return Array.from(pluginRegistry.keys());
}

export class HarnessPluginNotAllowedError extends Error {
  public constructor(moduleReference: string) {
    super(`Harness plugin module "${moduleReference}" is not in the explicit allowlist.`);
    this.name = 'HarnessPluginNotAllowedError';
  }
}

/**
 * Load a third-party adapter only after an exact module-reference allowlist
 * check. A module may export `harnessPlugin`/`default` or self-register for
 * compatibility with first-party adapter packages.
 */
export async function loadAllowedHarnessPlugin(
  moduleReference: string,
  allowedModuleReferences: readonly string[],
): Promise<HarnessPlugin> {
  if (!allowedModuleReferences.includes(moduleReference)) {
    throw new HarnessPluginNotAllowedError(moduleReference);
  }

  const before = new Set(pluginRegistry.keys());
  const loaded = (await import(moduleReference)) as {
    readonly harnessPlugin?: unknown;
    readonly default?: unknown;
  };
  const candidate = loaded.harnessPlugin ?? loaded.default;
  if (isHarnessPlugin(candidate)) {
    const existing = pluginRegistry.get(candidate.kind);
    if (existing) return existing;
    registerHarnessPlugin(candidate);
    return candidate;
  }

  const registeredKind = Array.from(pluginRegistry.keys()).find((kind) => !before.has(kind));
  if (registeredKind) return pluginRegistry.get(registeredKind)!;
  throw new Error(
    `Harness plugin module "${moduleReference}" did not export or register a HarnessPlugin.`,
  );
}

function isHarnessPlugin(value: unknown): value is HarnessPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const plugin = value as Partial<HarnessPlugin>;
  return (
    typeof plugin.id === 'string' &&
    plugin.id.length > 0 &&
    typeof plugin.kind === 'string' &&
    plugin.kind.length > 0 &&
    typeof plugin.create === 'function'
  );
}

/** Built-in plugin: generic local process adapter. */
registerHarnessPlugin({
  id: 'native-process',
  kind: 'native-process',
  create: (config) => new NativeHarnessAdapter(config),
});
