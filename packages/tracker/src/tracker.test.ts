import { describe, it, expect, vi } from 'vitest';
import {
  MockTrackerAdapter,
  GitHubIssuesAdapter,
  CyclicDependencyError,
  wouldCreateCycle,
} from './index.js';
import { createTaskId } from '@dark-kitchen/core';

// ─── Shared adapter contract tests ───────────────────────────────────────────

describe('MockTrackerAdapter - shared contract', () => {
  it('creates a task', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'My task' });
    expect(task.title).toBe('My task');
    expect(task.status).toBe('backlog');
  });

  it('preserves normalized labels for workflow selection', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({
      projectId: 'mock-project' as never,
      title: 'Labelled task',
      labels: ['frontend', 'high-risk'],
    });
    expect(task.labels).toEqual(['frontend', 'high-risk']);
    await expect(adapter.getTaskById(task.id)).resolves.toEqual(
      expect.objectContaining({ labels: ['frontend', 'high-risk'] }),
    );
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

  it('returns normalized comments through the PM control contract', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'C2' });
    await adapter.addComment({ taskId: task.id, body: 'Decision recorded' });
    await expect(adapter.listComments(task.id)).resolves.toEqual([
      expect.objectContaining({ taskId: task.id, body: 'Decision recorded', author: 'mock' }),
    ]);
  });

  it('opts a task into and out of autonomous execution', async () => {
    const adapter = new MockTrackerAdapter();
    const task = await adapter.createTask({ projectId: 'mock-project' as never, title: 'Auto' });
    await expect(adapter.setAutonomousApproval(task.id, true)).resolves.toEqual(
      expect.objectContaining({ status: 'ready' }),
    );
    await expect(adapter.setAutonomousApproval(task.id, false)).resolves.toEqual(
      expect.objectContaining({ status: 'backlog' }),
    );
  });

  it('adds and removes a blocker dependency', async () => {
    const adapter = new MockTrackerAdapter();
    const taskA = await adapter.createTask({ projectId: 'mock-project' as never, title: 'A' });
    const taskB = await adapter.createTask({ projectId: 'mock-project' as never, title: 'B' });
    const dep = await adapter.addDependency({ taskId: taskB.id, dependsOnTaskId: taskA.id });
    const deps = await adapter.listDependencies(taskB.id);
    expect(deps).toContainEqual(
      expect.objectContaining({ taskId: taskB.id, dependsOnTaskId: taskA.id }),
    );
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
    const a = createTaskId('a'),
      b = createTaskId('b'),
      c = createTaskId('c');
    const deps = new Map([
      [b, new Set([a])],
      [c, new Set([b])],
    ]);
    expect(wouldCreateCycle(deps, a, c)).toBe(true);
  });

  it('allows a valid dependency', () => {
    const a = createTaskId('a'),
      b = createTaskId('b'),
      c = createTaskId('c');
    const deps = new Map([[b, new Set([a])]]);
    expect(wouldCreateCycle(deps, c, b)).toBe(false);
  });
});

describe('GitHubIssuesAdapter native dependencies', () => {
  it('round-trips native blocked-by edges across adapter instances without changing bodies', async () => {
    const now = new Date().toISOString();
    const issues = [
      {
        id: 101,
        number: 1,
        title: 'blocker',
        body: 'keep me',
        state: 'open',
        labels: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 102,
        number: 2,
        title: 'blocked',
        body: 'keep me too',
        state: 'open',
        labels: [],
        created_at: now,
        updated_at: now,
      },
    ];
    const blockedBy = new Map<number, Set<number>>();
    const update = vi.fn();
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: issues }),
        get: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
          data: issues.find((issue) => issue.number === issue_number),
        })),
        update,
      },
      request: vi.fn(async (route: string, input: Record<string, unknown>) => {
        const issueNumber = Number(input['issue_number']);
        if (route.startsWith('GET ')) {
          const blockerIds = blockedBy.get(issueNumber) ?? new Set<number>();
          return { data: issues.filter((issue) => blockerIds.has(issue.id)) };
        }
        if (route.startsWith('POST ')) {
          const blockerId = Number(input['issue_id']);
          const current = blockedBy.get(issueNumber) ?? new Set<number>();
          current.add(blockerId);
          blockedBy.set(issueNumber, current);
          return { data: {} };
        }
        if (route.startsWith('DELETE ')) {
          blockedBy.get(issueNumber)?.delete(Number(input['issue_id']));
          return { data: {} };
        }
        throw new Error(`Unexpected route ${route}`);
      }),
    };
    const config = { owner: 'o', repo: 'r', token: 'test' };
    const task1 = createTaskId('github-issues:o/r#1');
    const task2 = createTaskId('github-issues:o/r#2');
    const adapter = new GitHubIssuesAdapter(config, octokit as never);

    const dependency = await adapter.addDependency({
      taskId: task2,
      dependsOnTaskId: task1,
      kind: 'blocks',
    });
    const restarted = new GitHubIssuesAdapter(config, octokit as never);
    await expect(restarted.listDependencies(task2)).resolves.toEqual([dependency]);
    await expect(
      restarted.addDependency({ taskId: task1, dependsOnTaskId: task2, kind: 'blocks' }),
    ).rejects.toBeInstanceOf(CyclicDependencyError);
    await restarted.removeDependency(dependency.id);
    await expect(restarted.listDependencies(task2)).resolves.toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(issues.map((issue) => issue.body)).toEqual(['keep me', 'keep me too']);
  });
});
