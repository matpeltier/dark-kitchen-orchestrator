/**
 * Generic local process harness adapter.
 *
 * Launches a configured executable with shell:false and passes prompt/payload
 * content through stdin (not argv), satisfying the process-execution invariant.
 * User-managed harness directories/configurations are never touched.
 */

import { spawn } from 'node:child_process';
import type { AgentSessionId, RunId, TaskId, WorkspaceId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessProfile,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapabilitySet, HarnessCapability } from './capabilities.js';
import { makeCapabilitySet, requireCapability } from './capabilities.js';

export interface NativeAdapterConfig {
  readonly id: string;
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
  public readonly capabilities: HarnessCapabilitySet;
  private readonly config: NativeAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, NativeSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();

  public constructor(config: NativeAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = makeCapabilitySet(config.capabilities ?? []);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const sessionId = createAgentSessionId(`native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const session: NativeSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'starting',
    };
    this.sessions.set(sessionId, session);

    // Spawn the process with shell:false; pass prompt via stdin
    const child = spawn(this.config.executable, [...(this.config.args ?? [])], {
      shell: false,
      cwd: this.config.cwd ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });

    // Write prompt to stdin, then close
    if (child.stdin) {
      child.stdin.write(input.prompt, 'utf8');
      child.stdin.end();
    }

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });

    child.on('close', (code) => {
      session.state = code === 0 ? 'completed' : 'failed';
      this.emit(sessionId, {
        sessionId,
        state: session.state,
        output,
        ...(code !== 0 ? { error: new Error(`Process exited with code ${code ?? 'null'}`) } : {}),
      });
    });

    Object.assign(session, { childProcess: child });
    return { ...session };
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const child = (session as NativeSession & { childProcess?: ReturnType<typeof spawn> }).childProcess;
    if (child?.stdin?.writable) {
      child.stdin.write(prompt + '\n', 'utf8');
    }
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const child = (session as NativeSession & { childProcess?: ReturnType<typeof spawn> }).childProcess;
    child?.kill('SIGTERM');
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return { ...session };
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const child = (session as NativeSession & { childProcess?: ReturnType<typeof spawn> }).childProcess;
    child?.kill('SIGKILL');
    session.state = 'cancelled';
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(handler);
    return () => { this.subscribers.get(sessionId)?.delete(handler); };
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    for (const handler of this.subscribers.get(sessionId) ?? []) {
      handler(event);
    }
  }
}

interface NativeSession extends HarnessSession {
  childProcess?: ReturnType<typeof spawn>;
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

/** Built-in plugin: generic local process adapter. */
registerHarnessPlugin({
  id: 'native-process',
  kind: 'native-process',
  create: (config) => new NativeHarnessAdapter(config),
});
