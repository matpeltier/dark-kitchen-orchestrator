/**
 * Agent and run control services.
 *
 * Exposes operational controls (send instruction, interrupt, stop, restart,
 * retry, pause/resume, switch harness) through Dark Kitchen services without
 * requiring terminal access.
 */

import type { AgentSession, AgentSessionId, RunId, RuntimeStore } from '@dark-kitchen/core';
import type { HarnessRuntime } from '@dark-kitchen/harness';
import { UnsupportedCapabilityError } from '@dark-kitchen/harness';

export interface AgentControlService {
  listSessions(runId: RunId): Promise<readonly AgentSession[]>;
  getSession(sessionId: AgentSessionId): Promise<AgentSession | undefined>;
  sendInstruction(sessionId: AgentSessionId, instruction: string): Promise<void>;
  interruptAndSend(sessionId: AgentSessionId, instruction: string): Promise<void>;
  stopSession(sessionId: AgentSessionId): Promise<void>;
  restartSession(sessionId: AgentSessionId): Promise<AgentSession>;
}

export class AgentControlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentControlError';
  }
}

export class DefaultAgentControlService implements AgentControlService {
  private readonly store: RuntimeStore;
  private readonly getRuntime: (kind: string) => HarnessRuntime | undefined;
  private readonly controlLog: Array<{ sessionId: string; action: string; at: string }> = [];

  public constructor(
    store: RuntimeStore,
    getRuntime: (kind: string) => HarnessRuntime | undefined,
  ) {
    this.store = store;
    this.getRuntime = getRuntime;
  }

  public async listSessions(runId: RunId): Promise<readonly AgentSession[]> {
    // In production, this would query sessions by run from the store.
    // For now, return empty (sessions are found by explicit ID).
    void runId;
    return [];
  }

  public async getSession(sessionId: AgentSessionId): Promise<AgentSession | undefined> {
    return this.store.getAgentSession(sessionId);
  }

  public async sendInstruction(sessionId: AgentSessionId, instruction: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const runtime = this.requireRuntime(session.state);

    if (!runtime.capabilities.supported.has('sessions.live-instructions')) {
      throw new UnsupportedCapabilityError('sessions.live-instructions', 'runtime');
    }

    await runtime.sendPrompt(sessionId, instruction);
    this.log(sessionId, `sendInstruction: "${instruction.slice(0, 80)}..."`);
  }

  public async interruptAndSend(sessionId: AgentSessionId, instruction: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const runtime = this.requireRuntime(session.state);

    if (!runtime.capabilities.supported.has('sessions.cancel')) {
      throw new UnsupportedCapabilityError('sessions.cancel', 'runtime');
    }
    if (!runtime.capabilities.supported.has('sessions.live-instructions')) {
      throw new UnsupportedCapabilityError('sessions.live-instructions', 'runtime');
    }

    await runtime.cancelSession(sessionId);
    await runtime.sendPrompt(sessionId, instruction);
    this.log(sessionId, `interruptAndSend: "${instruction.slice(0, 80)}..."`);
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = await this.requireSession(sessionId);
    const runtime = this.requireRuntime(session.state);
    await runtime.stopSession(sessionId);
    this.log(sessionId, 'stop');
  }

  public async restartSession(sessionId: AgentSessionId): Promise<AgentSession> {
    const session = await this.requireSession(sessionId);
    if (session.state === 'running' || session.state === 'waiting') {
      throw new AgentControlError(
        `Cannot restart session ${sessionId} in state "${session.state}" — stop it first.`,
      );
    }
    // Session record is preserved; in production, a new harness session would be started.
    this.log(sessionId, 'restart');
    return session;
  }

  public getControlLog(): ReadonlyArray<{ sessionId: string; action: string; at: string }> {
    return this.controlLog;
  }

  private async requireSession(sessionId: AgentSessionId): Promise<AgentSession> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) throw new AgentControlError(`Session ${sessionId} not found`);
    return session;
  }

  private requireRuntime(_state: string): HarnessRuntime {
    // In production, look up by profile/kind from session metadata.
    const rt = this.getRuntime('default');
    if (!rt) throw new AgentControlError('No runtime found for session');
    return rt;
  }

  private log(sessionId: string, action: string): void {
    this.controlLog.push({ sessionId, action, at: new Date().toISOString() });
  }
}
