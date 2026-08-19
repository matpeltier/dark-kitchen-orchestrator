/**
 * Scripted/fake harness for deterministic tests.
 * Returns configurable responses without spawning any real process.
 */

import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessEventHandler,
  HarnessProfile,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import type { HarnessCapabilitySet } from './capabilities.js';
import { requireCapability } from './capabilities.js';

export interface FakeHarnessResponse {
  readonly output: string;
  readonly state?: 'completed' | 'failed';
  /** Delay before responding (milliseconds). */
  readonly delayMs?: number;
}

export interface FakeHarnessConfig {
  readonly id: string;
  readonly capabilities: HarnessCapabilitySet;
  /** Default response for all prompts. */
  readonly defaultResponse?: FakeHarnessResponse;
  /** Prompt-specific overrides. */
  readonly responses?: ReadonlyMap<string, FakeHarnessResponse>;
}

export class FakeHarnessRuntime implements HarnessRuntime {
  public readonly id: string;
  public readonly capabilities: HarnessCapabilitySet;
  private readonly config: FakeHarnessConfig;
  private readonly sessions = new Map<AgentSessionId, FakeSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();

  public constructor(config: FakeHarnessConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = config.capabilities;
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    const sessionId = createAgentSessionId(`fake-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const session: FakeSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
    };
    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });

    const response = this.config.responses?.get(input.prompt) ?? this.config.defaultResponse;
    if (response) {
      const delay = response.delayMs ?? 0;
      setTimeout(() => {
        session.state = response.state ?? 'completed';
        this.emit(sessionId, { sessionId, state: session.state, output: response.output });
      }, delay);
    }

    return { ...session };
  }

  public async sendPrompt(sessionId: AgentSessionId, prompt: string): Promise<void> {
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const response = this.config.responses?.get(prompt) ?? this.config.defaultResponse;
    if (response) {
      setTimeout(() => {
        this.emit(sessionId, { sessionId, state: 'completed', output: response.output });
      }, response.delayMs ?? 0);
    }
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.state = 'running';
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

interface FakeSession extends HarnessSession {
  state: HarnessSession['state'];
}
