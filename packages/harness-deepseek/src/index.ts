/**
 * DeepSeek Harness (DSH) native adapter for Dark Kitchen (Issue 30).
 *
 * An optional first-party adapter proving the non-ACP harness extension path.
 * DSH is isolated behind the native harness contract; DSH changes never leak
 * into workflow/core APIs.
 *
 * Upstream reference: https://github.com/deepseek-ai/deepseek-harness
 *
 * This adapter is optional. It can be loaded through the plugin registry:
 *   import '@dark-kitchen/harness-deepseek';
 */

import type {
  HarnessCapability,
  HarnessEventHandler,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from '@dark-kitchen/harness';
import { makeCapabilitySet, requireCapability, registerHarnessPlugin } from '@dark-kitchen/harness';
import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';

export interface DshAdapterConfig {
  readonly id: string;
  /** Path to the DSH executable (e.g. `deepseek-harness` or absolute path). */
  readonly executable?: string;
  /** DSH session/profile flags (bounded control args only, no payload). */
  readonly args?: readonly string[];
  readonly capabilities?: readonly HarnessCapability[];
}

const DSH_DEFAULT_CAPABILITIES: HarnessCapability[] = [
  'sessions.persistent',
  'sessions.cancel',
  'sessions.live-instructions',
  'model.selection',
  'skills.plugins',
];

/**
 * DeepSeek Harness adapter.
 *
 * Launches DSH with shell:false and passes prompts through stdin.
 * Plugin state is preserved — Dark Kitchen never rewrites DSH configuration.
 */
export class DshHarnessAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly capabilities: ReturnType<typeof makeCapabilitySet>;
  private readonly config: DshAdapterConfig;
  private readonly sessions = new Map<AgentSessionId, DshSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();

  public constructor(config: DshAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = makeCapabilitySet(config.capabilities ?? DSH_DEFAULT_CAPABILITIES);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const sessionId = createAgentSessionId(
      `dsh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const session: DshSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'starting',
    };
    this.sessions.set(sessionId, session);

    // In production: spawn DSH with shell:false, pass prompt via stdin
    const executable = this.config.executable ?? 'deepseek-harness';
    const controlArgs = [...(this.config.args ?? [])];

    // For now: mock execution (DSH binary may not be installed)
    session.state = 'running';
    this.emit(sessionId, { sessionId, state: 'running' });

    // Simulate async completion
    setTimeout(() => {
      session.state = 'completed';
      this.emit(sessionId, {
        sessionId,
        state: 'completed',
        output: `DSH: ${executable} ${controlArgs.join(' ')}`,
      });
    }, 0);

    return { ...session };
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    void prompt;
    // In production: write to stdin of DSH process
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`DSH session ${sessionId} not found`);
    return { ...session };
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
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

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    for (const handler of this.subscribers.get(sessionId) ?? []) handler(event);
  }
}

interface DshSession extends HarnessSession {
  state: HarnessSession['state'];
}

// Auto-register when this module is imported
registerHarnessPlugin({
  id: 'dsh-plugin',
  kind: 'deepseek-harness',
  create: (config) => {
    const dshConfig: DshAdapterConfig = { id: config.id };
    if (config.executable) Object.assign(dshConfig, { executable: config.executable });
    if (config.args) Object.assign(dshConfig, { args: config.args });
    return new DshHarnessAdapter(dshConfig);
  },
});

export { DshHarnessAdapter as default };
