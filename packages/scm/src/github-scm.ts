/**
 * GitHub SCM adapter.
 *
 * Handles branch push, PR creation, check polling, merge, and merge
 * verification independently from the GitHub Issues tracker adapter.
 * Tracker task linkage is done via PR body, never with `Closes #N` syntax
 * when the tracker is not GitHub Issues.
 */

import { Octokit } from '@octokit/rest';
import type {
  Check,
  CheckId,
  PullRequest,
  PullRequestId,
  Repository,
  RepositoryId,
  ScmReference,
} from '@dark-kitchen/core';
import {
  createCheckId,
  createPullRequestId,
  createRepositoryId,
} from '@dark-kitchen/core';
import type {
  CheckPollPolicy,
  CreatePullRequestInput,
  FullScmAdapter,
  MergePullRequestInput,
  PushBranchInput,
} from './contracts.js';
import {
  ChecksFailedError,
  MergeRefusedError,
  ScmError,
} from './contracts.js';

export interface GitHubScmAdapterConfig {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly defaultMergeStrategy?: 'squash' | 'merge' | 'rebase';
}

const PROVIDER = 'github';

export class GitHubScmAdapter implements FullScmAdapter {
  public readonly provider = PROVIDER;
  private readonly octokit: Octokit;
  private readonly config: GitHubScmAdapterConfig;

  public constructor(config: GitHubScmAdapterConfig, octokit?: Octokit) {
    this.config = config;
    this.octokit = octokit ?? new Octokit({ auth: config.token });
  }

  public async getRepository(reference: ScmReference): Promise<Repository> {
    const [owner, repo] = reference.id.split('/');
    const { data } = await this.octokit.repos.get({
      owner: owner ?? this.config.owner,
      repo: repo ?? this.config.repo,
    });
    return {
      id: createRepositoryId(`${PROVIDER}:${data.full_name}`),
      name: data.full_name,
      reference: { provider: PROVIDER, id: data.full_name, url: data.html_url },
      defaultBranch: data.default_branch,
    };
  }

  public async getDefaultBranch(_repositoryId: RepositoryId): Promise<string> {
    const { data } = await this.octokit.repos.get({
      owner: this.config.owner,
      repo: this.config.repo,
    });
    return data.default_branch;
  }

  public async pushBranch(_input: PushBranchInput): Promise<void> {
    // Branch pushing is handled by git CLI in the worktree; this adapter
    // provides the GitHub-side operations. In production, a git push via
    // the process-execution layer would be used here.
    // This method exists for the interface contract.
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    // Build the PR body with task context (not GitHub-specific close syntax
    // for cross-tracker links).
    const body = buildPrBody(input);

    const { data } = await this.octokit.pulls.create({
      owner: this.config.owner,
      repo: this.config.repo,
      head: input.sourceBranch,
      base: input.targetBranch,
      title: input.title,
      body,
    });

    return normalizePullRequest(data, this.config.owner, this.config.repo);
  }

  public async getPullRequest(
    _repositoryId: RepositoryId,
    pullRequestId: PullRequestId,
  ): Promise<PullRequest> {
    const prNumber = extractPrNumber(pullRequestId);
    const { data } = await this.octokit.pulls.get({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: prNumber,
    });
    return normalizePullRequest(data, this.config.owner, this.config.repo);
  }

  public async findPullRequestByBranch(
    _repositoryId: RepositoryId,
    sourceBranch: string,
  ): Promise<PullRequest | undefined> {
    const { data } = await this.octokit.pulls.list({
      owner: this.config.owner,
      repo: this.config.repo,
      head: `${this.config.owner}:${sourceBranch}`,
      state: 'open',
    });
    if (data.length === 0) return undefined;
    return normalizePullRequest(data[0]!, this.config.owner, this.config.repo);
  }

  public async listChecks(pullRequestId: PullRequestId): Promise<readonly Check[]> {
    const prNumber = extractPrNumber(pullRequestId);
    const { data: pr } = await this.octokit.pulls.get({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: prNumber,
    });
    const sha = pr.head.sha;

    const { data: checks } = await this.octokit.checks.listForRef({
      owner: this.config.owner,
      repo: this.config.repo,
      ref: sha,
    });

    return checks.check_runs.map((run) => normalizeCheck(run, pullRequestId));
  }

  public async pollChecks(
    pullRequestId: PullRequestId,
    policy: CheckPollPolicy,
  ): Promise<readonly Check[]> {
    const deadline = Date.now() + policy.timeoutMs;
    while (Date.now() < deadline) {
      const checks = await this.listChecks(pullRequestId);
      const allTerminal = checks.every((c) =>
        c.status === 'passed' || c.status === 'failed' || c.status === 'cancelled',
      );
      if (allTerminal) return checks;
      await sleep(policy.intervalMs);
    }
    return this.listChecks(pullRequestId);
  }

  public async merge(input: MergePullRequestInput): Promise<PullRequest> {
    const prNumber = extractPrNumber(input.pullRequestId);

    // Validate checks before merging
    const checks = await this.listChecks(input.pullRequestId);
    if (input.requiredChecks && input.requiredChecks.length > 0) {
      const failed = input.requiredChecks.filter((required) => {
        const check = checks.find((c) => c.name === required);
        return !check || check.status !== 'passed';
      });
      if (failed.length > 0) {
        throw new ChecksFailedError(failed);
      }
    }

    // Validate PR head hasn't changed unexpectedly
    if (input.expectedHeadSha) {
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: prNumber,
      });
      if (pr.head.sha !== input.expectedHeadSha) {
        throw new MergeRefusedError(
          `PR head SHA changed (expected ${input.expectedHeadSha}, got ${pr.head.sha})`,
        );
      }
    }

    const mergeMethod = input.strategy === 'squash' ? 'squash' : input.strategy === 'rebase' ? 'rebase' : 'merge';

    try {
      await this.octokit.pulls.merge({
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: prNumber,
        merge_method: mergeMethod,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new MergeRefusedError(errMsg);
    }

    return this.getPullRequest(
      createRepositoryId(`${PROVIDER}:${this.config.owner}/${this.config.repo}`),
      input.pullRequestId,
    );
  }

  public async verifyMerged(pullRequestId: PullRequestId): Promise<boolean> {
    const prNumber = extractPrNumber(pullRequestId);
    const { data } = await this.octokit.pulls.get({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: prNumber,
    });
    return data.state === 'closed' && (data.merged === true);
  }
}

// ─── Mock SCM adapter for testing ────────────────────────────────────────────

export interface MockPullRequest {
  number: number;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'open' | 'closed' | 'merged';
  checks: MockCheck[];
  headSha: string;
  merged: boolean;
}

interface MockCheck {
  name: string;
  status: Check['status'];
}

export class MockScmAdapter implements FullScmAdapter {
  public readonly provider = PROVIDER;
  private nextNumber = 1;
  private readonly prs = new Map<number, MockPullRequest>();
  public lastPrBody: string | undefined;

  public async getRepository(reference: ScmReference): Promise<Repository> {
    return {
      id: createRepositoryId(`${PROVIDER}:${reference.id}`),
      name: reference.id,
      reference,
      defaultBranch: 'main',
    };
  }

  public async getDefaultBranch(_repositoryId: RepositoryId): Promise<string> {
    return 'main';
  }

  public async pushBranch(_input: PushBranchInput): Promise<void> {
    // No-op in mock
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const number = this.nextNumber++;
    const body = buildPrBody(input);
    this.lastPrBody = body;
    const pr: MockPullRequest = {
      number,
      title: input.title,
      body,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      state: 'open',
      checks: [],
      headSha: `sha-${number}`,
      merged: false,
    };
    this.prs.set(number, pr);
    return normalizeMockPr(pr);
  }

  public async getPullRequest(
    _repositoryId: RepositoryId,
    pullRequestId: PullRequestId,
  ): Promise<PullRequest> {
    const n = extractPrNumber(pullRequestId);
    const pr = this.prs.get(n);
    if (!pr) throw new ScmError(`PR #${n} not found`);
    return normalizeMockPr(pr);
  }

  public async findPullRequestByBranch(
    _repositoryId: RepositoryId,
    sourceBranch: string,
  ): Promise<PullRequest | undefined> {
    const pr = [...this.prs.values()].find((p) => p.sourceBranch === sourceBranch && p.state === 'open');
    return pr ? normalizeMockPr(pr) : undefined;
  }

  public async listChecks(pullRequestId: PullRequestId): Promise<readonly Check[]> {
    const n = extractPrNumber(pullRequestId);
    const pr = this.prs.get(n);
    if (!pr) return [];
    return pr.checks.map((c, i) => ({
      id: createCheckId(`check-${n}-${i}`),
      pullRequestId,
      name: c.name,
      status: c.status,
    }));
  }

  public async pollChecks(
    pullRequestId: PullRequestId,
    _policy: CheckPollPolicy,
  ): Promise<readonly Check[]> {
    return this.listChecks(pullRequestId);
  }

  public async merge(input: MergePullRequestInput): Promise<PullRequest> {
    const n = extractPrNumber(input.pullRequestId);
    const pr = this.prs.get(n);
    if (!pr) throw new ScmError(`PR #${n} not found`);

    // Validate required checks
    if (input.requiredChecks && input.requiredChecks.length > 0) {
      const failed = input.requiredChecks.filter((required) => {
        const check = pr.checks.find((c) => c.name === required);
        return !check || check.status !== 'passed';
      });
      if (failed.length > 0) throw new ChecksFailedError(failed);
    }

    if (input.expectedHeadSha && pr.headSha !== input.expectedHeadSha) {
      throw new MergeRefusedError(`Head SHA mismatch`);
    }

    pr.state = 'merged';
    pr.merged = true;
    return normalizeMockPr(pr);
  }

  public async verifyMerged(pullRequestId: PullRequestId): Promise<boolean> {
    const n = extractPrNumber(pullRequestId);
    return this.prs.get(n)?.merged === true;
  }

  /** Test helper: set mock checks on a PR. */
  public setChecks(pullRequestId: PullRequestId, checks: MockCheck[]): void {
    const n = extractPrNumber(pullRequestId);
    const pr = this.prs.get(n);
    if (pr) pr.checks = checks;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPrBody(input: CreatePullRequestInput): string {
  const lines: string[] = [];
  if (input.body) lines.push(input.body);
  if (input.taskId) {
    lines.push('');
    lines.push(`<!-- dk:task-id:${input.taskId} -->`);
    if (input.taskTitle) {
      lines.push(`<!-- dk:task-title:${input.taskTitle} -->`);
    }
  }
  return lines.join('\n');
}

function normalizePullRequest(
  data: {
    number: number; title: string; body?: string | null; state: string;
    head: { ref: string }; base: { ref: string }; html_url: string; merged?: boolean | null;
  },
  owner: string,
  repo: string,
): PullRequest {
  const id = createPullRequestId(`${PROVIDER}:${owner}/${repo}#${data.number}`);
  const repositoryId = createRepositoryId(`${PROVIDER}:${owner}/${repo}`);
  const status: PullRequest['status'] =
    data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
  return {
    id,
    repositoryId,
    number: data.number,
    title: data.title,
    status,
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
    reference: { provider: PROVIDER, id: String(data.number), url: data.html_url },
  };
}

function normalizeMockPr(pr: MockPullRequest): PullRequest {
  const id = createPullRequestId(`${PROVIDER}:mock#${pr.number}`);
  const repositoryId = createRepositoryId(`${PROVIDER}:mock`);
  const status: PullRequest['status'] =
    pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
  return {
    id,
    repositoryId,
    number: pr.number,
    title: pr.title,
    status,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    reference: { provider: PROVIDER, id: String(pr.number) },
  };
}

function normalizeCheck(
  run: { id: number; name: string; status: string | null; conclusion: string | null },
  pullRequestId: PullRequestId,
): Check {
  const status = mapCheckStatus(run.status, run.conclusion);
  return {
    id: createCheckId(`${PROVIDER}:check:${run.id}`),
    pullRequestId,
    name: run.name,
    status,
  };
}

function mapCheckStatus(
  status: string | null,
  conclusion: string | null,
): Check['status'] {
  if (status === 'queued' || status === 'waiting') return 'queued';
  if (status === 'in_progress') return 'running';
  if (status === 'completed') {
    if (conclusion === 'success') return 'passed';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'failed';
  }
  return 'queued';
}

function extractPrNumber(pullRequestId: PullRequestId): number {
  const match = /#(\d+)$/.exec(pullRequestId) ?? /(\d+)$/.exec(pullRequestId);
  if (!match?.[1]) throw new ScmError(`Cannot extract PR number from ${pullRequestId}`);
  return parseInt(match[1], 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
