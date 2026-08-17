import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPullRequestId, createRepositoryId, createTaskId } from '@dark-kitchen/core';

import {
  GitHubApiError,
  GitHubScmAdapter,
  RequiredChecksTimeoutError,
  buildGitHubPullRequestContent,
  pushGitBranch,
} from './index.js';
import type { GitHubApiClient, GitHubGitExecutor } from './index.js';

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

interface FakeCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly details_url?: string;
}

interface FakeCommitStatus {
  readonly id: number;
  readonly context: string;
  readonly state: string;
  readonly target_url?: string;
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
  public includeCheckRun = true;
  public statuses: readonly FakeCommitStatus[] = [];
  public readonly checkRunsByCommit = new Map<string, readonly FakeCheckRun[]>();
  public readonly statusesByCommit = new Map<string, readonly FakeCommitStatus[]>();
  public headSha = 'head-sha';
  public mergeCommitSha: string | null = null;
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
      const commitSha = fixtureCommitSha(path);
      if (this.changeHeadWhenChecksAreRead) {
        this.headSha = 'changed-sha';
      }
      const configuredCheckRuns = this.checkRunsByCommit.get(commitSha);
      const checkRuns =
        configuredCheckRuns ??
        (this.includeCheckRun
          ? [
              {
                id: 7,
                name: 'CI',
                status: this.checkStatus,
                conclusion: this.checkConclusion,
                details_url: 'https://github.com/acme/kitchen/actions/runs/7',
              },
            ]
          : []);
      return {
        check_runs: fixturePage(path, checkRuns),
      } as T;
    }
    if (path.includes('/status')) {
      const statuses = this.statusesByCommit.get(fixtureCommitSha(path)) ?? this.statuses;
      return { statuses: fixturePage(path, statuses) } as T;
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
      merge_commit_sha: this.merged ? 'merge-sha' : this.mergeCommitSha,
      head: { ref: 'feature/task-1', sha: this.headSha },
      base: { ref: 'main', sha: 'base-sha' },
    };
  }
}

function fixtureCommitSha(path: string): string {
  const commitSha = path.match(/\/commits\/([^/]+)\//)?.[1];
  if (commitSha === undefined) {
    throw new Error(`Fixture request has no commit SHA: ${path}`);
  }
  return decodeURIComponent(commitSha);
}

function fixturePage<T>(path: string, items: readonly T[]): readonly T[] {
  const searchParams = new URL(path, 'https://api.github.test').searchParams;
  const page = Number(searchParams.get('page') ?? '1');
  const perPage = Number(searchParams.get('per_page') ?? '30');
  return items.slice((page - 1) * perPage, page * perPage);
}

function fakeCheckRun(id: number, name: string, conclusion: string): FakeCheckRun {
  return { id, name, status: 'completed', conclusion };
}

function fakeCommitStatus(id: number, context: string, state: string): FakeCommitStatus {
  return { id, context, state };
}

const opaqueRepositoryId = createRepositoryId('repository-01HRQX7E8W9KFAKEOPAQUE');

describe('GitHub SCM adapter', () => {
  it('pushes a branch, creates a task-linked PR, waits for checks, and verifies a merge', async () => {
    const api = new GitHubApiFixture();
    const events: string[] = [];
    const gitPushes: {
      readonly remoteUrl: string;
      readonly branch: string;
      readonly commitSha: string;
      readonly worktreePath: string;
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
    expect(repository.id).toBe('scm:github:repository:acme/kitchen');
    expect(repository.id).not.toBe(repository.reference.id);
    expect(repository.defaultBranch).toBe('main');
    expect(await adapter.getRemoteUrl(repository.id)).toBe('https://github.com/acme/kitchen.git');

    const branch = await adapter.pushBranch({
      repositoryId: repository.id,
      branch: 'feature/task-1',
      commitSha: 'head-sha',
      worktreePath: process.cwd(),
    });
    expect(branch.commitSha).toBe('head-sha');
    expect(gitPushes).toEqual([
      {
        remoteUrl: 'https://github.com/acme/kitchen.git',
        branch: 'feature/task-1',
        commitSha: 'head-sha',
        worktreePath: process.cwd(),
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
    expect(pullRequest.id).toBe('scm:github:pull-request:acme/kitchen#1');
    expect(pullRequest.id).not.toBe(pullRequest.reference.id);
    expect(pullRequest.url).toBe('https://github.com/acme/kitchen/pull/1');

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
          worktreePath: remotePath,
        }),
      ).rejects.toThrow('unknown-sha');
      expect(api.requests.some((request) => request.path.endsWith('/git/refs'))).toBe(false);
    } finally {
      rmSync(remotePath, { recursive: true, force: true });
    }
  });

  it('does not treat GitHub provider references as repository or pull request domain IDs', async () => {
    const api = new GitHubApiFixture();
    const adapter = new GitHubScmAdapter({ api });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });

    await expect(adapter.getRemoteUrl(createRepositoryId('acme/kitchen'))).rejects.toThrow(
      'is not cached',
    );
    await expect(
      adapter.getPullRequest(repository.id, createPullRequestId('acme/kitchen#1')),
    ).rejects.toThrow('Invalid GitHub pull request ID');
  });

  it('looks up repositories and pull requests from namespaced domain IDs after a restart', async () => {
    const api = new GitHubApiFixture();
    const firstAdapter = new GitHubScmAdapter({ api });
    const repository = await firstAdapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await firstAdapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Stable lookup',
    });

    const restartedAdapter = new GitHubScmAdapter({ api });
    await expect(
      restartedAdapter.getPullRequest(repository.id, pullRequest.id),
    ).resolves.toMatchObject({
      id: pullRequest.id,
      repositoryId: repository.id,
      reference: { id: 'acme/kitchen#1' },
    });
  });

  it('pushes a verified commit from the supplied worktree when the process cwd is unrelated', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'scm-github-worktree-'));
    const remotePath = join(rootPath, 'remote.git');
    const repositoryPath = join(rootPath, 'repository');
    const worktreePath = join(rootPath, 'worktree');
    const unrelatedPath = mkdtempSync(join(tmpdir(), 'scm-github-unrelated-'));
    mkdirSync(repositoryPath);
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    writeFileSync(join(repositoryPath, 'README.md'), 'worktree commit\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'worktree commit'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });

    const api = new GitHubApiFixture();
    api.remoteUrl = remotePath;
    const adapter = new GitHubScmAdapter({ api });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    let pushedCommitSha: string;
    const originalCwd = process.cwd();
    try {
      process.chdir(unrelatedPath);
      await adapter.pushBranch({
        repositoryId: repository.id,
        branch: 'feature/task-1',
        commitSha,
        worktreePath,
      });
      pushedCommitSha = execFileSync(
        'git',
        ['--git-dir', remotePath, 'rev-parse', 'refs/heads/feature/task-1'],
        { encoding: 'utf8' },
      ).trim();
    } finally {
      process.chdir(originalCwd);
      rmSync(rootPath, { recursive: true, force: true });
      rmSync(unrelatedPath, { recursive: true, force: true });
    }

    expect(pushedCommitSha).toBe(commitSha);
  });

  it('rejects an empty commit SHA without deleting an existing remote branch', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'scm-github-invalid-sha-'));
    const remotePath = join(rootPath, 'remote.git');
    const repositoryPath = join(rootPath, 'repository');
    const worktreePath = join(rootPath, 'worktree');
    mkdirSync(repositoryPath);
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    writeFileSync(join(repositoryPath, 'README.md'), 'existing branch\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'existing branch'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });

    const api = new GitHubApiFixture();
    api.remoteUrl = remotePath;
    const adapter = new GitHubScmAdapter({ api });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    await adapter.pushBranch({
      repositoryId: repository.id,
      branch: 'feature/task-1',
      commitSha,
      worktreePath,
    });
    const existingBranchSha = execFileSync(
      'git',
      ['--git-dir', remotePath, 'rev-parse', 'refs/heads/feature/task-1'],
      { encoding: 'utf8' },
    ).trim();

    await expect(
      adapter.pushBranch({
        repositoryId: repository.id,
        branch: 'feature/task-1',
        commitSha: '',
        worktreePath,
      }),
    ).rejects.toThrow('Git commit SHA must not be empty');
    expect(
      execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'refs/heads/feature/task-1'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(existingBranchSha);
    rmSync(rootPath, { recursive: true, force: true });
  });

  it('uses GitHub HTTP Basic x-access-token authentication for Git pushes', async () => {
    const commitSha = 'a'.repeat(40);
    const worktreePath = '/tmp/task-worktree';
    const calls: {
      readonly args: readonly string[];
      readonly options: Parameters<GitHubGitExecutor>[2];
    }[] = [];
    const runGit: GitHubGitExecutor = async (_file, args, options) => {
      calls.push({ args, options });
      return { stdout: `${commitSha}\n`, stderr: '' };
    };

    await pushGitBranch(
      {
        remoteUrl: 'https://github.com/acme/kitchen.git',
        branch: 'feature/task-1',
        commitSha,
        worktreePath,
        force: false,
      },
      { token: 'ghp-test-token' },
      runGit,
    );

    expect(calls[0]?.args).toEqual([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${commitSha}^{commit}`,
    ]);
    expect(calls[1]?.args).toEqual([
      'push',
      'https://github.com/acme/kitchen.git',
      `${commitSha}:refs/heads/feature/task-1`,
    ]);
    expect(calls[1]?.options.cwd).toBe(worktreePath);
    expect(calls[1]?.options.env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghp-test-token').toString('base64')}`,
    );
  });

  it('validates branch names at the Git push boundary', async () => {
    const runGit: GitHubGitExecutor = async () => ({ stdout: `${'a'.repeat(40)}\n`, stderr: '' });

    await expect(
      pushGitBranch(
        {
          remoteUrl: 'https://github.com/acme/kitchen.git',
          branch: 'feature/../unsafe',
          commitSha: 'a'.repeat(40),
          worktreePath: '/tmp/task-worktree',
          force: false,
        },
        { token: undefined },
        runGit,
      ),
    ).rejects.toThrow('Invalid GitHub branch name');
  });

  it('does not reuse branch-pushed event IDs across adapter instances', async () => {
    const api = new GitHubApiFixture();
    const eventIds: string[] = [];
    const options = {
      api,
      gitPush: async () => undefined,
      eventPublisher: {
        publish: async (event: { readonly id: string }) => {
          eventIds.push(event.id);
        },
      },
    };
    const firstAdapter = new GitHubScmAdapter(options);
    const secondAdapter = new GitHubScmAdapter(options);
    const firstRepository = await firstAdapter.getRepository({
      provider: 'github',
      id: 'acme/kitchen',
    });
    const secondRepository = await secondAdapter.getRepository({
      provider: 'github',
      id: 'acme/kitchen',
    });

    await firstAdapter.pushBranch({
      repositoryId: firstRepository.id,
      branch: 'feature/task-1',
      commitSha: 'head-sha',
      worktreePath: process.cwd(),
    });
    await secondAdapter.pushBranch({
      repositoryId: secondRepository.id,
      branch: 'feature/task-1',
      commitSha: 'head-sha',
      worktreePath: process.cwd(),
    });

    expect(eventIds).toHaveLength(2);
    expect(new Set(eventIds).size).toBe(2);
  });

  it('refuses to merge when a required check fails', async () => {
    const api = new GitHubApiFixture();
    api.checkConclusion = 'failure';
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Failed checks',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('uses test-merge checks when they differ from passing head checks', async () => {
    const api = new GitHubApiFixture();
    api.mergeCommitSha = 'test-merge-sha';
    api.checkRunsByCommit.set('head-sha', [fakeCheckRun(7, 'CI', 'success')]);
    api.checkRunsByCommit.set('test-merge-sha', [fakeCheckRun(8, 'CI', 'failure')]);
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Test merge checks',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(
      api.requests.some((request) => request.path.includes('/commits/test-merge-sha/check-runs')),
    ).toBe(true);
    expect(
      api.requests.some((request) => request.path.includes('/commits/head-sha/check-runs')),
    ).toBe(false);
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('accepts passing test-merge checks when the required head check is absent', async () => {
    const api = new GitHubApiFixture();
    api.mergeCommitSha = 'test-merge-sha';
    api.checkRunsByCommit.set('head-sha', []);
    api.checkRunsByCommit.set('test-merge-sha', [fakeCheckRun(8, 'CI', 'success')]);
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Passing test merge checks',
    });

    await expect(
      adapter.mergePullRequest({ pullRequestId: pullRequest.id }),
    ).resolves.toMatchObject({ status: 'merged' });
    expect(
      api.requests.some((request) => request.path.includes('/commits/test-merge-sha/check-runs')),
    ).toBe(true);
    expect(
      api.requests.some((request) => request.path.includes('/commits/head-sha/check-runs')),
    ).toBe(false);
  });

  it('falls back to head checks when the test-merge commit has no statuses', async () => {
    const api = new GitHubApiFixture();
    api.mergeCommitSha = 'test-merge-sha';
    api.checkRunsByCommit.set('test-merge-sha', []);
    api.statusesByCommit.set('test-merge-sha', []);
    api.checkRunsByCommit.set('head-sha', [fakeCheckRun(7, 'CI', 'success')]);
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Head fallback checks',
    });

    await expect(
      adapter.mergePullRequest({ pullRequestId: pullRequest.id }),
    ).resolves.toMatchObject({ status: 'merged' });
    expect(
      api.requests.some((request) => request.path.includes('/commits/test-merge-sha/check-runs')),
    ).toBe(true);
    expect(
      api.requests.some((request) => request.path.includes('/commits/head-sha/check-runs')),
    ).toBe(true);
  });

  it('refuses a same-named failing required check run beyond page 1', async () => {
    const api = new GitHubApiFixture();
    api.checkRunsByCommit.set('head-sha', [
      fakeCheckRun(1, 'CI', 'success'),
      ...Array.from({ length: 99 }, (_, index) =>
        fakeCheckRun(index + 2, `Optional check ${index + 1}`, 'success'),
      ),
      fakeCheckRun(101, 'CI', 'failure'),
    ]);
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Paginated check runs',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(
      api.requests.some((request) => request.path.endsWith('/check-runs?per_page=100&page=2')),
    ).toBe(true);
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a failing required commit status beyond page 1', async () => {
    const api = new GitHubApiFixture();
    api.includeCheckRun = false;
    api.statuses = [
      ...Array.from({ length: 100 }, (_, index) =>
        fakeCommitStatus(index + 1, `Optional status ${index + 1}`, 'success'),
      ),
      fakeCommitStatus(101, 'CI', 'failure'),
    ];
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Paginated commit statuses',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(
      api.requests.some((request) => request.path.endsWith('/status?per_page=100&page=2')),
    ).toBe(true);
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('pessimistically combines same-named check runs and commit statuses', async () => {
    const api = new GitHubApiFixture();
    api.statuses = [
      {
        id: 8,
        context: 'CI',
        state: 'failure',
        target_url: 'https://github.com/acme/kitchen/statuses/8',
      },
    ];
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Colliding checks',
    });

    await expect(adapter.listChecks(pullRequest.id)).resolves.toMatchObject([
      { name: 'CI', status: 'failed' },
    ]);
    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'Required checks failed: CI.',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a merge when required checks remain pending beyond policy', async () => {
    const api = new GitHubApiFixture();
    api.checkStatus = 'in_progress';
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'], checkTimeoutMs: 0 });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Pending checks',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'did not pass within 0ms',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('reports an absent required check explicitly when the check policy times out', async () => {
    const api = new GitHubApiFixture();
    api.includeCheckRun = false;
    const adapter = new GitHubScmAdapter({
      api,
      requiredChecks: ['CI'],
      checkTimeoutMs: 0,
    });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Absent check',
    });

    let timeoutError: unknown;
    try {
      await adapter.mergePullRequest({ pullRequestId: pullRequest.id });
    } catch (error) {
      timeoutError = error;
    }

    expect(timeoutError).toBeInstanceOf(RequiredChecksTimeoutError);
    if (!(timeoutError instanceof RequiredChecksTimeoutError)) {
      throw timeoutError;
    }
    expect(timeoutError.checks).toEqual([]);
    expect(timeoutError.missingChecks).toEqual(['CI']);
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a merge if the pull request head changes while checks are observed', async () => {
    const api = new GitHubApiFixture();
    api.changeHeadWhenChecksAreRead = true;
    const adapter = new GitHubScmAdapter({ api, requiredChecks: ['CI'] });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Changed head',
    });

    await expect(adapter.mergePullRequest({ pullRequestId: pullRequest.id })).rejects.toThrow(
      'head changed unexpectedly',
    );
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('refuses a merge strategy that differs from the configured policy', async () => {
    const api = new GitHubApiFixture();
    const adapter = new GitHubScmAdapter({ api, mergeStrategy: 'squash' });
    const repository = await adapter.getRepository({ provider: 'github', id: 'acme/kitchen' });
    const pullRequest = await adapter.createPullRequest({
      repositoryId: repository.id,
      sourceBranch: 'feature/task-1',
      targetBranch: 'main',
      title: 'Policy check',
    });

    await expect(
      adapter.mergePullRequest({ pullRequestId: pullRequest.id, mergeStrategy: 'rebase' }),
    ).rejects.toThrow('configured strategy is squash');
    expect(api.requests.some((request) => request.path.endsWith('/pulls/1/merge'))).toBe(false);
  });

  it('links an external tracker task without GitHub close syntax', () => {
    const content = buildGitHubPullRequestContent({
      repositoryId: opaqueRepositoryId,
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
      repositoryId: opaqueRepositoryId,
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

  it('qualifies a same-repository GitHub tracker issue when only its number is normalized', () => {
    const content = buildGitHubPullRequestContent(
      {
        repositoryId: opaqueRepositoryId,
        sourceBranch: 'feature/task-1',
        targetBranch: 'main',
        task: {
          taskId: createTaskId('42'),
          title: 'Link the local issue',
          trackerReference: { provider: 'github', id: '#42' },
        },
      },
      { provider: 'github', id: 'acme/kitchen' },
    );

    expect(content.body).toContain('Closes acme/kitchen#42');
  });
});
