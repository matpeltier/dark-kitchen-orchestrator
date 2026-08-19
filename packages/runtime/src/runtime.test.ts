import { describe, it, expect, vi } from 'vitest';
import {
  computeReadyTasks,
  RunSupervisor,
  CyclicGraphError,
  InProcessDurableJournal,
  SqliteDurableJournal,
} from './index.js';
import { runWorkflow } from '@dark-kitchen/workflow-engine';
import type { Task, TaskDependency, RunId } from '@dark-kitchen/core';
import {
  createProjectId,
  createRunId,
  createTaskDependencyId,
  createTaskId,
} from '@dark-kitchen/core';

function makeTask(id: string, status: Task['status'] = 'backlog'): Task {
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

// ─── computeReadyTasks ────────────────────────────────────────────────────────

describe('computeReadyTasks', () => {
  it('returns backlog tasks with no dependencies', () => {
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
    const taskA = makeTask('a', 'backlog');
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
    expect(launched).not.toContain(createTaskId('a')); // blocked, not backlog/ready
    expect(launched).toContain(createTaskId('b'));
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
    const resolver = () => async () => { callCount++; return 'ok'; };

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
    const resolver = (role: string) => async (input: { prompt: string }) => {
      if (role === 'step1') { step1Calls++; return 'step1-result'; }
      if (role === 'step2') { step2Calls++; return 'step2-result'; }
      return 'unknown';
    };

    // First run: complete step1, fail before step2
    await runWorkflow(async (b) => {
      await b.agent({ role: 'step1', prompt: 'p1' });
      // Simulate not reaching step2 (process death)
      return 'partial';
    }, { runId: 'run-restart', journal, resolver });

    // Second run: step1 should be replayed from journal
    step1Calls = 0; // reset counter for second run
    await runWorkflow(async (b) => {
      await b.agent({ role: 'step1', prompt: 'p1' });
      await b.agent({ role: 'step2', prompt: 'p2' });
      return 'complete';
    }, { runId: 'run-restart', journal, resolver });

    expect(step1Calls).toBe(0); // replayed from journal
    expect(step2Calls).toBe(1); // executed for first time
    journal.close();
  });
});
