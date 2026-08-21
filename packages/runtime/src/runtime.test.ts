import { describe, it, expect, vi } from 'vitest';
import {
  computeReadyTasks,
  RunSupervisor,
  CyclicGraphError,
  InProcessDurableJournal,
  SqliteDurableJournal,
  runIdForTask,
} from './index.js';
import { runWorkflow } from '@dark-kitchen/workflow-engine';
import type { Task, TaskDependency } from '@dark-kitchen/core';
import {
  createProjectId,
  createRunId,
  createTaskDependencyId,
  createTaskId,
} from '@dark-kitchen/core';

function makeTask(id: string, status: Task['status'] = 'ready'): Task {
  const projectId = createProjectId('proj');
  return {
    id: createTaskId(id),
    projectId,
    title: id,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeBlocking(taskId: string, dependsOnTaskId: string): TaskDependency {
  return {
    id: createTaskDependencyId(`${taskId}->${dependsOnTaskId}`),
    taskId: createTaskId(taskId),
    dependsOnTaskId: createTaskId(dependsOnTaskId),
    kind: 'blocks',
  };
}

// ─── runIdForTask ─────────────────────────────────────────────────────────────

describe('runIdForTask', () => {
  it('is deterministic and filesystem-safe', () => {
    const id = createTaskId('github-issues:owner/repo#42');
    const a = runIdForTask(id);
    const b = runIdForTask(id);
    expect(a).toBe(b);
    expect(a).not.toMatch(/[:/#]/);
    expect(a).toContain('42');
  });
});

// ─── computeReadyTasks ────────────────────────────────────────────────────────

describe('computeReadyTasks', () => {
  it('returns ready tasks with no dependencies', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const ready = computeReadyTasks(tasks, [], new Set());
    expect(ready.map((t) => t.id)).toContain(createTaskId('a'));
    expect(ready.map((t) => t.id)).toContain(createTaskId('b'));
  });

  it('blocks dependent task until its blocker completes', () => {
    const taskA = makeTask('a', 'completed');
    const taskB = makeTask('b');
    const deps = [makeBlocking('b', 'a')];
    const ready = computeReadyTasks([taskA, taskB], deps, new Set());
    expect(ready.map((t) => t.id)).toContain(createTaskId('b'));
  });

  it('blocks dependent task when blocker is not completed', () => {
    const taskA = makeTask('a', 'active');
    const taskB = makeTask('b');
    const deps = [makeBlocking('b', 'a')];
    const ready = computeReadyTasks([taskA, taskB], deps, new Set());
    expect(ready.map((t) => t.id)).not.toContain(createTaskId('b'));
  });

  it('does not re-schedule active tasks', () => {
    const taskA = makeTask('a', 'ready');
    const active = new Set([createTaskId('a')]);
    const ready = computeReadyTasks([taskA], [], active);
    expect(ready).toHaveLength(0);
  });

  it('throws CyclicGraphError on cyclic dependencies', () => {
    const taskA = makeTask('a');
    const taskB = makeTask('b');
    const deps = [makeBlocking('a', 'b'), makeBlocking('b', 'a')];
    expect(() => computeReadyTasks([taskA, taskB], deps, new Set())).toThrow(CyclicGraphError);
  });
});

// ─── RunSupervisor ────────────────────────────────────────────────────────────

describe('RunSupervisor', () => {
  it('launches two independent ready tasks in parallel', async () => {
    const launched: string[] = [];
    const launcher = vi.fn(async (taskId: string) => {
      launched.push(taskId);
      return createRunId(`run-${taskId}`);
    });

    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );

    const tasks = [makeTask('a'), makeTask('b')];
    const newlyLaunched = await supervisor.tick(tasks, []);
    expect(newlyLaunched).toHaveLength(2);
    expect(launched).toContain(createTaskId('a'));
    expect(launched).toContain(createTaskId('b'));
  });

  it('does not double-schedule on duplicate tick', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );

    const tasks = [makeTask('a')];
    await supervisor.tick(tasks, []);
    await supervisor.tick(tasks, []); // second tick while a is active
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('does not re-schedule a completed task even if still marked ready', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );

    const tasks = [makeTask('a')];
    await supervisor.tick(tasks, []);
    expect(launcher).toHaveBeenCalledTimes(1);

    // The task completed, but the tracker still reports it as 'ready' on the
    // next poll (close-propagation lag) — it must not be re-scheduled.
    supervisor.completeTask(createTaskId('a'));
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('launches dependent task after blocker completes', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );
    const deps = [makeBlocking('b', 'a')];
    const tasks = [makeTask('a'), makeTask('b')];

    // First tick: only A is ready
    await supervisor.tick(tasks, deps);
    expect(launcher).toHaveBeenCalledTimes(1);

    // Complete A
    supervisor.completeTask(createTaskId('a'));

    // Second tick with A completed
    const tasksWithADone = [makeTask('a', 'completed'), makeTask('b')];
    await supervisor.tick(tasksWithADone, deps);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('respects manual pause', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );
    supervisor.pauseTask(createTaskId('a'));
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).not.toHaveBeenCalled();
    supervisor.resumeTask(createTaskId('a'));
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('enforces max parallel tasks concurrency', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 2, projectId: createProjectId('p') },
      launcher,
    );
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`));
    await supervisor.tick(tasks, []);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('independent task launches while another is blocked on intervention', async () => {
    const launched: string[] = [];
    const launcher = vi.fn(async (taskId: string) => {
      launched.push(taskId as string);
      return createRunId(`run-${taskId}`);
    });
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );

    // taskA is blocked on human intervention (status: blocked), taskB is independent
    const taskA = makeTask('a', 'blocked');
    const taskB = makeTask('b');
    await supervisor.tick([taskA, taskB], []);
    expect(launched).not.toContain(createTaskId('a')); // blocked, not ready
    expect(launched).toContain(createTaskId('b'));
  });

  it('stopTask pauses + removes bookkeeping so a restart is required', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(1);

    supervisor.stopTask(createTaskId('a'));
    expect(supervisor.isActive(createTaskId('a'))).toBe(false);
    expect(supervisor.getPausedTasks().has(createTaskId('a'))).toBe(true);

    // Paused → not re-launched on next tick
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(1);

    // Explicit restart → scheduled again
    supervisor.retryTask(createTaskId('a'));
    expect(supervisor.getPausedTasks().has(createTaskId('a'))).toBe(false);
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('retryTask clears completed bookkeeping so a task re-runs', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId: createProjectId('p') },
      launcher,
    );
    await supervisor.tick([makeTask('a')], []);
    supervisor.completeTask(createTaskId('a'));
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(1);

    supervisor.retryTask(createTaskId('a'));
    await supervisor.tick([makeTask('a')], []);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('reports scheduler status getters', async () => {
    const launcher = vi.fn(async (taskId: string) => createRunId(`run-${taskId}`));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 3, projectId: createProjectId('p') },
      launcher,
    );
    await supervisor.tick([makeTask('a')], []);
    supervisor.completeTask(createTaskId('a'));
    supervisor.pauseTask(createTaskId('b'));
    supervisor.pauseTask(createTaskId('c'));

    expect(supervisor.getActiveRuns().size).toBe(0); // completed a
    expect(supervisor.getCompletedTasks().has(createTaskId('a'))).toBe(true);
    expect(supervisor.getPausedTasks().size).toBe(2);
    expect(supervisor.getMaxParallelTasks()).toBe(3);
  });
});

// ─── InProcessDurableJournal ──────────────────────────────────────────────────

describe('InProcessDurableJournal', () => {
  it('replays completed steps', async () => {
    const journal = new InProcessDurableJournal();
    await journal.set('key-1', 'result-1');
    expect(await journal.get('key-1')).toBe('result-1');
  });

  it('returns undefined for unknown key', async () => {
    const journal = new InProcessDurableJournal();
    expect(await journal.get('unknown')).toBeUndefined();
  });

  it('workflow replays completed calls on second run', async () => {
    const journal = new InProcessDurableJournal();
    let callCount = 0;
    const resolver = () => async () => {
      callCount++;
      return 'ok';
    };

    await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'p' }), {
      runId: 'r1',
      journal,
      resolver,
    });
    await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'p' }), {
      runId: 'r1',
      journal,
      resolver,
    });

    expect(callCount).toBe(1);
  });
});

// ─── SqliteDurableJournal ─────────────────────────────────────────────────────

describe('SqliteDurableJournal', () => {
  it('persists and replays a completed step', async () => {
    const journal = new SqliteDurableJournal(':memory:', 'run-test');
    await journal.set('step-1', { output: 'hello' });
    const result = await journal.get('step-1');
    expect(result).toEqual({ output: 'hello' });
    journal.close();
  });

  it('returns undefined for failed/missing steps', async () => {
    const journal = new SqliteDurableJournal(':memory:', 'run-test');
    expect(await journal.get('nonexistent')).toBeUndefined();
    journal.close();
  });

  it('workflow survives process-restart simulation (multi-step replay)', async () => {
    const journal = new SqliteDurableJournal(':memory:', 'run-restart');
    let step1Calls = 0;
    let step2Calls = 0;
    const resolver = (role: string) => async (_input: { prompt: string }) => {
      if (role === 'step1') {
        step1Calls++;
        return 'step1-result';
      }
      if (role === 'step2') {
        step2Calls++;
        return 'step2-result';
      }
      return 'unknown';
    };

    // First run: complete step1, fail before step2
    await runWorkflow(
      async (b) => {
        await b.agent({ role: 'step1', prompt: 'p1' });
        // Simulate not reaching step2 (process death)
        return 'partial';
      },
      { runId: 'run-restart', journal, resolver },
    );

    // Second run: step1 should be replayed from journal
    step1Calls = 0; // reset counter for second run
    await runWorkflow(
      async (b) => {
        await b.agent({ role: 'step1', prompt: 'p1' });
        await b.agent({ role: 'step2', prompt: 'p2' });
        return 'complete';
      },
      { runId: 'run-restart', journal, resolver },
    );

    expect(step1Calls).toBe(0); // replayed from journal
    expect(step2Calls).toBe(1); // executed for first time
    journal.close();
  });

  it('persists, overwrites, and clears in-flight checkpoints', async () => {
    const journal = new SqliteDurableJournal(':memory:', 'run-inflight');
    expect(await journal.getInFlight('step-1')).toBeUndefined();

    await journal.markInFlight('step-1', { sessionKey: 's-1' });
    expect(await journal.getInFlight('step-1')).toEqual({ sessionKey: 's-1' });

    await journal.markInFlight('step-1', { sessionKey: 's-2' });
    expect(await journal.getInFlight('step-1')).toEqual({ sessionKey: 's-2' });

    await journal.clearInFlight('step-1');
    expect(await journal.getInFlight('step-1')).toBeUndefined();
    await journal.clearInFlight('step-1');
    expect(await journal.getInFlight('step-1')).toBeUndefined();
    journal.close();
  });

  it('offers a crash-recovery checkpoint to the next run exactly once', async () => {
    const journal = new SqliteDurableJournal(':memory:', 'run-crash-ckpt');
    await journal.markInFlight('run-crash-ckpt/agent:impl', { sessionKey: 'interrupted' });
    const seenCheckpoints: unknown[] = [];
    const resolver = (role: string) => async (input: { resumeCheckpoint?: unknown }) => {
      if (role === 'impl') {
        seenCheckpoints.push(input.resumeCheckpoint);
        return 'resumed';
      }
      return 'unknown';
    };

    const result = await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'p' }), {
      runId: 'run-crash-ckpt',
      journal,
      resolver,
    });

    expect(result.result).toBe('resumed');
    expect(seenCheckpoints).toEqual([{ sessionKey: 'interrupted' }]);
    expect(await journal.getInFlight('run-crash-ckpt/agent:impl')).toBeUndefined();
    journal.close();
  });
});
