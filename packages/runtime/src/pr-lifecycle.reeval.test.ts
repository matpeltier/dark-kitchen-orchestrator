import { describe, it, expect, vi } from 'vitest';
import { PrLifecycleOrchestrator } from './pr-lifecycle.js';
import { MockScmAdapter, MergeRefusedError, type Check } from '@dark-kitchen/scm';
import { MockTrackerAdapter } from '@dark-kitchen/tracker';
import { createRepositoryId } from '@dark-kitchen/core';

const repoId = createRepositoryId('github:mock');

describe('PrLifecycleOrchestrator re-evaluation loop', () => {
  it('re-polls checks and merges when checks pass on a later attempt', async () => {
    const scm = new MockScmAdapter();
    const tracker = new MockTrackerAdapter();
    const task = await tracker.createTask({ projectId: 'proj' as never, title: 't' });
    const orch = new PrLifecycleOrchestrator(scm, tracker);

    let pollCalls = 0;
    const realPoll = scm.pollChecks.bind(scm);
    vi.spyOn(scm, 'pollChecks').mockImplementation(async (id, _policy) => {
      pollCalls += 1;
      if (pollCalls === 1) return [{ name: 'ci', status: 'failed' } as Check];
      scm.setChecks(id, [{ name: 'ci', status: 'passed' }]);
      return realPoll(id, {
        intervalMs: 1,
        timeoutMs: 1000,
        requiredChecks: ['ci'],
      });
    });

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
        sourceBranch: 'feat/reeval',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );

    expect(result.state).toBe('merged');
    expect(pollCalls).toBeGreaterThanOrEqual(2);
  });

  it('returns merge-conflict when the merge is refused for conflicts without a worktree', async () => {
    const scm = new MockScmAdapter();
    const tracker = new MockTrackerAdapter();
    const task = await tracker.createTask({ projectId: 'proj' as never, title: 't' });
    const orch = new PrLifecycleOrchestrator(scm, tracker);

    const realCreate = scm.createPullRequest.bind(scm);
    vi.spyOn(scm, 'createPullRequest').mockImplementation(async (input) => {
      const pr = await realCreate(input);
      scm.setChecks(pr.id, [{ name: 'ci', status: 'passed' }]);
      return pr;
    });
    vi.spyOn(scm, 'merge').mockRejectedValue(
      new MergeRefusedError('Pull Request has merge conflicts'),
    );

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
        sourceBranch: 'feat/conflict',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );

    expect(result.state).toBe('merge-conflict');
  });

  it('returns checks-failed once the bounded re-evaluation attempts are exhausted', async () => {
    const scm = new MockScmAdapter();
    const tracker = new MockTrackerAdapter();
    const task = await tracker.createTask({ projectId: 'proj' as never, title: 't' });
    const orch = new PrLifecycleOrchestrator(scm, tracker);

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
        sourceBranch: 'feat/never-green',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
        externalFixPolls: 2,
      },
    );

    expect(result.state).toBe('checks-failed');
  });
});
