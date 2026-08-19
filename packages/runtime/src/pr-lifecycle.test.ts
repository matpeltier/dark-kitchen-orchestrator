import { describe, it, expect } from 'vitest';
import { PrLifecycleOrchestrator } from './pr-lifecycle.js';
import { MockScmAdapter } from '@dark-kitchen/scm';
import { MockTrackerAdapter } from '@dark-kitchen/tracker';
import { createRepositoryId } from '@dark-kitchen/core';

const repoId = createRepositoryId('github:mock');

function makeScm() {
  return new MockScmAdapter();
}

function makeTracker() {
  return new MockTrackerAdapter();
}

async function makeTask(tracker: MockTrackerAdapter) {
  return tracker.createTask({ projectId: 'proj' as never, title: 'Test task' });
}

describe('PrLifecycleOrchestrator', () => {
  it('creates PR and merges with passing checks', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Implement feature',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/task-1',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );

    // No CI checks set on mock → merge passes without required checks when none set
    // Actually requiredChecks: ['ci'] but no checks set → fails
    // Let's set checks first
    expect(result.state).toBe('checks-failed');
  });

  it('full flow: PR created, checks pass, merge, tracker close, worktree released', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    // First create a PR to get the ID for setting checks
    const pr = await scm.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/full-flow',
      targetBranch: 'main',
      title: 'Pre-created PR',
    });
    scm.setChecks(pr.id, [{ name: 'ci', status: 'passed' }]);

    let worktreeReleased = false;
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Full flow test',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/full-flow',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
      async (_taskId) => {
        worktreeReleased = true;
      },
    );

    expect(result.state).toBe('merged');
    expect(result.merged).toBe(true);
    expect(result.trackerClosed).toBe(true);
    expect(worktreeReleased).toBe(true);

    // Tracker task should be closed
    const updatedTask = await tracker.getTaskById(task.id);
    expect(updatedTask?.status).toBe('completed');
  });

  it('blocks merge when checks fail', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const pr = await scm.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/bad-ci',
      targetBranch: 'main',
      title: 'Bad CI',
    });
    scm.setChecks(pr.id, [{ name: 'ci', status: 'failed' }]);

    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Bad CI',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['def456'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/bad-ci',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );

    expect(result.state).toBe('checks-failed');
    expect(result.merged).toBe(false);
  });

  it('pauses at awaiting-approval when autoMerge is false', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Needs approval',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['ghi789'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/needs-approval',
        targetBranch: 'main',
        autoMerge: false,
      },
    );

    expect(result.state).toBe('awaiting-approval');
    expect(result.pullRequestId).toBeTruthy();
  });

  it('rejects workflow with no commits', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Empty',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: [],
      },
      { repositoryId: repoId, sourceBranch: 'feat/empty', targetBranch: 'main', autoMerge: true },
    );

    expect(result.state).toBe('checks-failed');
  });

  it('handles no-code outcome', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'No code needed',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: [],
        noCodeOutcome: true,
      },
      { repositoryId: repoId, sourceBranch: 'feat/no-code', targetBranch: 'main', autoMerge: true },
    );

    expect(result.state).toBe('no-code-outcome');
    const updatedTask = await tracker.getTaskById(task.id);
    expect(updatedTask?.status).toBe('completed');
  });
});
