import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskId } from '@dark-kitchen/core';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import { InterventionService } from './interventions.js';

describe('InterventionService coalescing and replay', () => {
  let store: SqliteRuntimeStore;

  beforeEach(async () => {
    store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('coalesces active incidents of the same kind on the same target', async () => {
    const service = new InterventionService(store);
    const first = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'agent-failure',
      summary: 'PR lifecycle failed (merge-refused): Merge already in progress',
      deduplicationKey: 'lifecycle-failure:task-1:attempt-1',
    });
    const second = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'agent-failure',
      summary: 'PR lifecycle failed (merge-refused): Merge already in progress (retry)',
      deduplicationKey: 'lifecycle-failure:task-1:attempt-2',
    });

    expect(second.id).toBe(first.id);
    expect(await store.listInterventions()).toHaveLength(1);
  });

  it('creates distinct incidents for different targets or kinds', async () => {
    const service = new InterventionService(store);
    const first = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'agent-failure',
      summary: 'first',
    });
    const otherTarget = await service.create({
      scope: 'task',
      targetId: createTaskId('task-2'),
      kind: 'agent-failure',
      summary: 'other target',
    });
    const otherKind = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'quota',
      summary: 'other kind',
    });

    expect(new Set([first.id, otherTarget.id, otherKind.id]).size).toBe(3);
  });

  it('replays a terminal keyed record instead of resurrecting it', async () => {
    const service = new InterventionService(store);
    const created = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'agent-failure',
      summary: 'incident',
      deduplicationKey: 'error:task-1:exec-1',
    });
    await service.dismiss(created.id);

    const replayed = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'agent-failure',
      summary: 'incident',
      deduplicationKey: 'error:task-1:exec-1',
    });
    expect(replayed.id).toBe(created.id);
    expect(replayed.status).toBe('dismissed');
    expect(await store.listInterventions()).toHaveLength(1);
  });

  it('records who dismissed an intervention', async () => {
    const service = new InterventionService(store);
    const created = await service.create({
      scope: 'task',
      targetId: createTaskId('task-1'),
      kind: 'stuck-agent',
      summary: 'no progress',
    });

    const dismissed = await service.dismiss(created.id, { resolvedBy: 'mathieu' });
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.details).toContain('Dismissed by mathieu');
  });
});
