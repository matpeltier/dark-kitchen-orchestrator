import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRepositoryId, createTaskId } from '@dark-kitchen/core';

import { GitHubApiError, GitHubScmAdapter, buildGitHubPullRequestContent } from './index.js';
import type { GitHubApiClient } from './index.js';

interface FakePullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged_at: string | null;
  readonly html_url: string;
  readonly merge_commit_sha: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
}

class GitHubApiFixture implements GitHubApiClient {
  public readonly requests: {
    readonly path: string;
    readonly method: string;
    readonly body?: string;
  }[] = [];
  public branchExists = false;
  public merged = false;
  public checkConclusion = 'success';
  public checkStatus = 'completed';
  public headSha = 'head-sha';
  public changeHeadWhenChecksAreRead = false;
  public remoteUrl = 'https://github.com/acme/kitchen.git';

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.requests.push({
      path,
      method: init.method ?? 'GET',
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });

    if (path === '/repos/acme/kitchen') {
      return {
        full_name: 'acme/kitchen',
        name: 'kitchen',
        default_branch: 'main',
        html_url: 'https://github.com/acme/kitchen',
        clone_url: this.remoteUrl,
      } as T;
    }
    if (path.includes('/git/ref/heads/feature%2Ftask-1')) {
      if (!this.branchExists) {
        throw new GitHubApiError(404, 'Reference not found');
      }
      return { object: { sha: 'branch-sha' } } as T;
    }
    if (path.endsWith('/git/refs')) {
      this.branchExists = true;
      return { object: { sha: 'head-sha' } } as T;
    }
    if (path.includes('/pulls/1/merge')) {
      this.merged = true;
      return { merged: true, sha: 'merge-sha', message: 'Merged' } as T;
    }
    if (path.endsWith('/pulls')) {
      return this.pullRequest() as T;
    }
    if (path.endsWith('/pulls/1')) {
      return this.pullRequest() as T;
    }
    if (path.includes('/check-runs')) {
      if (this.changeHeadWhenChecksAreRead) {
        this.headSha = 'changed-sha';
      }
      return {
        check_runs: [
          {
            id: 7,
            name: 'CI',
            status: this.checkStatus,
            conclusion: this.checkConclusion,
            details_url: 'https://github.com/acme/kitchen/actions/runs/7',
          },
        ],
      } as T;
    }
    if (path.includes('/status')) {
      return { statuses: [] } as T;
    }
    throw new Error(`Unhandled fixture request: ${init.method ?? 'GET'} ${path}`);
  }

  private pullRequest(): FakePullRequest {
    return {
      number: 1,
      title: '[Dark Kitchen] Fix flaky test (task-1)',
      state: this.merged ? 'closed' : 'open',
      merged_at: this.merged ? '2026-08-17T00:00:01.000Z' : null,
      html_url: 'https://github.com/acme/kitchen/pull/1',
      merge_commit_sha: this.merged ? 'merge-sha' : null,
      head: { ref: 'feature/task-1', sha: this.headSha },
      base: { ref: 'main', sha: 'base-sha' },
    };
  }
}

const repositoryId = createRepositoryId('acme/kitchen');

describe('GitHub SCM adapter', () => {
  it('pushes a branch, creates a task-linked PR, waits for checks, and verifies a merge', async () => {
    const api = new GitHubApiFixture();
    const events: string[] = [];
    const gitPushes: {
      readonly remoteUrl: string;
      readonly branch: string;
      readonly commitSha: string;
      readonly force: boolean;
    }[] = [];
    const adapter = new GitHubScmAdapter({
      api,
      gitPush: async (input) => {
        gitPushes.push(input);
      },
      requiredChecks: ['CI'],
      mergeStrategy: 'squash',
      eventPublisher: {
        publish: async (event) => {
          events.push(event.type);
        },
      },
    });

    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    expect(repository.defaultBranch).toBe('main');
    expect(await adapter.getRemoteUrl(repository.id)).toBe('https://github.com/acme/kitchen.git');

    const branch = await adapter.pushBranch({
      repositoryId: repository.id,
      branch: 'feature/task-1',
      commitSha: 'head-sha',
    });
    expect(branch.commitSha).toBe('head-sha');
    expect(gitPushes).toEqual([
      {
        remoteUrl: 'https://github.com/acme/kitchen.git',
        branch: 'feature/task-1',
        commitSha: 'head-sha',
        force: false,
      },
    ]);

    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: branch.name,
      targetBranch: repository.defaultBranch,
      task: {
        taskId: createTaskId('task-1'),
        title: 'Fix flaky test',
        trackerReference: {
          provider: 'linear',
          id: 'LIN-1',
          url: 'https://linear.app/acme/issue/LIN-1',
        },
      },
    });
    expect(pullRequest.id).toBe('acme/kitchen#1');

    const merged = await adapter.mergePullRequest({
      pullRequestId: pullRequest.id,
      expectedHeadSha: 'head-sha',
    });
    expect(merged.status).toBe('merged');
    expect(await adapter.verifyPullRequestMerged(pullRequest.id)).toBe(true);
    expect(events).toContain('scm.branch-pushed');
    expect(events).toContain('pull-request.created');
    expect(events).toContain('pull-request.merged');

    const mergeRequest = api.requests.find((request) => request.path.endsWith('/pulls/1/merge'));
    expect(mergeRequest?.path).toBe('/repos/acme/kitchen/pulls/1/merge');
    expect(mergeRequest?.body).toContain('"merge_method":"squash"');
    expect(mergeRequest?.body).toContain('"sha":"head-sha"');
  });

  it('does not report an unknown local commit as pushed', async () => {
    const api = new GitHubApiFixture();
    const remotePath = mkdtempSync(join(tmpdir(), 'scm-github-remote-'));
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    api.remoteUrl = remotePath;
    try {
      const adapter = new GitHubScmAdapter({ api });
      const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });

      await expect(
        adapter.pushBranch({
          repositoryId: repository.id,
          branch: 'feature/task-1',
          commitSha: 'unknown-sha',
        }),
      ).rejects.toThrow('unknown-sha');
      expect(api.requests.some((request) => request.path.endsWith('/git/refs'))).toBe(false);
    } finally {
      rmSync(remotePath, { recursive: true, force: true });
    }
  });

  it('refuses to merge when a required check fails', async () => {
    const api = new GitHubApiFixture();
    api.checkConclusion = 'failure';
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Failed checks',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a merge when required checks remain pending beyond policy', async () => {
    const api = new GitHubApiFixture();
    api.checkStatus = 'in_progress';
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Pending checks',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'did not pass within 0ms',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a merge if the pull request head changes while checks are observed', async () => {
    const api = new GitHubApiFixture();
    api.changeHeadWhenChecksAreRead = true;
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'] });
    await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Changed head',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'head changed unexpectedly',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('links an external tracker task without GitHub close syntax', () => {
    const content = buildGitHubPullRequestContent({
      repositoryId,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      task: {
        taskId: createTaskId('LIN-42'),
        title: 'Ship the adapter',
        trackerReference: {
          provider: 'linear',
          id: 'LIN-42',
          url: 'https://linear.app/acme/issue/LIN-42',
        },
      },
    });

    expect(content.title).toBe('[Dark Kitchen] Ship the adapter (LIN-42)');
    expect(content.body).toContain('[LIN-42](https://linear.app/acme/issue/LIN-42)');
    expect(content.body).not.toContain('Closes #');
  });

  it('qualifies a cross-repository GitHub tracker issue in close syntax', () => {
    const content = buildGitHubPullRequestContent({
      repositoryId,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      task: {
        taskId: createTaskId('other-repo-42'),
        title: 'Link the external issue',
        trackerReference: {
          provider: 'github',
          id: 'other/repo#42',
          url: 'https://github.com/other/repo/issues/42',
        },
      },
    });

    expect(content.body).toContain('Closes other/repo#42');
    expect(content.body).not.toContain('Closes #42');
  });
});
