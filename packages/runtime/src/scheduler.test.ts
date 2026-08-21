import { describe, expect, it, vi } from 'vitest';
import {
  createProjectId,
  createRunId,
  createTaskId,
  type Task,
  type TaskDependency,
} from '@dark-kitchen/core';
import { RunSupervisor } from './scheduler.js';

const projectId = createProjectId('proj');

function makeTask(id: string, status: Task['status']): Task {
  return {
    id: createTaskId(id),
    projectId,
    title: id,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeDependency(taskId: string, dependsOnTaskId: string): TaskDependency {
  return {
    id: createTaskId(`${taskId}->${dependsOnTaskId}`) as unknown as TaskDependency['id'],
    taskId: createTaskId(taskId),
    dependsOnTaskId: createTaskId(dependsOnTaskId),
    kind: 'blocks',
  };
}

describe('RunSupervisor auto-promotion of dependents', () => {
  it('promotes a backlog task whose dependencies are all completed and launches it', async () => {
    const launched: string[] = [];
    const promoteToReady = vi.fn().mockResolvedValue(undefined);
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId },
      async (taskId) => {
        launched.push(String(taskId));
        return createRunId(`run-${String(taskId)}`);
      },
      { promoteToReady },
    );

    const tasks = [makeTask('a', 'completed'), makeTask('b', 'backlog')];
    const dependencies = [makeDependency('b', 'a')];

    const launchedIds = await supervisor.tick(tasks, dependencies);
    expect(promoteToReady).toHaveBeenCalledWith(createTaskId('b'));
    expect(launchedIds.map(String)).toEqual([createTaskId('b').toString()]);
  });

  it('does not promote when a dependency is not completed', async () => {
    const promoteToReady = vi.fn().mockResolvedValue(undefined);
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId },
      async () => createRunId('run-x'),
      {
        promoteToReady,
      },
    );

    const tasks = [makeTask('a', 'active'), makeTask('b', 'backlog')];
    const dependencies = [makeDependency('b', 'a')];

    const launchedIds = await supervisor.tick(tasks, dependencies);
    expect(promoteToReady).not.toHaveBeenCalled();
    expect(launchedIds).toHaveLength(0);
  });

  it('skips promotion when autoPromoteDependents is disabled', async () => {
    const promoteToReady = vi.fn().mockResolvedValue(undefined);
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId, autoPromoteDependents: false },
      async () => createRunId('run-x'),
      { promoteToReady },
    );

    const tasks = [makeTask('a', 'completed'), makeTask('b', 'backlog')];
    const dependencies = [makeDependency('b', 'a')];

    const launchedIds = await supervisor.tick(tasks, dependencies);
    expect(promoteToReady).not.toHaveBeenCalled();
    expect(launchedIds).toHaveLength(0);
  });

  it('does not launch nor throw when the tracker sync fails', async () => {
    const launched: string[] = [];
    const promoteToReady = vi.fn().mockRejectedValue(new Error('tracker down'));
    const supervisor = new RunSupervisor(
      { maxParallelTasks: 4, projectId },
      async (taskId) => {
        launched.push(String(taskId));
        return createRunId(`run-${String(taskId)}`);
      },
      { promoteToReady },
    );

    const tasks = [makeTask('a', 'completed'), makeTask('b', 'backlog')];
    const dependencies = [makeDependency('b', 'a')];

    await expect(supervisor.tick(tasks, dependencies)).resolves.toHaveLength(0);
    expect(launched).toHaveLength(0);
  });
});
