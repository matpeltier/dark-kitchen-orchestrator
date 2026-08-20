import { describe, it, expect, vi } from 'vitest';
import { DaemonLoop, RunSupervisor, runIdForTask } from './index.js';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import type { Run, RunId, Task } from '@dark-kitchen/core';
import { createProjectId, createRunId, createTaskId } from '@dark-kitchen/core';

const projectId = createProjectId('proj');

function makeTask(id: string, status: Task['status'] = 'ready'): Task {
  return {
    id: createTaskId(id),
    projectId,
    title: id,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeRun(taskId: string, state: Run['state']): Run {
  const now = new Date().toISOString();
  return {
    id: createRunId(runIdForTask(createTaskId(taskId))),
    projectId,
    taskId: createTaskId(taskId),
    state,
    executionNodeIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

const successOutcome = {
  success: true,
  summary: 'implemented',
  commits: ['abc'],
  sourceBranch: 'dk/impl',
  repositoryTestsPassed: true,
  reviewPassed: true,
  worktreeClean: true,
  journalPath: '/tmp/never-created-journal.db',
};

function buildLoop(store: SqliteRuntimeStore, tasks: Task[]) {
  const supervisor = new RunSupervisor({ maxParallelTasks: 4, projectId }, async (taskId) =>
    createRunId(runIdForTask(taskId)),
  );
  const runWorkflowForTask = vi.fn(async (_task: Task, _runId: RunId) => successOutcome);
  const loop = new DaemonLoop(
    {
      pollIntervalMs: 60_000,
      projectId,
      repositoryId: 'github:o/r',
      targetBranch: 'main',
    },
    {
      supervisor,
      getTaskGraph: async () => ({ tasks, dependencies: [] }),
      runWorkflowForTask,
      lifecycleOrchestrator: {
        run: async () => ({
          state: 'merged',
          merged: true,
          trackerClosed: true,
          worktreeReleased: true,
        }),
      } as never,
      interventionService: {
        create: async () => ({ id: 'intervention-1' }),
      } as never,
      store,
    },
  );
  return { supervisor, runWorkflowForTask, loop };
}

describe('DaemonLoop.reconcile', () => {
  it('resumes a run left running and pauses a run left waiting', async () => {
    const store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    const taskA = makeTask('a', 'ready');
    const taskB = makeTask('b', 'ready');
    await store.saveRun(makeRun('a', 'running'));
    await store.saveRun(makeRun('b', 'waiting'));

    const { supervisor, runWorkflowForTask, loop } = buildLoop(store, [taskA, taskB]);
    const result = await loop.reconcile();

    expect(result).toEqual({ resumed: 1, paused: 1, skipped: 0 });
    // The running task is resumed with its deterministic run id.
    expect(runWorkflowForTask).toHaveBeenCalledTimes(1);
    expect(runWorkflowForTask.mock.calls[0]?.[1]).toBe(
      createRunId(runIdForTask(createTaskId('a'))),
    );
    // The human-gated task is re-seeded as paused, never re-run.
    expect(supervisor.getPausedTasks().has(createTaskId('b'))).toBe(true);

    // Let the resumed run reach its terminal lifecycle transition.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(supervisor.getCompletedTasks().has(createTaskId('a'))).toBe(true);

    // A later scheduler tick must not double-schedule either task.
    const launched: string[] = [];
    const supervisor2 = new RunSupervisor({ maxParallelTasks: 4, projectId }, async (taskId) => {
      launched.push(taskId as string);
      return createRunId(runIdForTask(taskId));
    });
    // Same recovered bookkeeping, fresh tick.
    supervisor2.recoverActive(createTaskId('a'), createRunId(runIdForTask(createTaskId('a'))));
    supervisor2.recoverPaused(createTaskId('b'));
    await supervisor2.tick([taskA, taskB], []);
    expect(launched).toHaveLength(0);
    store.close();
  });

  it('skips tasks that are already completed upstream', async () => {
    const store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    const taskA = makeTask('a', 'completed');
    await store.saveRun(makeRun('a', 'running'));

    const { runWorkflowForTask, loop } = buildLoop(store, [taskA]);
    const result = await loop.reconcile();

    expect(result).toEqual({ resumed: 0, paused: 0, skipped: 1 });
    expect(runWorkflowForTask).not.toHaveBeenCalled();
    store.close();
  });

  it('is a no-op without a durable store', async () => {
    const store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    const taskA = makeTask('a', 'ready');
    const { runWorkflowForTask } = buildLoop(store, [taskA]);
    // Verify reconcile() returns zeroes when store is absent.
    const noStoreLoop = new DaemonLoop(
      {
        pollIntervalMs: 60_000,
        projectId,
        repositoryId: 'github:o/r',
        targetBranch: 'main',
      },
      {
        supervisor: new RunSupervisor({ maxParallelTasks: 4, projectId }, async (taskId) =>
          createRunId(runIdForTask(taskId)),
        ),
        getTaskGraph: async () => ({ tasks: [taskA], dependencies: [] }),
        runWorkflowForTask,
        lifecycleOrchestrator: {} as never,
        interventionService: {} as never,
      },
    );
    expect(await noStoreLoop.reconcile()).toEqual({ resumed: 0, paused: 0, skipped: 0 });
    expect(runWorkflowForTask).not.toHaveBeenCalled();
    store.close();
  });
});
