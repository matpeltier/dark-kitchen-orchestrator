import { describe, expect, it } from 'vitest';
import { FailoverHarnessRuntime, isQuotaError } from './failover-runtime.js';
import { AcpClassifiedError } from './acp-runtime-adapter.js';
import type {
  HarnessEventHandler,
  HarnessProfile,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from './contracts.js';
import {
  createAgentSessionId,
  createRunId,
  createTaskId,
  createWorkspaceId,
} from '@dark-kitchen/core';

const profile = (id: string): HarnessProfile => ({ managed: true, id, kind: id });

const sessionInput = (): StartSessionInput => ({
  prompt: 'do things',
  profile: profile('primary'),
  runId: createRunId('run-1'),
  taskId: createTaskId('task-1'),
  workspaceId: createWorkspaceId('/tmp/ws'),
});

class ScriptedRuntime implements HarnessRuntime {
  public readonly id: string;
  public readonly kind: string;
  public readonly capabilities = {
    supported: new Set(['sessions.persistent']),
  } as never;
  public readonly startedSessions: string[] = [];
  private readonly handlers = new Map<string, HarnessEventHandler>();
  private lastHandler?: HarnessEventHandler;

  public constructor(
    id: string,
    private readonly startError?: Error,
    private readonly promptError?: Error,
  ) {
    this.id = id;
    this.kind = id;
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    if (this.startError) throw this.startError;
    this.startedSessions.push(input.prompt);
    const session: HarnessSession = {
      id: createAgentSessionId(`${this.id}-${this.startedSessions.length}`),
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
    };
    return session;
  }

  public async sendPrompt(_sessionId: import('@dark-kitchen/core').AgentSessionId): Promise<void> {
    if (this.promptError) throw this.promptError;
  }

  public subscribe(
    sessionId: import('@dark-kitchen/core').AgentSessionId,
    handler: HarnessEventHandler,
  ): () => void {
    this.handlers.set(String(sessionId), handler);
    this.lastHandler = handler;
    return () => this.handlers.delete(String(sessionId));
  }

  public emitTerminalQuota(): void {
    this.lastHandler?.({
      sessionId: createAgentSessionId('internal'),
      state: 'failed',
      error: new AcpClassifiedError('quota exhausted', 'quota'),
    });
  }

  public async resumeSession(
    sessionId: import('@dark-kitchen/core').AgentSessionId,
  ): Promise<HarnessSession> {
    return {
      id: sessionId,
      runId: createRunId('run-1'),
      taskId: createTaskId('task-1'),
      workspaceId: createWorkspaceId('/tmp/ws'),
      profile: profile(this.id),
      state: 'running',
    };
  }

  public async getSession(): Promise<HarnessSession | undefined> {
    return undefined;
  }
  public async cancelSession(): Promise<void> {}
  public async stopSession(): Promise<void> {}
}

describe('isQuotaError', () => {
  it('detects AcpClassifiedError quota kind and classified strings', () => {
    expect(isQuotaError(new AcpClassifiedError('limit', 'quota'))).toBe(true);
    expect(isQuotaError(new AcpClassifiedError('limit', 'auth'))).toBe(false);
    expect(isQuotaError(new Error('usage limit reached'))).toBe(true);
    expect(isQuotaError(new Error('boom'))).toBe(false);
  });
});

describe('FailoverHarnessRuntime', () => {
  it('switches to the next candidate when start fails with a quota error', async () => {
    const primary = new ScriptedRuntime('primary', new AcpClassifiedError('quota', 'quota'));
    const fallback = new ScriptedRuntime('fallback');
    const switches: string[] = [];
    const runtime = new FailoverHarnessRuntime({
      candidates: [
        { profile: profile('primary'), runtime: primary },
        { profile: profile('fallback'), model: 'model-b', runtime: fallback },
      ],
      onSwitch: (event) =>
        switches.push(`${event.fromProfileId}->${event.toProfileId}@${String(event.toModel)}`),
    });

    const session = await runtime.startSession(sessionInput());
    expect(session.profile.id).toBe('fallback');
    expect(switches).toEqual(['primary->fallback@model-b']);
  });

  it('propagates non-quota start errors without switching', async () => {
    const primary = new ScriptedRuntime('primary', new AcpClassifiedError('denied', 'auth'));
    const fallback = new ScriptedRuntime('fallback');
    const runtime = new FailoverHarnessRuntime({
      candidates: [
        { profile: profile('primary'), runtime: primary },
        { profile: profile('fallback'), runtime: fallback },
      ],
    });

    await expect(runtime.startSession(sessionInput())).rejects.toThrow('denied');
  });

  it('throws the last error after exhausting every candidate', async () => {
    const first = new ScriptedRuntime('first', new AcpClassifiedError('q1', 'quota'));
    const second = new ScriptedRuntime('second', new AcpClassifiedError('q2', 'quota'));
    const runtime = new FailoverHarnessRuntime({
      candidates: [
        { profile: profile('first'), runtime: first },
        { profile: profile('second'), runtime: second },
      ],
    });

    await expect(runtime.startSession(sessionInput())).rejects.toThrow('q2');
  });

  it('fails over mid-session when sendPrompt hits the quota and re-prompts on the new candidate', async () => {
    const primary = new ScriptedRuntime(
      'primary',
      undefined,
      new AcpClassifiedError('quota', 'quota'),
    );
    const fallback = new ScriptedRuntime('fallback');
    const runtime = new FailoverHarnessRuntime({
      candidates: [
        { profile: profile('primary'), runtime: primary },
        { profile: profile('fallback'), runtime: fallback },
      ],
    });

    const session = await runtime.startSession(sessionInput());
    await runtime.sendPrompt(session.id, 'continue please');
    // Mid-session failover restarts the pending turn on the next candidate
    // from the pristine role-level input (the daemon passes the full turn
    // prompt as the start input).
    expect(fallback.startedSessions).toEqual(['do things']);
  });

  it('fails over when the active session reports an asynchronous quota failure', async () => {
    const primary = new ScriptedRuntime('primary');
    const fallback = new ScriptedRuntime('fallback');
    const runtime = new FailoverHarnessRuntime({
      candidates: [
        { profile: profile('primary'), runtime: primary },
        { profile: profile('fallback'), runtime: fallback },
      ],
    });

    const session = await runtime.startSession(sessionInput());
    const events: string[] = [];
    runtime.subscribe(session.id, (event) => events.push(event.state));
    primary.emitTerminalQuota();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fallback.startedSessions.length).toBeGreaterThan(0);
  });
});
