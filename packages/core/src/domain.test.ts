import { describe, expect, it } from 'vitest';

import {
  createAgentSessionId,
  createExecutionNodeId,
  createInterventionId,
  createProjectId,
  createRepositoryId,
  createRunId,
  createTaskDependencyId,
  createTaskGraphId,
  createTaskId,
  createWorkspaceId,
  DomainValidationError,
  transitionAgentSession,
  validatePrimaryWorktreeInvariant,
  validateTaskGraph,
} from './index.js';
import type {
  AgentSession,
  AgentSessionState,
  Intervention,
  TaskDependency,
  TaskGraph,
  Workspace,
} from './index.js';

const projectId = createProjectId('project-1');
const taskA = createTaskId('task-a');
const taskB = createTaskId('task-b');
const timestamp = '2026-08-17T00:00:00.000Z';

function graph(dependencies: readonly TaskDependency[]): TaskGraph {
  return {
    id: createTaskGraphId('graph-1'),
    projectId,
    taskIds: [taskA, taskB],
    dependencies,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function workspace(id: string, taskId: typeof taskA): Workspace {
  return {
    id: createWorkspaceId(id),
    projectId,
    taskId,
    repositoryId: createRepositoryId('repository-1'),
    kind: 'primary-worktree',
    state: 'active',
    path: `/worktrees/${id}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function agentSession(state: AgentSessionState = 'starting'): AgentSession {
  return {
    id: createAgentSessionId('agent-1'),
    runId: createRunId('run-1'),
    taskId: taskA,
    executionNodeId: createExecutionNodeId('node-1'),
    workspaceId: createWorkspaceId('workspace-1'),
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('domain validation', () => {
  it('rejects empty stable identifiers', () => {
    expect(() => createTaskId('  ')).toThrow(DomainValidationError);
  });

  it('rejects blocking dependency cycles', () => {
    expect(() =>
      validateTaskGraph(
        graph([
          {
            id: createTaskDependencyId('dependency-a'),
            taskId: taskA,
            dependsOnTaskId: taskB,
            kind: 'blocks',
          },
          {
            id: createTaskDependencyId('dependency-b'),
            taskId: taskB,
            dependsOnTaskId: taskA,
            kind: 'blocks',
          },
        ]),
      ),
    ).toThrow('must not contain cycles');
  });

  it('requires exactly one active primary worktree per active task', () => {
    expect(() =>
      validatePrimaryWorktreeInvariant([taskA], [workspace('workspace-1', taskA)]),
    ).not.toThrow();

    expect(() => validatePrimaryWorktreeInvariant([taskA, taskB], [])).toThrow(
      'has no primary worktree',
    );
    expect(() =>
      validatePrimaryWorktreeInvariant(
        [taskA],
        [workspace('workspace-1', taskA), workspace('workspace-2', taskA)],
      ),
    ).toThrow('more than one primary worktree');

    expect(() =>
      validatePrimaryWorktreeInvariant(
        [taskA, taskB],
        [workspace('shared-workspace', taskA), { ...workspace('shared-workspace', taskB) }],
      ),
    ).toThrow('shared by multiple tasks');

    expect(() =>
      validatePrimaryWorktreeInvariant(
        [taskA, taskB],
        [
          { ...workspace('workspace-a', taskA), path: '/worktrees/shared' },
          { ...workspace('workspace-b', taskB), path: '/worktrees/shared' },
        ],
      ),
    ).toThrow('path /worktrees/shared is shared by multiple tasks');
  });
});

describe('intervention targets', () => {
  it('ties each intervention scope to its target identifier type', () => {
    const taskIntervention: Intervention = {
      id: createInterventionId('intervention-1'),
      scope: 'task',
      targetId: taskA,
      kind: 'approval',
      status: 'open',
      summary: 'Approve task execution',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(taskIntervention.targetId).toBe(taskA);

    // @ts-expect-error A task intervention must target a TaskId.
    const invalidIntervention: Intervention = {
      ...taskIntervention,
      targetId: createAgentSessionId('agent-1'),
    };
    expect(invalidIntervention).toBeDefined();
  });
});

describe('agent session state transitions', () => {
  it('allows a session to run, wait, recover, and complete', () => {
    const waiting = transitionAgentSession(agentSession('running'), 'waiting', timestamp);
    const blocked = transitionAgentSession(waiting, 'blocked', timestamp);
    const running = transitionAgentSession(blocked, 'running', timestamp);
    const completed = transitionAgentSession(running, 'completed', timestamp);

    expect(completed.state).toBe('completed');
    expect(completed.completedAt).toBe(timestamp);
  });

  it('rejects illegal transitions from a terminal state', () => {
    expect(() => transitionAgentSession(agentSession('completed'), 'running', timestamp)).toThrow(
      'Illegal agent session state transition',
    );
  });

  it('keeps interrupted sessions resumable and nonterminal', () => {
    const interrupted = transitionAgentSession(agentSession('running'), 'interrupted', timestamp);
    const resumed = transitionAgentSession(interrupted, 'starting', timestamp);

    expect(interrupted.completedAt).toBeUndefined();
    expect(resumed.state).toBe('starting');
  });
});
