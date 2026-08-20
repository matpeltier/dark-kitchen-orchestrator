import { describe, it, expect } from 'vitest';
import { MockScmAdapter, ChecksFailedError, MergeRefusedError } from './index.js';
import { createRepositoryId } from '@dark-kitchen/core';

const repoId = createRepositoryId('github:mock');

describe('MockScmAdapter - PR lifecycle', () => {
  it('creates a pull request', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/task-1',
      targetBranch: 'main',
      title: 'Implement feature',
    });
    expect(pr.status).toBe('open');
    expect(pr.sourceBranch).toBe('feat/task-1');
  });

  it('finds a PR by branch', async () => {
    const adapter = new MockScmAdapter();
    await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'X',
    });
    const found = await adapter.findPullRequestByBranch(repoId, 'feat/x');
    expect(found).toBeTruthy();
    expect(found?.sourceBranch).toBe('feat/x');
  });

  it('creates or reuses one PR idempotently under replay', async () => {
    const adapter = new MockScmAdapter();
    const input = {
      repositoryId: repoId,
      sourceBranch: 'feat/idempotent',
      targetBranch: 'main',
      title: 'Idempotent',
    } as const;
    const [first, replay] = await Promise.all([
      adapter.createPullRequest(input),
      adapter.createPullRequest(input),
    ]);
    expect(replay.id).toBe(first.id);
    expect(replay.number).toBe(first.number);
  });

  it('finds an already merged PR so post-merge recovery cannot recreate it', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/merged-recovery',
      targetBranch: 'main',
      title: 'Merged recovery',
    });
    await adapter.merge({ pullRequestId: pr.id, repositoryId: repoId, strategy: 'squash' });
    const found = await adapter.findPullRequestByBranch(repoId, 'feat/merged-recovery');
    expect(found?.id).toBe(pr.id);
    expect(found?.status).toBe('merged');
  });

  it('rejects malformed PR metadata and redacts credentials from the body', async () => {
    const adapter = new MockScmAdapter();
    await expect(
      adapter.createPullRequest({
        repositoryId: repoId,
        sourceBranch: 'main',
        targetBranch: 'main',
        title: 'same branch',
      }),
    ).rejects.toThrow(/must differ/);
    await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/redact',
      targetBranch: 'main',
      title: 'redact',
      body: 'token=super-secret',
    });
    expect(adapter.lastPrBody).not.toContain('super-secret');
    expect(adapter.lastPrBody).toContain('[REDACTED]');
  });

  it('merges a PR with passing checks', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/y',
      targetBranch: 'main',
      title: 'Y',
    });
    adapter.setChecks(pr.id, [{ name: 'ci', status: 'passed' }]);
    const merged = await adapter.merge({
      pullRequestId: pr.id,
      repositoryId: repoId,
      strategy: 'squash',
      requiredChecks: ['ci'],
    });
    expect(merged.status).toBe('merged');
    expect(await adapter.verifyMerged(pr.id)).toBe(true);
  });

  it('refuses merge when required checks fail', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/z',
      targetBranch: 'main',
      title: 'Z',
    });
    adapter.setChecks(pr.id, [{ name: 'ci', status: 'failed' }]);
    await expect(
      adapter.merge({
        pullRequestId: pr.id,
        repositoryId: repoId,
        strategy: 'squash',
        requiredChecks: ['ci'],
      }),
    ).rejects.toBeInstanceOf(ChecksFailedError);
  });

  it('refuses merge when head SHA changed', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/sha',
      targetBranch: 'main',
      title: 'SHA',
    });
    await expect(
      adapter.merge({
        pullRequestId: pr.id,
        repositoryId: repoId,
        strategy: 'squash',
        expectedHeadSha: 'wrong-sha',
      }),
    ).rejects.toBeInstanceOf(MergeRefusedError);
  });

  it('links external task ID in PR body without GitHub close syntax', async () => {
    const adapter = new MockScmAdapter();
    const taskId = 'linear:ENG-42' as never;
    await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/linear',
      targetBranch: 'main',
      title: 'Linear task',
      taskId,
      taskTitle: 'Build the feature',
    });
    // Body must contain task-id comment but NOT 'Closes #'
    expect(adapter.lastPrBody).toContain('dk:task-id:');
    expect(adapter.lastPrBody).not.toMatch(/closes\s+#/i);
  });

  it('returns checks from listChecks', async () => {
    const adapter = new MockScmAdapter();
    const pr = await adapter.createPullRequest({
      repositoryId: repoId,
      sourceBranch: 'feat/chk',
      targetBranch: 'main',
      title: 'C',
    });
    adapter.setChecks(pr.id, [
      { name: 'lint', status: 'passed' },
      { name: 'test', status: 'running' },
    ]);
    const checks = await adapter.listChecks(pr.id);
    expect(checks.find((c) => c.name === 'lint')?.status).toBe('passed');
    expect(checks.find((c) => c.name === 'test')?.status).toBe('running');
  });
});
