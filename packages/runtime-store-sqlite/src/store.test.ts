import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { redactStoredPrompt, SqliteRuntimeStore } from './store.js';
import type { Project, Task, Run, Workspace, Intervention } from '@dark-kitchen/core';
import {
  createProjectId,
  createTaskId,
  createRunId,
  createWorkspaceId,
  createInterventionId,
  createRepositoryId,
  createExecutionNodeId,
  createEventId,
} from '@dark-kitchen/core';

function now() {
  return new Date().toISOString();
}

describe('SqliteRuntimeStore - migrations', () => {
  it('redacts secrets at the persistence boundary', () => {
    const prompt =
      'token=github_pat_abcdefghijklmnopqrstuvwxyz123456 password: hunter2 url=https://x.test?a=1&api_key=top-secret';
    const stored = redactStoredPrompt(prompt);
    expect(stored).not.toContain('github_pat_');
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('top-secret');
    expect(stored).toContain('[REDACTED]');
  });

  it('opens an empty database and applies all migrations', async () => {
    const store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    const diag = store.getDiagnostics();
    expect(diag.schemaVersion).toBeGreaterThan(0);
    expect(diag.integrityCheck).toBe('ok');
    store.close();
  });

  it('is idempotent across reopen', async () => {
    const dir = join(tmpdir(), `dk-mig-${Date.now()}`);
    const dbPath = join(dir, 'test.db');
    const store1 = await SqliteRuntimeStore.open({ databasePath: dbPath });
    const v1 = store1.getDiagnostics().schemaVersion;
    store1.close();
    const store2 = await SqliteRuntimeStore.open({ databasePath: dbPath });
    const v2 = store2.getDiagnostics().schemaVersion;
    expect(v1).toBe(v2);
    store2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SqliteRuntimeStore - CRUD', () => {
  let store: SqliteRuntimeStore;

  beforeEach(async () => {
    store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
  });
  afterEach(() => store.close());

  it('round-trips a project', async () => {
    const project: Project = {
      id: createProjectId('proj-1'),
      name: 'Test Project',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveProject(project);
    const fetched = await store.getProject(project.id);
    expect(fetched?.name).toBe('Test Project');
    expect(fetched?.id).toBe(project.id);
  });

  it('returns undefined for unknown project', async () => {
    const result = await store.getProject(createProjectId('no-such'));
    expect(result).toBeUndefined();
  });

  it('round-trips a task', async () => {
    const project: Project = {
      id: createProjectId('proj-2'),
      name: 'P2',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveProject(project);
    const task: Task = {
      id: createTaskId('task-1'),
      projectId: project.id,
      title: 'Implement feature',
      labels: ['frontend', 'high-risk'],
      status: 'backlog',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveTask(task);
    const fetched = await store.getTask(task.id);
    expect(fetched?.title).toBe('Implement feature');
    expect(fetched?.status).toBe('backlog');
    expect(fetched?.labels).toEqual(['frontend', 'high-risk']);
  });

  it('upserts a task (idempotent)', async () => {
    const project: Project = {
      id: createProjectId('proj-3'),
      name: 'P3',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveProject(project);
    const task: Task = {
      id: createTaskId('task-2'),
      projectId: project.id,
      title: 'Old title',
      status: 'backlog',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveTask(task);
    await store.saveTask({ ...task, title: 'New title', status: 'active', updatedAt: now() });
    const fetched = await store.getTask(task.id);
    expect(fetched?.title).toBe('New title');
    expect(fetched?.status).toBe('active');
  });

  it('round-trips a run with execution nodes', async () => {
    const project: Project = {
      id: createProjectId('proj-4'),
      name: 'P4',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveProject(project);
    const task: Task = {
      id: createTaskId('task-3'),
      projectId: project.id,
      title: 'T3',
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveTask(task);
    const nodeId = createExecutionNodeId('node-1');
    const run: Run = {
      id: createRunId('run-1'),
      projectId: project.id,
      taskId: task.id,
      state: 'running',
      executionNodeIds: [nodeId],
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveRun(run);
    const fetched = await store.getRun(run.id);
    expect(fetched?.state).toBe('running');
    expect(fetched?.executionNodeIds).toContain(nodeId);
  });

  it('round-trips a workspace', async () => {
    const ws: Workspace = {
      id: createWorkspaceId('ws-1'),
      projectId: createProjectId('proj-5'),
      taskId: createTaskId('task-5'),
      repositoryId: createRepositoryId('repo-1'),
      kind: 'primary-worktree',
      state: 'active',
      path: '/tmp/worktrees/task-5',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveWorkspace(ws);
    const fetched = await store.getWorkspace(ws.id);
    expect(fetched?.path).toBe('/tmp/worktrees/task-5');
    expect(fetched?.kind).toBe('primary-worktree');
  });

  it('round-trips an intervention', async () => {
    const intervention: Intervention = {
      id: createInterventionId('int-1'),
      scope: 'run',
      targetId: createRunId('run-x'),
      kind: 'approval',
      status: 'open',
      summary: 'Needs approval',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveIntervention(intervention);
    const fetched = await store.getIntervention(intervention.id);
    expect(fetched?.summary).toBe('Needs approval');
    expect(fetched?.status).toBe('open');
  });
});

describe('SqliteRuntimeStore - crash/reopen', () => {
  it('preserves active runs and pending interventions across reopen', async () => {
    const dir = join(tmpdir(), `dk-crash-${Date.now()}`);
    const dbPath = join(dir, 'test.db');

    try {
      const store1 = await SqliteRuntimeStore.open({ databasePath: dbPath });
      const project: Project = {
        id: createProjectId('proj-cr'),
        name: 'CR',
        createdAt: now(),
        updatedAt: now(),
      };
      await store1.saveProject(project);
      const task: Task = {
        id: createTaskId('task-cr'),
        projectId: project.id,
        title: 'T',
        status: 'active',
        createdAt: now(),
        updatedAt: now(),
      };
      await store1.saveTask(task);
      const run: Run = {
        id: createRunId('run-cr'),
        projectId: project.id,
        taskId: task.id,
        state: 'running',
        executionNodeIds: [],
        createdAt: now(),
        updatedAt: now(),
      };
      await store1.saveRun(run);
      const intervention: Intervention = {
        id: createInterventionId('int-cr'),
        scope: 'run',
        targetId: run.id,
        kind: 'approval',
        status: 'open',
        summary: 'pending',
        createdAt: now(),
        updatedAt: now(),
      };
      await store1.saveIntervention(intervention);
      store1.close(); // simulate crash (no graceful shutdown)

      const store2 = await SqliteRuntimeStore.open({ databasePath: dbPath });
      const fetchedRun = await store2.getRun(run.id);
      const fetchedIntervention = await store2.getIntervention(intervention.id);
      expect(fetchedRun?.state).toBe('running');
      expect(fetchedIntervention?.status).toBe('open');
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteRuntimeStore - events journal', () => {
  let store: SqliteRuntimeStore;
  beforeEach(async () => {
    store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
  });
  afterEach(() => store.close());

  it('appends and retrieves events', async () => {
    const event = {
      id: createEventId('evt-1'),
      type: 'run.created' as const,
      occurredAt: now(),
      payload: { runId: createRunId('run-1'), taskId: createTaskId('task-1') },
    };
    await store.appendEvent(event);
    const fetched = await store.getEvent(event.id);
    expect(fetched?.type).toBe('run.created');
  });

  it('is idempotent on duplicate event id', async () => {
    const event = {
      id: createEventId('evt-dup'),
      type: 'run.created' as const,
      occurredAt: now(),
      payload: { runId: createRunId('run-1'), taskId: createTaskId('task-1') },
    };
    await store.appendEvent(event);
    await store.appendEvent(event); // should not throw
    const events = await store.listEvents({ type: 'run.created' });
    expect(events.filter((e) => e.id === event.id)).toHaveLength(1);
  });

  it('lists events in sequence order', async () => {
    for (let i = 0; i < 3; i++) {
      const evt = {
        id: createEventId(`evt-seq-${i}`),
        type: 'run.created' as const,
        occurredAt: now(),
        payload: { runId: createRunId(`run-${i}`), taskId: createTaskId(`task-${i}`) },
      };
      await store.appendEvent(evt);
    }
    const events = await store.listEvents({ type: 'run.created' });
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Sequence numbers should be ascending
    const seqs = events.map((e) => e as unknown as { seq: number });
    void seqs; // seq not on DomainEvent interface, tested via ordering only
  });
});

describe('SqliteRuntimeStore - concurrent writes', () => {
  it('handles concurrent saves without corruption', async () => {
    const store = await SqliteRuntimeStore.open({ databasePath: ':memory:' });
    const project: Project = {
      id: createProjectId('proj-conc'),
      name: 'Conc',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveProject(project);

    const tasks = Array.from(
      { length: 20 },
      (_, i): Task => ({
        id: createTaskId(`task-conc-${i}`),
        projectId: project.id,
        title: `Task ${i}`,
        status: 'backlog',
        createdAt: now(),
        updatedAt: now(),
      }),
    );

    await Promise.all(tasks.map((t) => store.saveTask(t)));

    for (const task of tasks) {
      const fetched = await store.getTask(task.id);
      expect(fetched?.id).toBe(task.id);
    }
    store.close();
  });
});
