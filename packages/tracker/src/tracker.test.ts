import { describe, it, expect } from 'vitest';
import {
  MockTrackerAdapter,
  CyclicDependencyError,
  wouldCreateCycle,
} from './index.js';
import { createTaskId, createTaskDependencyId } from '@dark-kitchen/core';

// ─── Shared adapter contract tests ───────────────────────────────────────────

describe('MockTrackerAdapter - shared contract', () => {
  it('creates a task', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'My task' });
    expect(task.title).toBe('My task');
    expect(task.status).toBe('backlog');
  });

  it('round-trips task CRUD', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'T1' });
    const updated = await adapter.updateTask(task.id, { title: 'T1 updated' });
    expect(updated.title).toBe('T1 updated');
    const closed = await adapter.closeTask(task.id);
    expect(closed.status).toBe('completed');
    const reopened = await adapter.reopenTask(task.id);
    expect(reopened.status).toBe('backlog');
  });

  it('adds a comment without leaking into issue body', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'C1' });
    const n = parseInt(task.trackerReference!.id, 10);
    await adapter.addComment({ taskId: task.id, body: 'Great work' });
    const comments = adapter.getComments(n);
    expect(comments).toContain('Great work');
    // Verify issue body is unchanged
    const fetched = await adapter.getTaskById(task.id);
    expect(fetched?.description).toBeUndefined();
  });

  it('adds and removes a blocker dependency', async () => {
    const adapter = new MockTrackerAdapter();
    const taskA = await adapter.createTask({ projectId: 'mock-project' as never, title: 'A' });
    const taskB = await adapter.createTask({ projectId: 'mock-project' as never, title: 'B' });
    const dep = await adapter.addDependency({ taskId: taskB.id, dependsOnTaskId: taskA.id });
    const deps = await adapter.listDependencies(taskB.id);
    expect(deps).toContainEqual(expect.objectContaining({ taskId: taskB.id, dependsOnTaskId: taskA.id }));
    await adapter.removeDependency(dep.id);
    const depsAfter = await adapter.listDependencies(taskB.id);
    expect(depsAfter.filter((d) => d.id === dep.id)).toHaveLength(0);
  });

  it('rejects cyclic dependency', async () => {
    const adapter = new MockTrackerAdapter();
    const taskA = await adapter.createTask({ projectId: 'mock-project' as never, title: 'A' });
    const taskB = await adapter.createTask({ projectId: 'mock-project' as never, title: 'B' });
    const taskC = await adapter.createTask({ projectId: 'mock-project' as never, title: 'C' });
    await adapter.addDependency({ taskId: taskB.id, dependsOnTaskId: taskA.id });
    await adapter.addDependency({ taskId: taskC.id, dependsOnTaskId: taskB.id });
    // A depends on C would create A->B->C->A cycle
    await expect(
      adapter.addDependency({ taskId: taskA.id, dependsOnTaskId: taskC.id }),
    ).rejects.toBeInstanceOf(CyclicDependencyError);
  });

  it('does NOT inject dependency text into issue bodies', async () => {
    const adapter = new MockTrackerAdapter();
    const taskA = await adapter.createTask({ projectId: 'mock-project' as never, title: 'A' });
    const taskB = await adapter.createTask({ projectId: 'mock-project' as never, title: 'B' });
    await adapter.addDependency({ taskId: taskB.id, dependsOnTaskId: taskA.id });
    const fetched = await adapter.getTaskById(taskB.id);
    // Body must NOT contain "Depends on #..." text
    expect(fetched?.description ?? '').not.toMatch(/depends on/i);
  });

  it('lists all tasks', async () => {
    const adapter = new MockTrackerAdapter();
    await adapter.createTask({ projectId: 'mock-project' as never, title: 'T1' });
    await adapter.createTask({ projectId: 'mock-project' as never, title: 'T2' });
    const tasks = await adapter.listTasks('mock-project' as never);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── wouldCreateCycle ─────────────────────────────────────────────────────────

describe('wouldCreateCycle', () => {
  it('detects a direct cycle', () => {
    const taskA = createTaskId('a');
    const taskB = createTaskId('b');
    const deps = new Map([[taskA, new Set([taskB])]]);
    expect(wouldCreateCycle(deps, taskB, taskA)).toBe(true);
  });

  it('detects a transitive cycle', () => {
    const a = createTaskId('a'), b = createTaskId('b'), c = createTaskId('c');
    const deps = new Map([
      [b, new Set([a])],
      [c, new Set([b])],
    ]);
    expect(wouldCreateCycle(deps, a, c)).toBe(true);
  });

  it('allows a valid dependency', () => {
    const a = createTaskId('a'), b = createTaskId('b'), c = createTaskId('c');
    const deps = new Map([[b, new Set([a])]]);
    expect(wouldCreateCycle(deps, c, b)).toBe(false);
  });
});
