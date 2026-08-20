import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, AgentSessionId } from '@dark-kitchen/core';
import {
  createExecutionNodeId,
  createRunId,
  createTaskId,
  createWorkspaceId,
} from '@dark-kitchen/core';
import {
  FakeHarnessRuntime,
  FULL_CAPABILITIES,
  makeCapabilitySet,
  type HarnessProfile,
} from '@dark-kitchen/harness';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import { AgentControlError, DefaultAgentControlService } from './agent-controls.js';

const profile: HarnessProfile = {
  managed: true,
  id: 'codex-default',
  kind: 'codex',
  model: 'gpt-test',
};

describe('DefaultAgentControlService', () => {
  let store: SqliteRuntimeStore;
  let runtime: FakeHarnessRuntime;
  let service: DefaultAgentControlService;

  beforeEach(async () => {
    store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    runtime = new FakeHarnessRuntime({
      id: 'runtime-codex-1',
      kind: 'codex',
      capabilities: FULL_CAPABILITIES,
    });
    service = createService(store, [runtime]);
  });

  afterEach(() => store.close());

  it('lists and inspects sessions with their exact runtime/profile metadata', async () => {
    const session = await registerSession(service, runtime, 'running');

    expect(await service.listSessions(session.runId)).toHaveLength(1);
    const inspected = await service.getAgent(session.id);
    expect(inspected).toMatchObject({
      roleId: 'implementer',
      harness: {
        runtimeId: runtime.id,
        kind: runtime.kind,
        profileId: profile.id,
        model: 'gpt-test',
      },
      controls: {
        sendInstruction: true,
        interruptAndSend: true,
        stop: true,
      },
    });
  });

  it('redacts credentials before persisting a restart prompt', async () => {
    const now = new Date().toISOString();
    const prompt = 'token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 password=hunter2';
    const started = await runtime.startSession({
      runId: createRunId('secret-run'),
      taskId: createTaskId('secret-task'),
      workspaceId: createWorkspaceId('/tmp/secret-worktree'),
      profile,
      prompt,
    });
    const session: AgentSession = {
      id: started.id,
      runId: createRunId('secret-run'),
      taskId: createTaskId('secret-task'),
      executionNodeId: createExecutionNodeId('local'),
      workspaceId: createWorkspaceId('/tmp/secret-worktree'),
      state: 'running',
      createdAt: now,
      updatedAt: now,
    };
    await service.registerSession({
      session,
      runtime,
      profile,
      roleId: 'implementer',
      initialPrompt: prompt,
    });

    const binding = await store.getAgentSessionRuntimeBinding(session.id);
    expect(binding?.initialPrompt).toContain('[REDACTED]');
    expect(binding?.initialPrompt).not.toContain('github_pat_');
    expect(binding?.initialPrompt).not.toContain('hunter2');
  });

  it('uses the runtime bound to the session rather than another registered adapter', async () => {
    const other = new FakeHarnessRuntime({
      id: 'runtime-other',
      kind: 'codex',
      capabilities: FULL_CAPABILITIES,
    });
    service = createService(store, [other, runtime]);
    const session = await registerSession(service, runtime, 'running');
    const expected = vi.spyOn(runtime, 'sendPrompt');
    const wrong = vi.spyOn(other, 'sendPrompt');

    await service.sendInstruction(session.id, 'continue');

    expect(expected).toHaveBeenCalledWith(session.id, 'continue');
    expect(wrong).not.toHaveBeenCalled();
  });

  it('negotiates send, interrupt, and stop capabilities', async () => {
    const limited = new FakeHarnessRuntime({
      id: 'runtime-limited',
      kind: 'limited',
      capabilities: makeCapabilitySet([]),
    });
    service = createService(store, [limited]);
    const session = await registerSession(service, limited, 'running', {
      managed: false,
      id: 'limited-profile',
      kind: 'limited',
    });

    await expect(service.sendInstruction(session.id, 'continue')).rejects.toThrow(
      /sessions.live-instructions/,
    );
    await expect(service.interruptAndSend(session.id, 'redirect')).rejects.toThrow(
      /sessions.cancel/,
    );
    await expect(service.stopSession(session.id)).rejects.toThrow(/sessions.cancel/);
    expect((await store.getAgentSession(session.id))?.state).toBe('running');
  });

  it('interrupts and sends guidance on the same bound session', async () => {
    const session = await registerSession(service, runtime, 'running');
    const cancel = vi.spyOn(runtime, 'cancelSession');
    const resume = vi.spyOn(runtime, 'resumeSession');
    const send = vi.spyOn(runtime, 'sendPrompt');

    await service.interruptAndSend(session.id, 'take the safer path');

    expect(cancel).toHaveBeenCalledWith(session.id);
    expect(resume).toHaveBeenCalledWith(session.id);
    expect(send).toHaveBeenCalledWith(session.id, 'take the safer path');
  });

  it('restart creates a new session with the same run, worktree, node, prompt, and profile', async () => {
    const source = await registerSession(service, runtime, 'failed');
    const start = vi.spyOn(runtime, 'startSession');

    const restarted = await service.restartSession(source.id, { requestId: 'restart-1' });

    expect(restarted.id).not.toBe(source.id);
    expect(restarted).toMatchObject({
      runId: source.runId,
      taskId: source.taskId,
      executionNodeId: source.executionNodeId,
      workspaceId: source.workspaceId,
    });
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: source.runId,
        taskId: source.taskId,
        workspaceId: source.workspaceId,
        profile,
        prompt: 'original task prompt',
        model: 'gpt-test',
      }),
    );
    expect(await store.getAgentSession(source.id)).toEqual(source);
    expect(await store.getAgentSessionRuntimeBinding(restarted.id)).toMatchObject({
      sourceSessionId: source.id,
      sourceAction: 'restart',
      runtimeId: runtime.id,
      profileId: profile.id,
    });
  });

  it('deduplicates concurrent and replayed retries, including a completion race', async () => {
    const source = await registerSession(service, runtime, 'failed');
    const start = vi.spyOn(runtime, 'startSession');

    const [first, second] = await Promise.all([
      service.retrySession(source.id, { requestId: 'retry-race' }),
      service.retrySession(source.id, { requestId: 'retry-race' }),
    ]);
    const replay = await service.retrySession(source.id, { requestId: 'retry-race' });

    expect(second.id).toBe(first.id);
    expect(replay.id).toBe(first.id);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rehydrates the exact runtime/profile binding after a daemon restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dk-agent-control-'));
    const databasePath = join(directory, 'runtime.db');
    try {
      const firstStore = await SqliteRuntimeStore.open({ databasePath });
      const firstService = createService(firstStore, [runtime]);
      const source = await registerSession(firstService, runtime, 'failed');
      firstStore.close();

      const reopenedStore = await SqliteRuntimeStore.open({ databasePath });
      const restartedService = createService(reopenedStore, [runtime]);
      const replacement = await restartedService.restartSession(source.id);

      expect(replacement.id).not.toBe(source.id);
      expect(await reopenedStore.getAgentSessionRuntimeBinding(replacement.id)).toMatchObject({
        runtimeId: runtime.id,
        profileId: profile.id,
        sourceSessionId: source.id,
      });
      reopenedStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('switches only through a configured target and creates an audited child session', async () => {
    const targetProfile: HarnessProfile = {
      managed: false,
      id: 'opencode-user',
      kind: 'opencode',
    };
    const targetRuntime = new FakeHarnessRuntime({
      id: 'runtime-opencode-1',
      kind: 'opencode',
      capabilities: FULL_CAPABILITIES,
    });
    service = new DefaultAgentControlService({
      store,
      resolveRuntime: (runtimeId) =>
        [runtime, targetRuntime].find((candidate) => candidate.id === runtimeId),
      resolveProfile: (profileId) =>
        profileId === targetProfile.id
          ? { runtime: targetRuntime, profile: targetProfile }
          : undefined,
    });
    const source = await registerSession(service, runtime, 'stopped');

    const switched = await service.switchAgentProfile(source.id, targetProfile.id);

    expect(await store.getAgentSessionRuntimeBinding(switched.id)).toMatchObject({
      runtimeId: targetRuntime.id,
      profileId: targetProfile.id,
      sourceAction: 'switch-profile',
    });
    await expect(service.switchAgentProfile(source.id, 'missing')).rejects.toThrow(/unavailable/);
  });

  it('rejects legacy unbound sessions instead of simulating a restart', async () => {
    const session = makeSession('legacy-session', 'failed');
    await store.saveAgentSession(session);

    await expect(service.restartSession(session.id)).rejects.toThrow(
      /no durable runtime binding.*not simulated/,
    );
  });

  it('persists every successful manual control in the event journal', async () => {
    const session = await registerSession(service, runtime, 'running');

    await service.sendInstruction(session.id, 'continue', { requestId: 'instruction-1' });
    await service.stopSession(session.id, { requestId: 'stop-1' });

    const events = await store.listEvents({ type: 'agent.control' });
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ action: 'send-instruction', requestId: 'instruction-1' }),
      expect.objectContaining({ action: 'stop', requestId: 'stop-1' }),
    ]);
  });

  it('refuses restart while a session is active', async () => {
    const session = await registerSession(service, runtime, 'running');
    await expect(service.restartSession(session.id)).rejects.toThrow(AgentControlError);
  });
});

function createService(
  store: SqliteRuntimeStore,
  runtimes: readonly FakeHarnessRuntime[],
): DefaultAgentControlService {
  return new DefaultAgentControlService({
    store,
    resolveRuntime: (runtimeId) => runtimes.find((runtime) => runtime.id === runtimeId),
  });
}

async function registerSession(
  service: DefaultAgentControlService,
  runtime: FakeHarnessRuntime,
  state: AgentSession['state'],
  harnessProfile: HarnessProfile = profile,
): Promise<AgentSession> {
  const started = await runtime.startSession({
    runId: createRunId('run-1'),
    taskId: createTaskId('task-1'),
    workspaceId: createWorkspaceId('/tmp/worktree-1'),
    profile: harnessProfile,
    prompt: 'original task prompt',
  });
  const session = makeSession(started.id, state);
  await service.registerSession({
    session,
    runtime,
    profile: harnessProfile,
    initialPrompt: 'original task prompt',
    roleId: 'implementer',
    ...(harnessProfile.managed && harnessProfile.model ? { model: harnessProfile.model } : {}),
  });
  return session;
}

function makeSession(id: string | AgentSessionId, state: AgentSession['state']): AgentSession {
  const now = new Date().toISOString();
  return {
    id: id as AgentSessionId,
    runId: createRunId('run-1'),
    taskId: createTaskId('task-1'),
    executionNodeId: createExecutionNodeId('node-1'),
    workspaceId: createWorkspaceId('/tmp/worktree-1'),
    state,
    createdAt: now,
    updatedAt: now,
    ...(state === 'completed' || state === 'failed' || state === 'stopped'
      ? { completedAt: now }
      : {}),
  };
}
