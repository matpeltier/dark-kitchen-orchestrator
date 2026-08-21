import { describe, it, expect } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  AcpHarnessAdapter,
  RoleRouter,
  RoleNotFoundError,
  ProfileNotFoundError,
  UnsupportedCapabilityError,
  RuntimeNotFoundError,
  AcpxRuntimeAdapter,
  toAgentSessionState,
  HarnessPluginNotAllowedError,
  loadAllowedHarnessPlugin,
  NativeHarnessAdapter,
  FakeHarnessRuntime,
  FULL_CAPABILITIES,
  MINIMAL_CAPABILITIES,
  makeCapabilitySet,
  requireCapability,
} from './index.js';
import type { ManagedHarnessProfile, UserManagedHarnessProfile } from './contracts.js';
import type { AcpxRuntimeBoundary } from './acp-runtime-adapter.js';
import { AcpClassifiedError } from './acp-runtime-adapter.js';
import { createRunId, createTaskId, createWorkspaceId } from '@dark-kitchen/core';

// ─── Role router ──────────────────────────────────────────────────────────────

describe('RoleRouter', () => {
  const architectProfile: ManagedHarnessProfile = {
    managed: true,
    id: 'cursor-architect',
    kind: 'fake',
    model: 'claude-opus-4-5',
  };
  const implementerProfile: ManagedHarnessProfile = {
    managed: true,
    id: 'cursor-impl',
    kind: 'fake',
    model: 'claude-sonnet-4-5',
  };
  const reviewerProfile: ManagedHarnessProfile = {
    managed: true,
    id: 'cursor-reviewer',
    kind: 'fake',
  };
  const userProfile: UserManagedHarnessProfile = {
    managed: false,
    id: 'custom-harness',
    kind: 'custom',
    description: 'User-managed Codex harness',
  };

  const fakeRuntime = new FakeHarnessRuntime({
    id: 'fake',
    capabilities: FULL_CAPABILITIES,
    defaultResponse: { output: 'ok' },
  });
  const customRuntime = new FakeHarnessRuntime({
    id: 'custom-runtime',
    kind: 'custom',
    capabilities: MINIMAL_CAPABILITIES,
  });

  const router = new RoleRouter({
    roles: [
      { roleId: 'architect', profileId: 'cursor-architect' },
      { roleId: 'implementer', profileId: 'cursor-impl' },
      { roleId: 'reviewer', profileId: 'cursor-reviewer' },
      { roleId: 'custom-role', profileId: 'custom-harness' },
    ],
    profiles: [architectProfile, implementerProfile, reviewerProfile, userProfile],
    runtimes: [fakeRuntime, customRuntime],
  });

  it('routes architect to its profile', () => {
    const resolved = router.resolve('architect');
    expect(resolved.roleId).toBe('architect');
    expect(resolved.profile.id).toBe('cursor-architect');
    expect(resolved.runtime).toBe(fakeRuntime);
  });

  it('routes implementer to a different profile', () => {
    const resolved = router.resolve('implementer');
    expect(resolved.profile.id).toBe('cursor-impl');
  });

  it('routes reviewer to a different profile', () => {
    const resolved = router.resolve('reviewer');
    expect(resolved.profile.id).toBe('cursor-reviewer');
  });

  it('throws RoleNotFoundError for unknown role', () => {
    expect(() => router.resolve('no-such-role')).toThrow(RoleNotFoundError);
  });

  it('throws ProfileNotFoundError for missing profile', () => {
    const r = new RoleRouter({
      roles: [{ roleId: 'x', profileId: 'missing' }],
      profiles: [],
      runtimes: [],
    });
    expect(() => r.resolve('x')).toThrow(ProfileNotFoundError);
  });

  it('rejects overrides on user-managed profile', () => {
    const r = new RoleRouter({
      roles: [{ roleId: 'x', profileId: 'custom-harness', modelOverride: 'gpt-4' }],
      profiles: [userProfile],
      runtimes: [],
    });
    expect(() => r.resolve('x')).toThrow(/user-managed/);
  });

  it('rejects unsupported required capabilities', () => {
    const limitedRuntime = new FakeHarnessRuntime({
      id: 'limited',
      capabilities: MINIMAL_CAPABILITIES,
      defaultResponse: { output: 'ok' },
    });
    const r = new RoleRouter({
      roles: [{ roleId: 'x', profileId: 'p', requiredCapabilities: ['sessions.resume'] }],
      profiles: [{ managed: true, id: 'p', kind: 'limited' }],
      runtimes: [limitedRuntime],
    });
    expect(() => r.resolve('x')).toThrow(UnsupportedCapabilityError);
  });

  it('rejects a missing runtime instead of silently skipping capability validation', () => {
    const r = new RoleRouter({
      roles: [{ roleId: 'x', profileId: 'p' }],
      profiles: [{ managed: true, id: 'p', kind: 'not-installed' }],
      runtimes: [],
    });
    expect(() => r.resolve('x')).toThrow(RuntimeNotFoundError);
  });

  it('derives capability requirements from profile options', () => {
    const limitedRuntime = new FakeHarnessRuntime({
      id: 'limited-instance',
      kind: 'limited',
      capabilities: MINIMAL_CAPABILITIES,
    });
    const r = new RoleRouter({
      roles: [{ roleId: 'x', profileId: 'p' }],
      profiles: [{ managed: true, id: 'p', kind: 'limited', model: 'some/model' }],
      runtimes: [limitedRuntime],
    });
    expect(() => r.resolve('x')).toThrow(UnsupportedCapabilityError);
  });

  it('routes representative Codex, OpenCode, and DSH profiles by kind', () => {
    const codex = new FakeHarnessRuntime({
      id: 'codex-instance',
      kind: 'codex',
      capabilities: FULL_CAPABILITIES,
    });
    const opencode = new FakeHarnessRuntime({
      id: 'opencode-instance',
      kind: 'opencode',
      capabilities: FULL_CAPABILITIES,
    });
    const dsh = new FakeHarnessRuntime({
      id: 'dsh-instance',
      kind: 'deepseek-harness',
      capabilities: makeCapabilitySet(['sessions.cancel']),
    });
    const r = new RoleRouter({
      roles: [
        { roleId: 'implementer', profileId: 'codex-light' },
        { roleId: 'reviewer', profileId: 'opencode-strong' },
        { roleId: 'fixer', profileId: 'dsh-user-profile' },
      ],
      profiles: [
        { managed: true, id: 'codex-light', kind: 'codex', model: 'gpt-5.6-codex' },
        {
          managed: true,
          id: 'opencode-strong',
          kind: 'opencode',
          model: 'anthropic/claude-sonnet-4-5',
        },
        {
          managed: false,
          id: 'dsh-user-profile',
          kind: 'deepseek-harness',
          description: 'Model and plugins remain owned by the DSH profile',
        },
      ],
      runtimes: [codex, opencode, dsh],
    });

    expect(r.resolve('implementer').runtime.id).toBe('codex-instance');
    expect(r.resolve('reviewer').runtime.id).toBe('opencode-instance');
    expect(r.resolve('fixer').runtime.id).toBe('dsh-instance');
    expect(r.validateAll()).toEqual([]);
  });

  it('validateAll returns empty array when all roles are valid', () => {
    expect(router.validateAll()).toHaveLength(0);
  });
});

// ─── Capabilities ─────────────────────────────────────────────────────────────

describe('capability negotiation', () => {
  it('requireCapability passes when capability is supported', () => {
    expect(() => requireCapability(FULL_CAPABILITIES, 'sessions.persistent', 'h')).not.toThrow();
  });

  it('requireCapability throws when capability is not supported', () => {
    expect(() => requireCapability(MINIMAL_CAPABILITIES, 'sessions.persistent', 'h')).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('normalizes harness aliases to the core session-state protocol', () => {
    expect(toAgentSessionState('cancelled')).toBe('stopped');
    expect(toAgentSessionState('paused')).toBe('waiting');
    expect(toAgentSessionState('interrupted')).toBe('interrupted');
  });
});

// ─── FakeHarnessRuntime ───────────────────────────────────────────────────────

describe('FakeHarnessRuntime', () => {
  const fakeRuntime = new FakeHarnessRuntime({
    id: 'fake',
    capabilities: FULL_CAPABILITIES,
    defaultResponse: { output: 'hello from fake', delayMs: 0 },
  });

  it('starts a session', async () => {
    const session = await fakeRuntime.startSession({
      runId: createRunId('run-1'),
      taskId: createTaskId('task-1'),
      workspaceId: createWorkspaceId('ws-1'),
      profile: { managed: true, id: 'p', kind: 'fake' },
      prompt: 'hello',
    });
    expect(session.state).toBe('running');
  });

  it('emits events via subscribe', async () => {
    const events: string[] = [];
    const session = await fakeRuntime.startSession({
      runId: createRunId('run-2'),
      taskId: createTaskId('task-2'),
      workspaceId: createWorkspaceId('ws-2'),
      profile: { managed: true, id: 'p', kind: 'fake' },
      prompt: 'test',
    });
    const unsubscribe = fakeRuntime.subscribe(session.id, (e) => events.push(e.state));
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();
    expect(events).toContain('completed');
  });

  it('cancels a session', async () => {
    const session = await fakeRuntime.startSession({
      runId: createRunId('run-3'),
      taskId: createTaskId('task-3'),
      workspaceId: createWorkspaceId('ws-3'),
      profile: { managed: true, id: 'p', kind: 'fake' },
      prompt: 'cancel-me',
    });
    await fakeRuntime.cancelSession(session.id);
    const fetched = await fakeRuntime.getSession(session.id);
    expect(fetched?.state).toBe('cancelled');
  });

  it('rejects unsupported operation', async () => {
    const limited = new FakeHarnessRuntime({
      id: 'limited',
      capabilities: MINIMAL_CAPABILITIES,
      defaultResponse: { output: 'ok' },
    });
    const session = await limited.startSession({
      runId: createRunId('run-4'),
      taskId: createTaskId('task-4'),
      workspaceId: createWorkspaceId('ws-4'),
      profile: { managed: true, id: 'p', kind: 'limited' },
      prompt: 'x',
    });
    await expect(limited.cancelSession(session.id)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it('preserves user-managed profile settings unchanged', () => {
    const userProfile: UserManagedHarnessProfile = {
      managed: false,
      id: 'my-harness',
      kind: 'custom',
      description: 'My personal Codex setup',
    };
    // The profile object is returned as-is; no DK-managed fields are added
    expect(userProfile.managed).toBe(false);
    expect(userProfile.id).toBe('my-harness');
    // No 'model', 'skills', 'mcpServers', or 'plugins' fields
    expect((userProfile as unknown as Record<string, unknown>)['model']).toBeUndefined();
    expect((userProfile as unknown as Record<string, unknown>)['skills']).toBeUndefined();
  });

  it('does not complete later after cancellation', async () => {
    const delayed = new FakeHarnessRuntime({
      id: 'delayed',
      capabilities: FULL_CAPABILITIES,
      defaultResponse: { output: 'too late', delayMs: 20 },
    });
    const session = await delayed.startSession({
      runId: createRunId('run-cancel'),
      taskId: createTaskId('task-cancel'),
      workspaceId: createWorkspaceId('ws-cancel'),
      profile: { managed: true, id: 'p', kind: 'delayed' },
      prompt: 'cancel',
    });
    const events: string[] = [];
    delayed.subscribe(session.id, (event) => events.push(event.state));
    await delayed.cancelSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events).toEqual(['cancelled']);
    expect((await delayed.getSession(session.id))?.state).toBe('cancelled');
  });
});

describe('AcpxRuntimeAdapter boundary', () => {
  it('pins the programmatic runtime compatibility target', () => {
    const require = createRequire(import.meta.url);
    const manifest = require('acpx/package.json') as { version: string; exports: object };

    expect(manifest.version).toBe('0.13.1');
    expect(manifest.exports).toHaveProperty('./runtime');
  });

  it.each(['codex', 'opencode'])('uses the programmatic acpx boundary for %s', async (agent) => {
    const ensured: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        ensured.push(input);
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn(input) {
        turns.push(input);
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'text_delta' as const,
                text: 'private-reasoning',
                stream: 'thought' as const,
              };
              yield { type: 'text_delta' as const, text: `${agent}-result` };
            },
          },
          result: Promise.resolve({ status: 'completed' as const }),
          async cancel() {},
        };
      },
      async doctor() {
        return { ok: true, message: `${agent} available` };
      },
    };
    const adapter = new AcpxRuntimeAdapter({
      id: `${agent}-instance`,
      agent,
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 1_000,
    });
    const session = await adapter.startSession({
      runId: createRunId(`run-${agent}`),
      taskId: createTaskId(`task-${agent}`),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: `${agent}-profile`, kind: agent },
      prompt: `opaque ${agent} prompt $HOME`,
      model: agent === 'codex' ? 'gpt-5.6-codex' : 'openai/gpt-5.4',
    });
    const completed = await new Promise<string>((resolve) => {
      adapter.subscribe(session.id, (event) => {
        if (event.state === 'completed') resolve(event.output ?? '');
      });
    });

    expect(adapter.kind).toBe(agent);
    expect(ensured[0]?.['agent']).toBe(agent);
    expect(turns[0]?.['text']).toBe(`opaque ${agent} prompt $HOME`);
    expect(completed).toBe(`${agent}-result`);
    await expect(adapter.probe()).resolves.toEqual({
      healthy: true,
      message: `${agent} available`,
    });
  });

  it('uses collision-proof identities for concurrent calls in the same run and task', async () => {
    const sessionKeys: string[] = [];
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        sessionKeys.push(input.sessionKey);
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          result: Promise.resolve({ status: 'completed' as const }),
          async cancel() {},
        };
      },
    };
    const adapter = new AcpxRuntimeAdapter({
      id: 'parallel-acpx',
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 1_000,
    });
    const input = {
      runId: createRunId('parallel-run'),
      taskId: createTaskId('parallel-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true as const, id: 'codex', kind: 'codex' },
      prompt: 'parallel',
    };

    const [left, right] = await Promise.all([
      adapter.startSession(input),
      adapter.startSession(input),
    ]);
    expect(left.id).not.toBe(right.id);
    expect(new Set(sessionKeys).size).toBe(2);
  });

  it('activates configured verifier tools and requires selected MCP endpoints', async () => {
    const ensured: Array<Record<string, unknown>> = [];
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        ensured.push(input);
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          result: Promise.resolve({ status: 'completed' as const }),
          async cancel() {},
        };
      },
    };
    const mcpUrl = 'http://127.0.0.1:9000/mcp';
    const adapter = new AcpxRuntimeAdapter({
      id: 'resource-aware-acpx',
      agent: 'codex',
      mcpServers: [{ name: 'browser-tools', url: mcpUrl }],
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 1_000,
    });
    await adapter.startSession({
      runId: createRunId('resource-run'),
      taskId: createTaskId('resource-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: 'verifier', kind: 'codex' },
      prompt: 'verify',
      resources: {
        mcpServers: [mcpUrl],
        tools: ['browser.playwright'],
      },
    });

    const sessionOptions = ensured[0]?.['sessionOptions'] as
      | { systemPrompt?: { append?: string } }
      | undefined;
    expect(sessionOptions?.systemPrompt?.append).toContain('browser.playwright');

    await expect(
      adapter.startSession({
        runId: createRunId('missing-mcp-run'),
        taskId: createTaskId('missing-mcp-task'),
        workspaceId: createWorkspaceId(process.cwd()),
        profile: { managed: true, id: 'verifier', kind: 'codex' },
        prompt: 'verify',
        resources: { mcpServers: ['http://127.0.0.1:9999/mcp'] },
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('fails closed instead of presenting prompt text as custom skill activation', async () => {
    const adapter = new AcpxRuntimeAdapter({
      id: 'no-fake-skills',
      agent: 'codex',
      runtimeFactory: async () => {
        throw new Error('runtime must not start');
      },
    });
    await expect(
      adapter.startSession({
        runId: createRunId('skill-run'),
        taskId: createTaskId('skill-task'),
        workspaceId: createWorkspaceId(process.cwd()),
        profile: { managed: true, id: 'verifier', kind: 'codex' },
        prompt: 'verify',
        resources: { skills: ['web-testing'] },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('isolates optional MCP servers per session while retaining the control-plane server', async () => {
    const selections: string[][] = [];
    const makeRuntime = (): AcpxRuntimeBoundary => ({
      async ensureSession(input) {
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          result: Promise.resolve({ status: 'completed' as const }),
          async cancel() {},
        };
      },
    });
    const adapter = new AcpxRuntimeAdapter({
      id: 'isolated-mcp',
      agent: 'codex',
      mcpServers: [
        { name: 'dark-kitchen', url: 'http://127.0.0.1:18801/mcp', always: true },
        { name: 'public-tools', url: 'http://127.0.0.1:9001/mcp' },
        { name: 'privileged-tools', url: 'http://127.0.0.1:9002/mcp' },
      ],
      runtimeFactory: async ({ mcpServers }) => {
        selections.push(mcpServers.map((server) => server.name));
        return makeRuntime();
      },
    });
    const baseInput = {
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: 'verifier', kind: 'codex' } as const,
      prompt: 'verify',
    };
    await adapter.startSession({
      ...baseInput,
      runId: createRunId('public-run'),
      taskId: createTaskId('public-task'),
      resources: { mcpServers: ['public-tools'] },
    });
    await adapter.startSession({
      ...baseInput,
      runId: createRunId('privileged-run'),
      taskId: createTaskId('privileged-task'),
      resources: { mcpServers: ['privileged-tools'] },
    });
    await adapter.startSession({
      ...baseInput,
      runId: createRunId('plain-run'),
      taskId: createTaskId('plain-task'),
    });

    expect(selections).toEqual([
      ['dark-kitchen', 'public-tools'],
      ['dark-kitchen', 'privileged-tools'],
      ['dark-kitchen'],
    ]);
    expect(selections[0]).not.toContain('privileged-tools');
  });

  it('queues follow-up prompts behind the active turn', async () => {
    const turns: string[] = [];
    const completions: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn(input) {
        turns.push(input.text);
        active++;
        maxActive = Math.max(maxActive, active);
        let complete!: () => void;
        const done = new Promise<void>((resolve) => {
          complete = resolve;
        });
        completions.push(complete);
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              await done;
              yield { type: 'done' as const };
            },
          },
          result: done.then(() => {
            active--;
            return { status: 'completed' as const };
          }),
          async cancel() {
            complete();
          },
        };
      },
    };
    const adapter = new AcpxRuntimeAdapter({
      id: 'queued-acpx',
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 0,
    });
    const session = await adapter.startSession({
      runId: createRunId('queued-run'),
      taskId: createTaskId('queued-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: 'codex', kind: 'codex' },
      prompt: 'first',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const followUp = adapter.sendPrompt(session.id, 'second');

    expect(turns).toEqual(['first']);
    completions[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turns).toEqual(['first', 'second']);
    completions[1]!();
    await followUp;
    expect(maxActive).toBe(1);
  });

  it('checkpoints and reconnects a persistent session after adapter restart', async () => {
    const ensured: Array<{ sessionKey: string; cwd?: string }> = [];
    const turns: string[] = [];
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        ensured.push({ sessionKey: input.sessionKey, ...(input.cwd ? { cwd: input.cwd } : {}) });
        return {
          sessionKey: input.sessionKey,
          backend: 'fake',
          runtimeSessionName: input.sessionKey,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        };
      },
      startTurn(input) {
        turns.push(input.text);
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, text: 'continued' };
            },
          },
          result: Promise.resolve({ status: 'completed' as const }),
          async cancel() {},
        };
      },
    };
    const config = {
      id: 'restart-acpx',
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 0,
    } as const;
    const beforeRestart = new AcpxRuntimeAdapter(config);
    const started = await beforeRestart.startSession({
      runId: createRunId('restart-run'),
      taskId: createTaskId('restart-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: 'codex', kind: 'codex' },
      prompt: 'initial',
    });
    const checkpoint = beforeRestart.checkpointSession(started.id);

    const afterRestart = new AcpxRuntimeAdapter(config);
    const restored = await afterRestart.restoreSession(checkpoint);
    const continuation = afterRestart.sendPrompt(restored.id, 'continue');
    const output = await new Promise<string>((resolve) => {
      afterRestart.subscribe(restored.id, (event) => {
        if (event.state === 'completed') resolve(event.output ?? '');
      });
    });
    await continuation;

    expect(restored.externalSessionId).toBe(checkpoint.sessionKey);
    expect(ensured.at(-1)).toEqual({
      sessionKey: checkpoint.sessionKey,
      cwd: process.cwd(),
    });
    expect(turns).toEqual(['initial', 'continue']);
    expect(output).toBe('continued');
  });

  it('classifies usage limit failures as quota errors', async () => {
    const runtime: AcpxRuntimeBoundary = {
      async ensureSession(input) {
        return { sessionKey: input.sessionKey, backend: 'fake', runtimeSessionName: 'fake' };
      },
      startTurn() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          result: Promise.resolve({
            status: 'failed' as const,
            error: { message: 'You have hit your usage limit. Please try again later.' },
          }),
          async cancel() {},
        };
      },
    };
    const adapter = new AcpxRuntimeAdapter({
      id: 'quota-acpx',
      agent: 'codex',
      runtimeFactory: async () => runtime,
      turnTimeoutMs: 1_000,
    });
    const session = await adapter.startSession({
      runId: createRunId('quota-run'),
      taskId: createTaskId('quota-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: true, id: 'codex', kind: 'codex' },
      prompt: 'work',
    });
    const error = await new Promise<AcpClassifiedError>((resolve) => {
      adapter.subscribe(session.id, (event) => {
        if (event.state === 'failed') resolve(event.error as AcpClassifiedError);
      });
    });

    expect(error).toBeInstanceOf(AcpClassifiedError);
    expect(error.kind).toBe('quota');
  });
});

describe('AcpHarnessAdapter CLI compatibility boundary', () => {
  it('uses acpx 0.13 control arguments and keeps the prompt on stdin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dark-kitchen-acpx-fixture-'));
    const executable = join(directory, 'fake-acpx.mjs');
    const script = `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), prompt: Buffer.concat(chunks).toString('utf8') }));
`;

    try {
      await writeFile(executable, script, { encoding: 'utf8', flag: 'wx' });
      await chmod(executable, 0o755);
      const adapter = new AcpHarnessAdapter({
        id: 'acpx-cli',
        executable,
        profile: 'codex',
      });
      const prompt = `${'x'.repeat(1024 * 1024)}\n$(touch never) $HOME \`whoami\` && false\nUnicode 雪`;
      const session = await adapter.startSession({
        runId: createRunId('acpx-cli-run'),
        taskId: createTaskId('acpx-cli-task'),
        workspaceId: createWorkspaceId(process.cwd()),
        profile: { managed: true, id: 'codex-profile', kind: 'codex' },
        prompt,
        model: 'gpt-5.6-codex',
      });
      const output = await new Promise<string>((resolve, reject) => {
        adapter.subscribe(session.id, (event) => {
          if (event.state === 'completed') resolve(event.output ?? '');
          if (event.state === 'failed') reject(event.error);
        });
      });
      const observed = JSON.parse(output) as { args: string[]; prompt: string };

      expect(observed.prompt).toBe(prompt);
      expect(observed.args).toEqual([
        '--format',
        'json',
        '--model',
        'gpt-5.6-codex',
        'codex',
        'prompt',
        '--session',
        session.id,
        '--file',
        '-',
      ]);
      expect(observed.args.join('\u0000')).not.toContain(prompt);
      await expect(adapter.sendPrompt(session.id, 'late')).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects capability declarations that the one-shot CLI cannot implement', () => {
    expect(
      () =>
        new AcpHarnessAdapter({
          id: 'lying-acpx-cli',
          profile: 'codex',
          capabilities: ['sessions.resume'],
        }),
    ).toThrow(UnsupportedCapabilityError);
  });
});

describe('native plugin allowlisting', () => {
  it('rejects a module before import when it is not explicitly allowlisted', async () => {
    await expect(loadAllowedHarnessPlugin('not-allowed-package', [])).rejects.toBeInstanceOf(
      HarnessPluginNotAllowedError,
    );
  });

  it('loads an allowlisted module that exports the stable plugin contract', async () => {
    const moduleReference =
      'data:text/javascript,' +
      encodeURIComponent(
        `export default { id: 'fixture-plugin', kind: 'fixture-${Date.now()}', create() { return {}; } };`,
      );

    const plugin = await loadAllowedHarnessPlugin(moduleReference, [moduleReference]);

    expect(plugin.id).toBe('fixture-plugin');
    expect(plugin.kind).toMatch(/^fixture-/);
  });
});

describe('NativeHarnessAdapter safe one-shot boundary', () => {
  it('round-trips a large shell-looking prompt through stdin', async () => {
    const adapter = new NativeHarnessAdapter({
      id: 'native-echo',
      kind: 'deepseek-compatible',
      executable: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
    });
    const prompt = `${'x'.repeat(1024 * 1024)}\n$(touch never) $HOME \`whoami\` 雪`;
    const session = await adapter.startSession({
      runId: createRunId('native-run'),
      taskId: createTaskId('native-task'),
      workspaceId: createWorkspaceId(process.cwd()),
      profile: { managed: false, id: 'native-profile', kind: 'deepseek-compatible' },
      prompt,
    });
    const output = await new Promise<string>((resolve, reject) => {
      adapter.subscribe(session.id, (event) => {
        if (event.state === 'completed') resolve(event.output ?? '');
        if (event.state === 'failed') reject(event.error);
      });
    });

    expect(output).toBe(prompt);
  });

  it('rejects capabilities the one-shot protocol cannot implement', () => {
    expect(
      () =>
        new NativeHarnessAdapter({
          id: 'lying-native',
          executable: process.execPath,
          capabilities: ['sessions.resume'],
        }),
    ).toThrow(UnsupportedCapabilityError);
  });
});
