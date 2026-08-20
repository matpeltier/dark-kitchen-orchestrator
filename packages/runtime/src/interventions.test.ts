import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskId } from '@dark-kitchen/core';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import { InterventionService } from './interventions.js';

describe('InterventionService adversarial lifecycle', () => {
  let store: SqliteRuntimeStore;

  beforeEach(async () => {
    store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('deduplicates concurrent create and daemon-restart replay durably', async () => {
    const service = new InterventionService(store);
    let createdEvents = 0;
    service.subscribe((event) => {
      if (event.type === 'intervention.created') createdEvents += 1;
    });
    const input = {
      scope: 'task' as const,
      targetId: createTaskId('task-1'),
      kind: 'agent-failure' as const,
      summary: 'agent failed',
      deduplicationKey: 'run-1:agent-failure',
    };

    const created = await Promise.all([service.create(input), service.create(input)]);
    expect(created[0]?.id).toBe(created[1]?.id);
    expect(await store.listInterventions()).toHaveLength(1);
    expect(createdEvents).toBe(1);

    const restarted = new InterventionService(store);
    const replayed = await restarted.create(input);
    expect(replayed.id).toBe(created[0]?.id);
    expect(await store.listInterventions()).toHaveLength(1);
  });

  it('makes concurrent duplicate resolution first-writer-wins and emits once', async () => {
    const service = new InterventionService(store);
    const intervention = await service.create({
      scope: 'task',
      targetId: createTaskId('task-2'),
      kind: 'product-decision',
      summary: 'colour?',
      deduplicationKey: 'task-2:colour',
    });
    let resolvedEvents = 0;
    service.subscribe((event) => {
      if (event.type === 'intervention.resolved') resolvedEvents += 1;
    });

    const resolutions = await Promise.all([
      service.resolve({
        interventionId: intervention.id,
        action: 'free-text',
        answer: 'blue',
        resolvedBy: 'telegram:7',
      }),
      service.resolve({
        interventionId: intervention.id,
        action: 'free-text',
        answer: 'red',
        resolvedBy: 'telegram:8',
      }),
    ]);
    expect(resolutions[0]).toEqual(resolutions[1]);
    expect(resolutions[0]?.details).toContain('blue');
    expect(resolutions[0]?.details).not.toContain('red');
    expect(resolvedEvents).toBe(1);

    const replay = await service.resolve({
      interventionId: intervention.id,
      action: 'free-text',
      answer: 'green',
    });
    expect(replay.details).toContain('blue');
    expect(replay.details).not.toContain('green');
    expect(resolvedEvents).toBe(1);
  });

  it('round-trips a ChatGPT PM ask/reply and deduplicates request replay', async () => {
    const service = new InterventionService(store);
    const pending = service.askHuman('Which colour?', {
      requestId: 'mcp-request-42',
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    let intervention = (await store.listInterventions())[0];
    while (!intervention) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      intervention = (await store.listInterventions())[0];
    }
    await service.resolve({
      interventionId: intervention.id,
      action: 'free-text',
      answer: 'navy blue',
      resolvedBy: 'telegram:7',
    });

    await expect(pending).resolves.toEqual({
      resolved: true,
      answer: 'navy blue',
      interventionId: intervention.id,
    });
    await expect(
      service.askHuman('Which colour?', {
        requestId: 'mcp-request-42',
        timeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({
      resolved: true,
      answer: 'navy blue',
      interventionId: intervention.id,
    });
    expect(await store.listInterventions()).toHaveLength(1);
  });

  it('rejects invalid or oversized human payloads without persisting them', async () => {
    const service = new InterventionService(store);
    await expect(service.askHuman('   ')).rejects.toThrow(/empty/);
    await expect(service.askHuman('x'.repeat(16_001))).rejects.toThrow(/16000/);
    await expect(
      service.create({
        scope: 'task',
        targetId: createTaskId('task-3'),
        kind: 'manual-intervention',
        summary: 'valid',
        details: 'x'.repeat(64_001),
      }),
    ).rejects.toThrow(/details/);
    expect(await store.listInterventions()).toEqual([]);
  });

  it('keeps a timed-out ask pending and auditable for later recovery', async () => {
    const service = new InterventionService(store);
    const result = await service.askHuman('Still there?', {
      requestId: 'timeout-request',
      timeoutMs: 0,
      pollIntervalMs: 1,
    });
    expect(result.resolved).toBe(false);
    expect((await store.getIntervention(result.interventionId))?.status).toBe('open');
  });

  it('redacts credentials from durable questions and human answers', async () => {
    const service = new InterventionService(store);
    const intervention = await service.create({
      scope: 'task',
      targetId: createTaskId('task-secret'),
      kind: 'auth',
      summary: 'request failed token=super-secret',
    });
    expect(intervention.summary).not.toContain('super-secret');
    const resolved = await service.resolve({
      interventionId: intervention.id,
      action: 'free-text',
      answer: 'password=do-not-store',
    });
    expect(resolved.details).not.toContain('do-not-store');
    expect(resolved.details).toContain('[REDACTED]');
  });
});
