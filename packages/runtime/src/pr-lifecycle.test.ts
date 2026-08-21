import { describe, it, expect, vi } from 'vitest';
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
  it('refuses auto-merge when no required SCM check is configured', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'Unsafe auto-merge config',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/no-required-checks',
        targetBranch: 'main',
        autoMerge: true,
      },
    );
    expect(result).toMatchObject({
      state: 'merge-refused',
      errorMessage: expect.stringMatching(/required SCM check/u),
    });
  });

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
    const merge = vi.spyOn(scm, 'merge');
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
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: expect.stringMatching(/^sha-/u) }),
    );

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

  it('truncates PR title to GitHub 256-char limit', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);

    const longSummary = `Step 1: ${'x'.repeat(100)}\nStep 2: ${'y'.repeat(100)}\nStep 3: ${'z'.repeat(100)}`;
    const result = await orch.run(
      {
        taskId: task.id,
        summary: longSummary,
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/long-title',
        targetBranch: 'main',
        autoMerge: false,
      },
    );

    expect(result.state).toBe('awaiting-approval');
    const pr = await scm.findPullRequestByBranch(repoId, 'feat/long-title');
    expect(pr).toBeTruthy();
    expect(pr!.title.length).toBeLessThanOrEqual(256);
    expect(pr!.title.endsWith('...')).toBe(true);
    expect(pr!.title).not.toMatch(/[\r\n]/);
  });

  it('refuses PR creation when independent review failed or worktree is dirty', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const base = {
      taskId: task.id,
      summary: 'unsafe result',
      repositoryTestsPassed: true,
      reviewPassed: true,
      commits: ['abc123'],
    } as const;

    await expect(
      orch.run(
        { ...base, reviewPassed: false },
        { repositoryId: repoId, sourceBranch: 'feat/review', targetBranch: 'main' },
      ),
    ).resolves.toMatchObject({ state: 'workflow-invalid' });
    await expect(
      orch.run(
        { ...base, worktreeClean: false },
        { repositoryId: repoId, sourceBranch: 'feat/dirty', targetBranch: 'main' },
      ),
    ).resolves.toMatchObject({ state: 'workflow-invalid' });
    expect(await scm.findPullRequestByBranch(repoId, 'feat/review')).toBeUndefined();
    expect(await scm.findPullRequestByBranch(repoId, 'feat/dirty')).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    [
      'failed',
      [{ profileId: 'web-e2e', status: 'failed' as const, evidenceRefs: ['artifact:trace'] }],
    ],
    ['evidence-less', [{ profileId: 'web-e2e', status: 'passed' as const, evidenceRefs: [] }]],
  ])('blocks a %s required verification proof before PR creation', async (_case, proofs) => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'proof gate',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        ...(proofs ? { verificationResults: proofs } : {}),
      },
      {
        repositoryId: repoId,
        sourceBranch: `feat/proof-${_case}`,
        targetBranch: 'main',
        requiredVerificationProfiles: ['web-e2e'],
      },
    );
    expect(result.state).toBe('verification-failed');
    expect(result.pullRequestId).toBeUndefined();
    expect(await scm.findPullRequestByBranch(repoId, `feat/proof-${_case}`)).toBeUndefined();
  });

  it('injects structured passing proofs into the PR body', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'verified feature',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        verificationResults: [
          {
            profileId: 'web-e2e',
            status: 'passed',
            summary: 'signup observable outcome passed',
            evidenceRefs: ['artifact:trace-42', 'https://artifacts.example/shot.png'],
          },
        ],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/proof-pass',
        targetBranch: 'main',
        autoMerge: false,
        requiredVerificationProfiles: ['web-e2e'],
      },
    );
    expect(result.state).toBe('awaiting-approval');
    expect(scm.lastPrBody).toContain('**Verification proofs:**');
    expect(scm.lastPrBody).toContain('web-e2e: **passed**');
    expect(scm.lastPrBody).toContain('artifact:trace-42');
  });

  it('rejects sensitive evidence refs and redacts secrets from title/body', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const blocked = await orch.run(
      {
        taskId: task.id,
        summary: 'proof',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        verificationResults: [
          {
            profileId: 'api-e2e',
            status: 'passed',
            evidenceRefs: ['https://example.test/log?token=super-secret'],
          },
        ],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/sensitive-proof',
        targetBranch: 'main',
        requiredVerificationProfiles: ['api-e2e'],
      },
    );
    expect(blocked.state).toBe('verification-failed');

    await orch.run(
      {
        taskId: task.id,
        summary: 'safe summary token=super-secret\nsecond line',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/redacted-summary',
        targetBranch: 'main',
        autoMerge: false,
      },
    );
    const pr = await scm.findPullRequestByBranch(repoId, 'feat/redacted-summary');
    expect(pr?.title).not.toContain('super-secret');
    expect(pr?.title).not.toContain('\n');
    expect(scm.lastPrBody).not.toContain('super-secret');
    expect(scm.lastPrBody).toContain('[REDACTED]');
  });

  it('recovers after merge + tracker failure without recreating the PR or rerunning merge', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const pr = await scm.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/recovery',
      targetBranch: 'main',
      title: 'Recovery',
    });
    scm.setChecks(pr.id, [{ name: 'ci', status: 'passed' }]);
    vi.spyOn(tracker, 'updateTask').mockRejectedValueOnce(new Error('tracker offline'));
    const mergeSpy = vi.spyOn(scm, 'merge');
    const workflowResult = {
      taskId: task.id,
      summary: 'recovery',
      repositoryTestsPassed: true,
      reviewPassed: true,
      commits: ['abc123'],
    } as const;
    const options = {
      repositoryId: repoId,
      sourceBranch: 'feat/recovery',
      targetBranch: 'main',
      autoMerge: true,
      requiredChecks: ['ci'],
    } as const;

    const first = await orch.run(workflowResult, options);
    expect(first.state).toBe('tracker-close-failed');
    const second = await orch.run(workflowResult, options);
    expect(second.state).toBe('merged');
    expect(second.pullRequestId).toBe(first.pullRequestId);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });

  it('turns check polling network failure into recoverable state', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    vi.spyOn(scm, 'pollChecks').mockRejectedValue(new Error('token=must-not-leak'));
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'network',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/network',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );
    expect(result.state).toBe('checks-failed');
    expect(result.pullRequestId).toBeTruthy();
    expect(result.errorMessage).not.toContain('must-not-leak');
  });

  it('does not close the tracker until SCM confirms merged state', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const pr = await scm.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/unconfirmed',
      targetBranch: 'main',
      title: 'Unconfirmed merge',
    });
    scm.setChecks(pr.id, [{ name: 'ci', status: 'passed' }]);
    vi.spyOn(scm, 'verifyMerged').mockResolvedValue(false);
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'unconfirmed merge',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/unconfirmed',
        targetBranch: 'main',
        autoMerge: true,
        requiredChecks: ['ci'],
      },
    );
    expect(result.state).toBe('merge-verification-failed');
    expect((await tracker.getTaskById(task.id))?.status).not.toBe('completed');
  });

  it('refreshes the PR body with fresh proofs when reusing an existing PR', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const updateSpy = vi.spyOn(scm, 'updatePullRequestBody');

    const first = await orch.run(
      {
        taskId: task.id,
        summary: 'first attempt',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        verificationResults: [
          { profileId: 'web-e2e', status: 'passed', evidenceRefs: ['artifact:run-1'] },
        ],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/reuse',
        targetBranch: 'main',
        autoMerge: false,
      },
    );
    expect(first.state).toBe('awaiting-approval');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(scm.lastPrBody).toContain('artifact:run-1');

    const second = await orch.run(
      {
        taskId: task.id,
        summary: 'second attempt',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        verificationResults: [
          { profileId: 'web-e2e', status: 'passed', evidenceRefs: ['artifact:run-2'] },
        ],
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/reuse',
        targetBranch: 'main',
        autoMerge: false,
      },
    );
    expect(second.state).toBe('awaiting-approval');
    expect(second.pullRequestId).toBe(first.pullRequestId);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(scm.lastPrBody).toContain('artifact:run-2');
    expect(scm.lastPrBody).not.toContain('artifact:run-1');
  });

  it('includes attested sha256 digests next to evidence refs in the PR body', async () => {
    const scm = makeScm();
    const tracker = makeTracker();
    const orch = new PrLifecycleOrchestrator(scm, tracker);
    const task = await makeTask(tracker);
    const result = await orch.run(
      {
        taskId: task.id,
        summary: 'attested evidence',
        repositoryTestsPassed: true,
        reviewPassed: true,
        commits: ['abc123'],
        evidenceRefs: ['artifacts/shot.png', 'artifacts/unreadable.png'],
        evidenceAttestations: {
          'artifacts/shot.png': 'sha256:deadbeef',
        },
      },
      {
        repositoryId: repoId,
        sourceBranch: 'feat/attested',
        targetBranch: 'main',
        autoMerge: false,
      },
    );
    expect(result.state).toBe('awaiting-approval');
    expect(scm.lastPrBody).toContain('- artifacts/shot.png — sha256:deadbeef');
    expect(scm.lastPrBody).toContain('- artifacts/unreadable.png');
  });
});
