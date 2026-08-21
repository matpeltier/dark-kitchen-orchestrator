import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { CheckPollPolicy } from './contracts.js';
import { ChecksFailedError, MergeRefusedError, ScmError } from './contracts.js';
import { GitHubScmAdapter } from './github-scm.js';

const OWNER = 'dark-kitchen';
const REPO = 'orchestrator';

interface PrPayload {
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string;
  head?: { ref: string; sha: string };
  base?: { ref: string };
  html_url?: string;
  merged?: boolean | null;
  merged_at?: string | null;
}

function prPayload(overrides: PrPayload = {}): PrPayload {
  return {
    number: 7,
    title: '[DK] Task task-1: Implement feature',
    body: 'Body',
    state: 'open',
    head: { ref: 'feat/task-1', sha: 'head-sha-1' },
    base: { ref: 'main' },
    html_url: `https://github.com/${OWNER}/${REPO}/pull/7`,
    merged: false,
    merged_at: null,
    ...overrides,
  };
}

function makeOctokit() {
  return {
    repos: { get: vi.fn() },
    pulls: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      merge: vi.fn(),
    },
    checks: { listForRef: vi.fn() },
    git: { deleteRef: vi.fn() },
  };
}

function makeAdapter(octokit: ReturnType<typeof makeOctokit>): GitHubScmAdapter {
  return new GitHubScmAdapter(
    { owner: OWNER, repo: REPO, token: 'test-token' },
    octokit as unknown as Octokit,
  );
}

describe('GitHubScmAdapter', () => {
  describe('createPullRequest', () => {
    it('creates a pull request and normalizes the result', async () => {
      const octokit = makeOctokit();
      octokit.pulls.list.mockResolvedValue({ data: [] });
      octokit.pulls.create.mockResolvedValue({ data: prPayload() });
      const adapter = makeAdapter(octokit);

      const pr = await adapter.createPullRequest({
        repositoryId: `github:${OWNER}/${REPO}` as never,
        sourceBranch: 'feat/task-1',
        targetBranch: 'main',
        title: 'Implement feature',
        body: 'Summary of the change',
        taskId: 'task-1' as never,
      });

      expect(octokit.pulls.create).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        head: 'feat/task-1',
        base: 'main',
        title: 'Implement feature',
        body: expect.stringContaining('Summary of the change'),
      });
      expect(pr.id).toBe(`github:${OWNER}/${REPO}#7`);
      expect(pr.status).toBe('open');
      expect(pr.sourceBranch).toBe('feat/task-1');
      expect(pr.targetBranch).toBe('main');
      expect(pr.headSha).toBe('head-sha-1');
    });

    it('redacts secrets in the title', async () => {
      const octokit = makeOctokit();
      octokit.pulls.list.mockResolvedValue({ data: [] });
      octokit.pulls.create.mockResolvedValue({ data: prPayload() });
      const adapter = makeAdapter(octokit);

      await adapter.createPullRequest({
        repositoryId: `github:${OWNER}/${REPO}` as never,
        sourceBranch: 'feat/task-1',
        targetBranch: 'main',
        title: 'Use token ghp_abcdefghijklmnopqrstuvwxyz012345 here',
      });

      expect(octokit.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Use token [REDACTED] here' }),
      );
    });

    it('reuses an existing open pull request for the same branch', async () => {
      const octokit = makeOctokit();
      octokit.pulls.list.mockResolvedValue({
        data: [
          prPayload({
            number: 3,
            state: 'open',
            head: { ref: 'feat/task-1', sha: 'head-sha-old' },
            html_url: `https://github.com/${OWNER}/${REPO}/pull/3`,
          }),
        ],
      });
      const adapter = makeAdapter(octokit);

      const pr = await adapter.createPullRequest({
        repositoryId: `github:${OWNER}/${REPO}` as never,
        sourceBranch: 'feat/task-1',
        targetBranch: 'main',
        title: 'Implement feature',
      });

      expect(octokit.pulls.create).not.toHaveBeenCalled();
      expect(pr.number).toBe(3);
    });
  });

  describe('updatePullRequestBody', () => {
    it('updates the body via the API and returns the refreshed PR', async () => {
      const octokit = makeOctokit();
      octokit.pulls.update.mockResolvedValue({ data: prPayload({ body: 'Fresh proofs' }) });
      const adapter = makeAdapter(octokit);

      const pr = await adapter.updatePullRequestBody({
        pullRequestId: `github:${OWNER}/${REPO}#7` as never,
        body: 'Fresh proofs',
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        pull_number: 7,
        body: 'Fresh proofs',
      });
      expect(pr.number).toBe(7);
    });

    it('redacts secrets in the updated body', async () => {
      const octokit = makeOctokit();
      octokit.pulls.update.mockResolvedValue({ data: prPayload() });
      const adapter = makeAdapter(octokit);

      await adapter.updatePullRequestBody({
        pullRequestId: `github:${OWNER}/${REPO}#7` as never,
        body: 'Evidence: https://example.com?token=supersecret value',
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Evidence: https://example.com?token=[REDACTED] value' }),
      );
    });
  });

  describe('pollChecks', () => {
    it('rejects invalid poll policies', async () => {
      const adapter = makeAdapter(makeOctokit());
      const policy = { intervalMs: 0, timeoutMs: 1000 } satisfies CheckPollPolicy;
      await expect(
        adapter.pollChecks(`github:${OWNER}/${REPO}#7` as never, policy),
      ).rejects.toThrow(ScmError);
      const negativeTimeout = { intervalMs: 100, timeoutMs: -1 } satisfies CheckPollPolicy;
      await expect(
        adapter.pollChecks(`github:${OWNER}/${REPO}#7` as never, negativeTimeout),
      ).rejects.toThrow(ScmError);
    });

    it('returns immediately once every required check is terminal', async () => {
      const octokit = makeOctokit();
      octokit.pulls.get.mockResolvedValue({
        data: prPayload({ head: { ref: 'feat/task-1', sha: 'head-sha-1' } }),
      });
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            { id: 1, name: 'ci', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' },
          ],
        },
      });
      const adapter = makeAdapter(octokit);

      const checks = await adapter.pollChecks(`github:${OWNER}/${REPO}#7` as never, {
        intervalMs: 10,
        timeoutMs: 1000,
        requiredChecks: ['ci', 'lint'],
      });

      expect(checks.map((check) => ({ name: check.name, status: check.status }))).toEqual([
        { name: 'ci', status: 'passed' },
        { name: 'lint', status: 'failed' },
      ]);
      expect(octokit.checks.listForRef).toHaveBeenCalledTimes(1);
    });
  });

  describe('merge', () => {
    function setupMergeablePr(octokit: ReturnType<typeof makeOctokit>, headSha = 'head-sha-1') {
      octokit.pulls.get.mockResolvedValue({
        data: prPayload({ head: { ref: 'feat/task-1', sha: headSha } }),
      });
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
        },
      });
    }

    it('merges with the requested strategy and returns the refreshed PR', async () => {
      const octokit = makeOctokit();
      setupMergeablePr(octokit);
      octokit.pulls.merge.mockResolvedValue({
        data: { merged: true, sha: 'merge-sha' },
      });
      const adapter = makeAdapter(octokit);

      const pr = await adapter.merge({
        pullRequestId: `github:${OWNER}/${REPO}#7` as never,
        repositoryId: `github:${OWNER}/${REPO}` as never,
        strategy: 'squash',
        expectedHeadSha: 'head-sha-1',
        requiredChecks: ['ci'],
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        pull_number: 7,
        merge_method: 'squash',
      });
      expect(pr.number).toBe(7);
    });

    it('refuses to merge when the head SHA changed since verification (anti force-push)', async () => {
      const octokit = makeOctokit();
      setupMergeablePr(octokit, 'head-sha-2');
      const adapter = makeAdapter(octokit);

      await expect(
        adapter.merge({
          pullRequestId: `github:${OWNER}/${REPO}#7` as never,
          repositoryId: `github:${OWNER}/${REPO}` as never,
          strategy: 'squash',
          expectedHeadSha: 'head-sha-1',
        }),
      ).rejects.toThrow(MergeRefusedError);

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
    });

    it('refuses to merge when a required check did not pass', async () => {
      const octokit = makeOctokit();
      octokit.pulls.get.mockResolvedValue({
        data: prPayload({ head: { ref: 'feat/task-1', sha: 'head-sha-1' } }),
      });
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure' }],
        },
      });
      const adapter = makeAdapter(octokit);

      await expect(
        adapter.merge({
          pullRequestId: `github:${OWNER}/${REPO}#7` as never,
          repositoryId: `github:${OWNER}/${REPO}` as never,
          strategy: 'squash',
          requiredChecks: ['ci'],
        }),
      ).rejects.toThrow(ChecksFailedError);

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
    });

    it('wraps API merge failures in MergeRefusedError', async () => {
      const octokit = makeOctokit();
      setupMergeablePr(octokit);
      octokit.pulls.merge.mockRejectedValue(new Error('Merge conflict'));
      const adapter = makeAdapter(octokit);

      await expect(
        adapter.merge({
          pullRequestId: `github:${OWNER}/${REPO}#7` as never,
          repositoryId: `github:${OWNER}/${REPO}` as never,
          strategy: 'merge',
          expectedHeadSha: 'head-sha-1',
        }),
      ).rejects.toThrow(MergeRefusedError);
    });
  });

  describe('verifyMerged', () => {
    it('returns true only when the PR is closed and merged', async () => {
      const octokit = makeOctokit();
      const adapter = makeAdapter(octokit);

      octokit.pulls.get.mockResolvedValue({
        data: prPayload({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' }),
      });
      await expect(adapter.verifyMerged(`github:${OWNER}/${REPO}#7` as never)).resolves.toBe(true);

      octokit.pulls.get.mockResolvedValue({ data: prPayload({ state: 'open' }) });
      await expect(adapter.verifyMerged(`github:${OWNER}/${REPO}#7` as never)).resolves.toBe(false);

      octokit.pulls.get.mockResolvedValue({
        data: prPayload({ state: 'closed', merged: false }),
      });
      await expect(adapter.verifyMerged(`github:${OWNER}/${REPO}#7` as never)).resolves.toBe(false);
    });
  });
});
