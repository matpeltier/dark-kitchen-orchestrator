import { describe, it, expect } from 'vitest';
import { VerificationService, DEFAULT_PROFILE_PROVIDERS, FIRST_PARTY_PROVIDERS } from './index.js';
import { createTaskId } from '@dark-kitchen/core';

describe('VerificationService', () => {
  it('creates a verification run', () => {
    const svc = new VerificationService();
    const taskId = createTaskId('task-1');
    const run = svc.createRun(taskId, 'web-e2e');
    expect(run.state).toBe('pending');
    expect(run.profileId).toBe('web-e2e');
    expect(run.taskId).toBe(taskId);
  });

  it('updates run state', () => {
    const svc = new VerificationService();
    const run = svc.createRun(createTaskId('task-2'), 'api-e2e');
    const updated = svc.updateRun(run.id, {
      state: 'passed',
      completedAt: new Date().toISOString(),
    });
    expect(updated.state).toBe('passed');
  });

  it('tracks blocking verification status', () => {
    const svc = new VerificationService();
    const taskId = createTaskId('task-3');

    // No runs yet → not passed
    expect(svc.isBlockingVerificationPassed(taskId, ['web-e2e'])).toBe(false);

    // Create a passing run
    const run = svc.createRun(taskId, 'web-e2e');
    svc.updateRun(run.id, { state: 'passed' });
    expect(svc.isBlockingVerificationPassed(taskId, ['web-e2e'])).toBe(true);
  });

  it('blocking fails if latest run failed', () => {
    const svc = new VerificationService();
    const taskId = createTaskId('task-4');
    const run1 = svc.createRun(taskId, 'web-e2e');
    svc.updateRun(run1.id, { state: 'passed' });
    const run2 = svc.createRun(taskId, 'web-e2e');
    svc.updateRun(run2.id, { state: 'failed' });
    // Latest run is failed → not passed
    expect(svc.isBlockingVerificationPassed(taskId, ['web-e2e'])).toBe(false);
  });

  it('lists runs by task', () => {
    const svc = new VerificationService();
    const t1 = createTaskId('task-5');
    const t2 = createTaskId('task-6');
    svc.createRun(t1, 'web-e2e');
    svc.createRun(t1, 'api-e2e');
    svc.createRun(t2, 'web-e2e');
    expect(svc.listRuns(t1)).toHaveLength(2);
    expect(svc.listRuns(t2)).toHaveLength(1);
  });
});

describe('Default profile vocabulary', () => {
  it('maps web-e2e to playwright', () => {
    expect(DEFAULT_PROFILE_PROVIDERS['web-e2e']).toBe('browser.playwright');
  });
  it('maps command-e2e to command.exec', () => {
    expect(DEFAULT_PROFILE_PROVIDERS['command-e2e']).toBe('command.exec');
  });
});

describe('First-party providers', () => {
  it('has playwright, maestro, api-http, command-exec', () => {
    const ids = FIRST_PARTY_PROVIDERS.map((p) => p.id);
    expect(ids).toContain('playwright');
    expect(ids).toContain('maestro');
    expect(ids).toContain('api-http');
    expect(ids).toContain('command-exec');
  });
});
