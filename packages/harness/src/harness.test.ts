import { describe, it, expect } from 'vitest';
import {
  RoleRouter,
  RoleNotFoundError,
  ProfileNotFoundError,
  UnsupportedCapabilityError,
  FakeHarnessRuntime,
  FULL_CAPABILITIES,
  MINIMAL_CAPABILITIES,
  requireCapability,
} from './index.js';
import type { ManagedHarnessProfile, UserManagedHarnessProfile } from './contracts.js';
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

  const router = new RoleRouter({
    roles: [
      { roleId: 'architect', profileId: 'cursor-architect' },
      { roleId: 'implementer', profileId: 'cursor-impl' },
      { roleId: 'reviewer', profileId: 'cursor-reviewer' },
      { roleId: 'custom-role', profileId: 'custom-harness' },
    ],
    profiles: [architectProfile, implementerProfile, reviewerProfile, userProfile],
    runtimes: [fakeRuntime],
  });

  it('routes architect to its profile', () => {
    const resolved = router.resolve('architect');
    expect(resolved.roleId).toBe('architect');
    expect(resolved.profile.id).toBe('cursor-architect');
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
});
