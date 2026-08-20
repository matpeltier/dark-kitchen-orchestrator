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
  PullRequest,
  PullRequestId,
  Repository,
  RepositoryId,
  ScmReference,
} from '@dark-kitchen/core';
import { createCheckId, createPullRequestId, createRepositoryId } from '@dark-kitchen/core';
import type {
  CheckPollPolicy,
  CreatePullRequestInput,
  DeleteBranchInput,
  FullScmAdapter,
  MergePullRequestInput,
  PushBranchInput,
} from './contracts.js';
import { ChecksFailedError, MergeRefusedError, ScmError } from './contracts.js';

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
    validatePullRequestInput(input);
    const existing = await this.findReusablePullRequest(input.sourceBranch, input.targetBranch);
    if (existing) return existing;

    // Build the PR body with task context (not GitHub-specific close syntax
    // for cross-tracker links).
    const body = buildPrBody(input);

    let data;
    try {
      ({ data } = await this.octokit.pulls.create({
        owner: this.config.owner,
        repo: this.config.repo,
        head: input.sourceBranch,
        base: input.targetBranch,
        title: redactSensitive(input.title),
        body,
      }));
    } catch (error) {
      // GitHub returns 422 when another concurrent lifecycle call created the
      // same PR after our preflight lookup. Resolve that race idempotently.
      if ((error as { status?: number }).status === 422) {
        const raced = await this.findReusablePullRequest(input.sourceBranch, input.targetBranch);
        if (raced) return raced;
      }
      throw error;
    }

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
    return this.findReusablePullRequest(sourceBranch);
  }

  private async findReusablePullRequest(
    sourceBranch: string,
    targetBranch?: string,
  ): Promise<PullRequest | undefined> {
    const { data } = await this.octokit.pulls.list({
      owner: this.config.owner,
      repo: this.config.repo,
      head: `${this.config.owner}:${sourceBranch}`,
      state: 'all',
      per_page: 100,
    });
    const candidates = targetBranch ? data.filter((pr) => pr.base.ref === targetBranch) : data;
    const reusable =
      candidates.find((pr) => pr.state === 'open') ??
      candidates.find((pr) => pr.state === 'closed' && pr.merged_at !== null);
    return reusable
      ? normalizePullRequest(reusable, this.config.owner, this.config.repo)
      : undefined;
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
    if (!Number.isFinite(policy.intervalMs) || policy.intervalMs <= 0) {
      throw new ScmError('Check poll interval must be a positive finite number');
    }
    if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0) {
      throw new ScmError('Check poll timeout must be a non-negative finite number');
    }
    const deadline = Date.now() + policy.timeoutMs;
    let lastChecks: readonly Check[] = [];
    let lastError: unknown;
    do {
      try {
        lastChecks = await this.listChecks(pullRequestId);
        lastError = undefined;
        const required = policy.requiredChecks ?? [];
        const observed =
          required.length > 0
            ? required.map((name) => lastChecks.find((check) => check.name === name))
            : lastChecks;
        const allTerminal =
          observed.length > 0 &&
          observed.every(
            (c) =>
              c !== undefined &&
              (c.status === 'passed' || c.status === 'failed' || c.status === 'cancelled'),
          );
        if (allTerminal) return lastChecks;
      } catch (error) {
        lastError = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(policy.intervalMs, remaining));
    } while (Date.now() <= deadline);

    if (lastError) {
      throw new ScmError('SCM check polling failed until timeout', lastError);
    }
    return lastChecks;
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

    const mergeMethod =
      input.strategy === 'squash' ? 'squash' : input.strategy === 'rebase' ? 'rebase' : 'merge';

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
    return data.state === 'closed' && data.merged === true;
  }

  public async deleteBranch(input: DeleteBranchInput): Promise<void> {
    validateBranchName(input.branchName);
    await this.octokit.git
      .deleteRef({
        owner: this.config.owner,
        repo: this.config.repo,
        ref: `heads/${input.branchName}`,
      })
      .catch((err: unknown) => {
        // 404 means the branch was already removed (or never existed).
        const status = (err as { status?: number }).status;
        if (status !== 404) throw err;
      });
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
  private readonly createsInFlight = new Map<string, Promise<PullRequest>>();
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
    const key = `${input.repositoryId}\u0000${input.sourceBranch}\u0000${input.targetBranch}`;
    const current = this.createsInFlight.get(key);
    if (current) return current;
    const creation = this.createPullRequestOnce(input).finally(() => {
      this.createsInFlight.delete(key);
    });
    this.createsInFlight.set(key, creation);
    return creation;
  }

  private async createPullRequestOnce(input: CreatePullRequestInput): Promise<PullRequest> {
    validatePullRequestInput(input);
    const existing = this.findMockReusable(input.sourceBranch, input.targetBranch);
    if (existing) return existing;
    const number = this.nextNumber++;
    const body = buildPrBody(input);
    this.lastPrBody = body;
    const pr: MockPullRequest = {
      number,
      title: redactSensitive(input.title),
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
    return this.findMockReusable(sourceBranch);
  }

  private findMockReusable(sourceBranch: string, targetBranch?: string): PullRequest | undefined {
    const candidates = [...this.prs.values()].filter((p) => p.sourceBranch === sourceBranch);
    const matching = targetBranch
      ? candidates.filter((candidate) => candidate.targetBranch === targetBranch)
      : candidates;
    const pr =
      matching.find((candidate) => candidate.state === 'open') ??
      matching.find((candidate) => candidate.merged);
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

  public async deleteBranch(_input: DeleteBranchInput): Promise<void> {
    // No-op in mock.
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
  if (input.body) lines.push(redactSensitive(input.body));
  if (input.taskId) {
    lines.push('');
    lines.push(`<!-- dk:task-id:${input.taskId} -->`);
    if (input.taskTitle) {
      lines.push(`<!-- dk:task-title:${sanitizeCommentValue(input.taskTitle)} -->`);
    }
  }
  return lines.join('\n');
}

function normalizePullRequest(
  data: {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
    merged?: boolean | null;
    merged_at?: string | null;
  },
  owner: string,
  repo: string,
): PullRequest {
  const id = createPullRequestId(`${PROVIDER}:${owner}/${repo}#${data.number}`);
  const repositoryId = createRepositoryId(`${PROVIDER}:${owner}/${repo}`);
  const status: PullRequest['status'] =
    data.merged || data.merged_at ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
  return {
    id,
    repositoryId,
    number: data.number,
    title: data.title,
    status,
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
    headSha: data.head.sha,
    reference: { provider: PROVIDER, id: String(data.number), url: data.html_url },
  };
}

function normalizeMockPr(pr: MockPullRequest): PullRequest {
  const id = createPullRequestId(`${PROVIDER}:mock#${pr.number}`);
  const repositoryId = createRepositoryId(`${PROVIDER}:mock`);
  const status: PullRequest['status'] = pr.merged
    ? 'merged'
    : pr.state === 'open'
      ? 'open'
      : 'closed';
  return {
    id,
    repositoryId,
    number: pr.number,
    title: pr.title,
    status,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    headSha: pr.headSha,
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

function mapCheckStatus(status: string | null, conclusion: string | null): Check['status'] {
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

function sanitizeCommentValue(value: string): string {
  return value
    .replace(/-->/g, '--&gt;')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function validateBranchName(branchName: string): void {
  if (
    !branchName ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock') ||
    branchName.startsWith('.') ||
    branchName.includes('..') ||
    branchName.includes('//') ||
    branchName.includes('@{') ||
    branchName === '@' ||
    hasControlOrSpace(branchName) ||
    /[~^:?*[\\]/.test(branchName)
  ) {
    throw new ScmError(`Invalid branch name "${branchName}"`);
  }
}

function validatePullRequestInput(input: CreatePullRequestInput): void {
  validateBranchName(input.sourceBranch);
  validateBranchName(input.targetBranch);
  if (input.sourceBranch === input.targetBranch) {
    throw new ScmError('Pull request source and target branches must differ');
  }
  if (!input.title.trim() || input.title.length > 256 || hasControlCharacters(input.title)) {
    throw new ScmError('Pull request title is empty, multiline, or exceeds 256 characters');
  }
  if (input.body && input.body.length > 65_000) {
    throw new ScmError('Pull request body exceeds the safe size limit');
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
}

function hasControlOrSpace(value: string): boolean {
  return (
    [...value].some((character) => (character.codePointAt(0) ?? 0) <= 32) ||
    hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
