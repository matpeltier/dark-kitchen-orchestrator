import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createCheckId,
  createEventId,
  createPullRequestId,
  createRepositoryId,
} from '@dark-kitchen/core';
import type {
  Branch,
  Check,
  CheckStatus,
  CreatePullRequestInput,
  DomainEvent,
  EventPublisher,
  MergePullRequestInput,
  MergeStrategy,
  PullRequest,
  PullRequestId,
  PushBranchInput,
  Repository,
  RepositoryId,
  ScmAdapter,
  ScmReference,
  WaitForChecksInput,
} from '@dark-kitchen/core';

/** A small injectable boundary keeps integration tests independent of GitHub credentials. */
export interface GitHubApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface GitHubMergePolicy {
  readonly strategy: MergeStrategy;
  readonly requiredChecks: readonly string[];
  readonly checkTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface GitHubScmAdapterOptions {
  readonly token?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly api?: GitHubApiClient;
  readonly eventPublisher?: EventPublisher;
  readonly mergePolicy?: Partial<GitHubMergePolicy>;
  readonly mergeStrategy?: MergeStrategy;
  readonly requiredChecks?: readonly string[];
  readonly checkTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly eventId?: () => string;
  readonly gitPush?: (input: GitHubGitPushInput) => Promise<void>;
}

export interface GitHubGitPushInput {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly worktreePath: string;
  readonly force: boolean;
}

export type GitHubGitExecutor = (
  file: string,
  args: readonly string[],
  options: Pick<ExecFileOptions, 'cwd' | 'env'>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

interface GitHubRepositoryResponse {
  readonly full_name: string;
  readonly name: string;
  readonly default_branch: string;
  readonly html_url?: string | null;
  readonly clone_url?: string | null;
  readonly ssh_url?: string | null;
}

interface GitHubPullRequestResponse {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged_at?: string | null;
  readonly html_url?: string | null;
  readonly merge_commit_sha?: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
}

interface GitHubCheckRunResponse {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly details_url?: string | null;
}

interface GitHubCheckRunsResponse {
  readonly check_runs?: readonly GitHubCheckRunResponse[];
}

interface GitHubStatusResponse {
  readonly statuses?: readonly GitHubStatusContextResponse[];
}

interface GitHubStatusContextResponse {
  readonly id: number;
  readonly context: string;
  readonly state: string;
  readonly target_url?: string | null;
}

interface GitHubMergeResponse {
  readonly merged: boolean;
  readonly sha?: string | null;
  readonly message?: string;
}

interface GitHubCommitChecks {
  readonly checkRuns: readonly GitHubCheckRunResponse[];
  readonly statuses: readonly GitHubStatusContextResponse[];
}

interface CheckedPullRequestSnapshot {
  readonly headSha: string;
  readonly baseSha: string | undefined;
  readonly testMergeSha: string | undefined;
  readonly checkedCommitSha: string;
}

interface CheckedPullRequest {
  readonly checks: readonly Check[];
  readonly snapshot: CheckedPullRequestSnapshot;
}

interface CachedPullRequest {
  readonly repositoryId: RepositoryId;
  readonly number: number;
  readonly pullRequest: PullRequest;
}

export class GitHubApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly responseBody?: unknown,
  ) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubApiError';
  }
}

export class ScmMergeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ScmMergeError';
  }
}

export class MergePolicyError extends ScmMergeError {
  public constructor(message: string) {
    super(message);
    this.name = 'MergePolicyError';
  }
}

export class RequiredChecksFailedError extends ScmMergeError {
  public constructor(public readonly checks: readonly Check[]) {
    super(`Required checks failed: ${checks.map((check) => check.name).join(', ')}.`);
    this.name = 'RequiredChecksFailedError';
  }
}

export class RequiredChecksTimeoutError extends ScmMergeError {
  public constructor(
    public readonly checks: readonly Check[],
    timeoutMs: number,
    public readonly missingChecks: readonly string[] = [],
  ) {
    super(`Required checks did not pass within ${timeoutMs}ms.`);
    this.name = 'RequiredChecksTimeoutError';
  }
}

export class PullRequestHeadChangedError extends ScmMergeError {
  public constructor(expectedHeadSha: string, actualHeadSha: string) {
    super(`Pull request head changed unexpectedly from ${expectedHeadSha} to ${actualHeadSha}.`);
    this.name = 'PullRequestHeadChangedError';
  }
}

export class PullRequestSnapshotChangedError extends ScmMergeError {
  public constructor(
    public readonly checkedCommitSha: string,
    public readonly expectedBaseSha: string | undefined,
    public readonly actualBaseSha: string | undefined,
    public readonly expectedTestMergeSha: string | undefined,
    public readonly actualTestMergeSha: string | undefined,
  ) {
    super(
      `Pull request merge snapshot changed unexpectedly after checks were evaluated for ${checkedCommitSha}.`,
    );
    this.name = 'PullRequestSnapshotChangedError';
  }
}

/** The default GitHub REST transport. It intentionally knows nothing about PM inspection. */
export class GitHubHttpClient implements GitHubApiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  public constructor(
    options: Pick<GitHubScmAdapterOptions, 'apiBaseUrl' | 'fetch' | 'token'> = {},
  ) {
    this.baseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (this.fetchImpl === undefined) {
      throw new Error('A fetch implementation is required to use GitHubScmAdapter.');
    }
  }

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (this.token !== undefined) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        isRecord(body) && typeof body.message === 'string' ? body.message : response.statusText;
      throw new GitHubApiError(response.status, message, body);
    }

    return body as T;
  }
}

/**
 * Deterministic task content shared by the adapter and its tests. A tracker
 * reference is linked as data; GitHub close syntax is emitted only for a
 * GitHub Issues tracker with a resolvable issue number and repository.
 */
export function buildGitHubPullRequestContent(
  input: CreatePullRequestInput,
  repositoryReference?: ScmReference,
): {
  readonly title: string;
  readonly body?: string;
} {
  const task = input.task;
  const title =
    input.title?.trim() ||
    (task === undefined
      ? `Dark Kitchen: ${input.sourceBranch}`
      : `[Dark Kitchen] ${task.title.trim() || task.taskId} (${task.taskId})`);

  if (task === undefined) {
    return input.body === undefined ? { title } : { title, body: input.body };
  }

  const tracker = task.trackerReference;
  const taskLabel = tracker?.url ? `[${task.taskId}](${tracker.url})` : `\`${task.taskId}\``;
  const lines = [
    `Dark Kitchen task: ${taskLabel}`,
    `Tracker: ${tracker?.provider ?? 'unassigned'}${tracker === undefined ? '' : ` (${tracker.id})`}`,
  ];

  if (tracker?.provider.toLowerCase() === 'github') {
    const issue = githubIssueReference(tracker);
    const repository =
      issue?.repository ??
      (repositoryReference?.provider.toLowerCase() === 'github'
        ? githubRepositoryName(repositoryReference.id)
        : undefined);
    if (issue !== undefined && repository !== undefined) {
      lines.push(`Closes ${repository}#${issue.number}`);
    }
  }
  if (task.description?.trim()) {
    lines.push('', 'Task description:', task.description.trim());
  }
  if (input.body?.trim()) {
    lines.push('', 'Additional context:', input.body.trim());
  }

  return { title, body: lines.join('\n') };
}

export class GitHubScmAdapter implements ScmAdapter {
  public readonly provider = 'github';
  public readonly mergePolicy: GitHubMergePolicy;
  public readonly api: GitHubApiClient;

  private readonly repositories = new Map<string, Repository>();
  private readonly pullRequests = new Map<string, CachedPullRequest>();
  private readonly previousChecks = new Map<string, Map<string, Check>>();
  private readonly eventPublisher: EventPublisher | undefined;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly gitPush: (input: GitHubGitPushInput) => Promise<void>;
  private readonly eventId: () => string;

  public constructor(options: GitHubScmAdapterOptions = {}) {
    this.api = options.api ?? new GitHubHttpClient(options);
    this.eventPublisher = options.eventPublisher;
    this.now = options.now ?? Date.now;
    this.eventId = options.eventId ?? randomUUID;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.gitPush =
      options.gitPush ??
      ((input) =>
        pushGitBranch(input, {
          token: options.token,
        }));

    const configuredPolicy = options.mergePolicy ?? {};
    this.mergePolicy = {
      strategy: normalizeMergeStrategy(
        options.mergeStrategy ?? configuredPolicy.strategy ?? 'squash',
      ),
      requiredChecks: normalizeRequiredChecks(
        options.requiredChecks ?? configuredPolicy.requiredChecks ?? [],
      ),
      checkTimeoutMs: options.checkTimeoutMs ?? configuredPolicy.checkTimeoutMs ?? 300_000,
      pollIntervalMs: options.pollIntervalMs ?? configuredPolicy.pollIntervalMs ?? 10_000,
    };

    if (
      !Number.isFinite(this.mergePolicy.checkTimeoutMs) ||
      !Number.isFinite(this.mergePolicy.pollIntervalMs) ||
      this.mergePolicy.checkTimeoutMs < 0 ||
      this.mergePolicy.pollIntervalMs < 0
    ) {
      throw new Error(
        'GitHub SCM check timeout and poll interval must be finite and non-negative.',
      );
    }
  }

  public async getRepository(reference: ScmReference): Promise<Repository> {
    const repositoryName = parseRepositoryReference(reference);
    const response = await this.api.request<GitHubRepositoryResponse>(
      `/repos/${repositoryPath(repositoryName)}`,
    );
    const fullName = response.full_name || repositoryName;
    const repositoryId = githubRepositoryId(fullName);
    const remoteUrl =
      firstNonEmpty(response.clone_url, response.ssh_url) ?? `https://github.com/${fullName}.git`;
    const repositoryUrl = firstNonEmpty(response.html_url);
    const repository: Repository = {
      id: repositoryId,
      name: response.name || fullName.slice(fullName.indexOf('/') + 1),
      reference: {
        provider: this.provider,
        id: fullName,
        ...(repositoryUrl === undefined ? {} : { url: repositoryUrl }),
      },
      defaultBranch: requireText(response.default_branch, 'GitHub repository default branch'),
      remoteUrl,
    };
    this.rememberRepository(repository);
    return repository;
  }

  public async getDefaultBranch(repositoryId: RepositoryId): Promise<string> {
    return (await this.getCachedRepository(repositoryId)).defaultBranch;
  }

  public async getRemoteUrl(repositoryId: RepositoryId): Promise<string> {
    const repository = await this.getCachedRepository(repositoryId);
    if (repository.remoteUrl === undefined) {
      throw new ScmMergeError(`GitHub repository ${repositoryId} has no discovered remote URL.`);
    }
    return repository.remoteUrl;
  }

  public async pushBranch(input: PushBranchInput): Promise<Branch> {
    const repository = await this.getCachedRepository(input.repositoryId);
    const branch = normalizeBranchName(input.branch);
    const commitSha = requireText(input.commitSha, 'Git commit SHA').trim();
    const worktreePath = requireText(input.worktreePath, 'Git worktree path');
    await this.gitPush({
      remoteUrl: requireText(repository.remoteUrl, 'GitHub repository remote URL'),
      branch,
      commitSha,
      worktreePath,
      force: input.force ?? false,
    });
    const pushedBranch: Branch = { repositoryId: repository.id, name: branch, commitSha };
    await this.publish({
      id: this.nextEventId('branch-pushed'),
      type: 'scm.branch-pushed',
      occurredAt: this.timestamp(),
      payload: { branch: pushedBranch },
    });
    return pushedBranch;
  }

  public async getPullRequest(
    repositoryId: RepositoryId,
    pullRequestId: PullRequestId,
  ): Promise<PullRequest> {
    const repository = await this.getCachedRepository(repositoryId);
    const parsed = parseGitHubPullRequestId(pullRequestId);
    if (parsed.repository.toLowerCase() !== repository.reference.id.toLowerCase()) {
      throw new ScmMergeError(
        `Pull request ${pullRequestId} does not belong to repository ${repositoryId}.`,
      );
    }
    const response = await this.api.request<GitHubPullRequestResponse>(
      `/repos/${repositoryPath(repository.reference.id)}/pulls/${parsed.number}`,
    );
    const previous = this.pullRequests.get(String(githubPullRequestId(repository, parsed.number)));
    const pullRequest = this.rememberPullRequest(repository, response);
    if (previous !== undefined && previous.pullRequest.status !== pullRequest.status) {
      await this.publish({
        id: this.nextEventId(`pull-request-${pullRequest.id}`),
        type: 'pull-request.state-changed',
        occurredAt: this.timestamp(),
        payload: {
          pullRequestId: pullRequest.id,
          status: pullRequest.status,
          previousStatus: previous.pullRequest.status,
          pullRequest,
        },
      });
    }
    return pullRequest;
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const repository = await this.getCachedRepository(input.repositoryId);
    const content = buildGitHubPullRequestContent(input, repository.reference);
    const requestBody: Record<string, string> = {
      title: content.title,
      head: normalizeBranchName(input.sourceBranch),
      base: normalizeBranchName(input.targetBranch),
    };
    if (content.body !== undefined) {
      requestBody.body = content.body;
    }
    const response = await this.api.request<GitHubPullRequestResponse>(
      `/repos/${repositoryPath(repository.reference.id)}/pulls`,
      { method: 'POST', body: JSON.stringify(requestBody) },
    );
    const pullRequest = this.rememberPullRequest(repository, response);
    await this.publish({
      id: this.nextEventId('pull-request-created'),
      type: 'pull-request.created',
      occurredAt: this.timestamp(),
      payload: { pullRequest },
    });
    return pullRequest;
  }

  public async listChecks(pullRequestId: PullRequestId): Promise<readonly Check[]> {
    return (await this.listChecksForSnapshot(pullRequestId)).checks;
  }

  private async listChecksForSnapshot(pullRequestId: PullRequestId): Promise<CheckedPullRequest> {
    const cached = await this.getCachedPullRequest(pullRequestId);
    const pullRequest = await this.getPullRequest(cached.repositoryId, pullRequestId);
    if (pullRequest.headSha === undefined) {
      throw new ScmMergeError(`Pull request ${pullRequestId} has no head commit SHA.`);
    }
    const repository = await this.getCachedRepository(cached.repositoryId);
    let commitChecks: GitHubCommitChecks | undefined;
    let checkedCommitSha = pullRequest.headSha;
    const testMergeSha = openTestMergeSha(pullRequest);
    // Before a PR is merged GitHub exposes mergeCommitSha as its test-merge commit.
    // That commit is authoritative only when at least one status check exists on it.
    if (testMergeSha !== undefined) {
      const mergeCommitChecks = await this.listCommitChecks(repository, testMergeSha);
      if (mergeCommitChecks.checkRuns.length > 0 || mergeCommitChecks.statuses.length > 0) {
        commitChecks = mergeCommitChecks;
        checkedCommitSha = testMergeSha;
      }
    }
    commitChecks ??= await this.listCommitChecks(repository, pullRequest.headSha);
    const checks = mergeChecks(pullRequest.id, commitChecks.checkRuns, commitChecks.statuses);
    const previous = this.previousChecks.get(String(pullRequest.id));
    const next = new Map(checks.map((check) => [check.name, check]));
    this.previousChecks.set(String(pullRequest.id), next);
    if (previous !== undefined) {
      for (const check of checks) {
        const previousCheck = previous.get(check.name);
        if (previousCheck !== undefined && previousCheck.status !== check.status) {
          await this.publish({
            id: this.nextEventId(`check-${check.id}`),
            type: 'check.state-changed',
            occurredAt: this.timestamp(),
            payload: {
              checkId: check.id,
              status: check.status,
              previousStatus: previousCheck.status,
            },
          });
        }
      }
    }
    return {
      checks,
      snapshot: {
        headSha: pullRequest.headSha,
        baseSha: pullRequest.baseSha,
        testMergeSha,
        checkedCommitSha,
      },
    };
  }

  private async listCommitChecks(
    repository: Repository,
    commitSha: string,
  ): Promise<GitHubCommitChecks> {
    const pathPrefix = `/repos/${repositoryPath(repository.reference.id)}/commits/${encodeURIComponent(commitSha)}`;
    const [checkRuns, statuses] = await Promise.all([
      collectGitHubPages(
        this.api,
        `${pathPrefix}/check-runs`,
        (response: GitHubCheckRunsResponse) => response.check_runs ?? [],
      ),
      collectGitHubPages(
        this.api,
        `${pathPrefix}/status`,
        (response: GitHubStatusResponse) => response.statuses ?? [],
      ),
    ]);
    return { checkRuns, statuses };
  }

  public async waitForChecks(input: WaitForChecksInput): Promise<readonly Check[]> {
    return (await this.waitForCheckedSnapshot(input)).checks;
  }

  private async waitForCheckedSnapshot(input: WaitForChecksInput): Promise<CheckedPullRequest> {
    const timeoutMs = nonNegativeFinite(
      input.timeoutMs ?? this.mergePolicy.checkTimeoutMs,
      'Check timeout',
    );
    const pollIntervalMs = nonNegativeFinite(
      input.pollIntervalMs ?? this.mergePolicy.pollIntervalMs,
      'Check poll interval',
    );
    const deadline = this.now() + timeoutMs;
    while (true) {
      const checked = await this.listChecksForSnapshot(input.pullRequestId);
      const checks = checked.checks;
      const required = new Map(checks.map((check) => [check.name, check]));
      const failed: Check[] = [];
      const pending: Check[] = [];
      const missingChecks: string[] = [];
      for (const name of this.mergePolicy.requiredChecks) {
        const check = required.get(name);
        if (check === undefined) {
          missingChecks.push(name);
        } else if (check.status === 'failed' || check.status === 'cancelled') {
          failed.push(check);
        } else if (check.status === 'queued' || check.status === 'running') {
          pending.push(check);
        }
      }
      if (failed.length > 0) {
        throw new RequiredChecksFailedError(failed);
      }
      if (pending.length === 0 && missingChecks.length === 0) {
        return checked;
      }
      if (this.now() >= deadline) {
        throw new RequiredChecksTimeoutError(pending, timeoutMs, missingChecks);
      }
      await this.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - this.now())));
    }
  }

  public async mergePullRequest(input: MergePullRequestInput): Promise<PullRequest> {
    const requestedStrategy =
      input.mergeStrategy === undefined ? undefined : normalizeMergeStrategy(input.mergeStrategy);
    if (requestedStrategy !== undefined && requestedStrategy !== this.mergePolicy.strategy) {
      throw new MergePolicyError(
        `Merge strategy ${requestedStrategy} is not permitted; configured strategy is ${this.mergePolicy.strategy}.`,
      );
    }
    const cached = await this.getCachedPullRequest(input.pullRequestId);
    const initial = await this.getPullRequest(cached.repositoryId, input.pullRequestId);
    const expectedHeadSha = input.expectedHeadSha ?? initial.headSha;
    if (expectedHeadSha === undefined) {
      throw new ScmMergeError(
        `Pull request ${input.pullRequestId} has no head SHA for safe merging.`,
      );
    }
    if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== initial.headSha) {
      throw new PullRequestHeadChangedError(input.expectedHeadSha, initial.headSha ?? 'missing');
    }

    const checked = await this.waitForCheckedSnapshot({ pullRequestId: input.pullRequestId });
    const current = await this.getPullRequest(cached.repositoryId, input.pullRequestId);
    const repository = await this.getCachedRepository(cached.repositoryId);
    if (current.headSha !== expectedHeadSha) {
      throw new PullRequestHeadChangedError(expectedHeadSha, current.headSha ?? 'missing');
    }
    if (current.status !== 'open') {
      throw new ScmMergeError(`Pull request ${input.pullRequestId} is not open.`);
    }
    this.assertCheckedSnapshotUnchanged(checked.snapshot, current);

    let mergeResponse: GitHubMergeResponse;
    try {
      mergeResponse = await this.api.request<GitHubMergeResponse>(
        `/repos/${repositoryPath(repository.reference.id)}/pulls/${current.number}/merge`,
        {
          method: 'PUT',
          body: JSON.stringify({
            merge_method: this.mergePolicy.strategy,
            sha: expectedHeadSha,
          }),
        },
      );
    } catch (error) {
      if (isGitHubStatus(error, 409)) {
        throw new PullRequestHeadChangedError(
          expectedHeadSha,
          'unknown (GitHub reported a conflict)',
        );
      }
      throw error;
    }
    if (!mergeResponse.merged) {
      throw new ScmMergeError(
        mergeResponse.message ?? `GitHub refused to merge pull request ${input.pullRequestId}.`,
      );
    }

    const merged = await this.getPullRequest(cached.repositoryId, input.pullRequestId);
    if (!(await this.verifyPullRequestMerged(input.pullRequestId))) {
      throw new ScmMergeError(
        `GitHub did not report pull request ${input.pullRequestId} as merged.`,
      );
    }
    const result =
      mergeResponse.sha !== undefined &&
      mergeResponse.sha !== null &&
      merged.mergeCommitSha === undefined
        ? { ...merged, mergeCommitSha: mergeResponse.sha }
        : merged;
    await this.publish({
      id: this.nextEventId('pull-request-merged'),
      type: 'pull-request.merged',
      occurredAt: this.timestamp(),
      payload: {
        pullRequestId: result.id,
        strategy: this.mergePolicy.strategy,
        ...(result.mergeCommitSha === undefined ? {} : { mergeCommitSha: result.mergeCommitSha }),
      },
    });
    return result;
  }

  public async verifyPullRequestMerged(pullRequestId: PullRequestId): Promise<boolean> {
    const cached = await this.getCachedPullRequest(pullRequestId);
    const current = await this.getPullRequest(cached.repositoryId, pullRequestId);
    return current.status === 'merged';
  }

  private async getCachedRepository(repositoryId: RepositoryId): Promise<Repository> {
    const cached = this.repositories.get(String(repositoryId));
    if (cached !== undefined) {
      return cached;
    }
    const referenceId = githubRepositoryReferenceFromId(repositoryId);
    if (referenceId === undefined) {
      throw new ScmMergeError(
        `GitHub repository ${repositoryId} is not cached; discover it from a GitHub provider reference first.`,
      );
    }
    return this.getRepository({ provider: this.provider, id: referenceId });
  }

  private rememberRepository(repository: Repository): void {
    this.repositories.set(String(repository.id), repository);
  }

  private rememberPullRequest(
    repository: Repository,
    response: GitHubPullRequestResponse,
  ): PullRequest {
    const id = githubPullRequestId(repository, response.number);
    const pullRequestUrl = firstNonEmpty(response.html_url);
    const pullRequest: PullRequest = {
      id,
      repositoryId: repository.id,
      number: response.number,
      title: response.title,
      status:
        response.merged_at !== undefined && response.merged_at !== null
          ? 'merged'
          : response.state === 'open'
            ? 'open'
            : 'closed',
      sourceBranch: response.head.ref,
      targetBranch: response.base.ref,
      reference: {
        provider: this.provider,
        id: `${repository.reference.id}#${response.number}`,
        ...(pullRequestUrl === undefined ? {} : { url: pullRequestUrl }),
      },
      ...(pullRequestUrl === undefined ? {} : { url: pullRequestUrl }),
      headSha: response.head.sha,
      baseSha: response.base.sha,
      ...(response.merge_commit_sha === undefined || response.merge_commit_sha === null
        ? {}
        : { mergeCommitSha: response.merge_commit_sha }),
    };
    this.pullRequests.set(String(id), {
      repositoryId: repository.id,
      number: response.number,
      pullRequest,
    });
    return pullRequest;
  }

  private async getCachedPullRequest(pullRequestId: PullRequestId): Promise<CachedPullRequest> {
    const cached = this.pullRequests.get(String(pullRequestId));
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parseGitHubPullRequestId(pullRequestId);
    const repository = await this.getCachedRepository(githubRepositoryId(parsed.repository));
    const pullRequest = await this.getPullRequest(repository.id, pullRequestId);
    const result = this.pullRequests.get(String(pullRequest.id));
    if (result === undefined) {
      throw new ScmMergeError(`Could not cache pull request ${pullRequestId}.`);
    }
    return result;
  }

  private assertCheckedSnapshotUnchanged(
    checked: CheckedPullRequestSnapshot,
    current: PullRequest,
  ): void {
    if (current.headSha !== checked.headSha) {
      throw new PullRequestHeadChangedError(checked.headSha, current.headSha ?? 'missing');
    }
    const currentTestMergeSha = openTestMergeSha(current);
    if (current.baseSha !== checked.baseSha || currentTestMergeSha !== checked.testMergeSha) {
      throw new PullRequestSnapshotChangedError(
        checked.checkedCommitSha,
        checked.baseSha,
        current.baseSha,
        checked.testMergeSha,
        currentTestMergeSha,
      );
    }
  }

  private async publish(event: DomainEvent): Promise<void> {
    if (this.eventPublisher !== undefined) {
      await this.eventPublisher.publish(event);
    }
  }

  private nextEventId(kind: string): ReturnType<typeof createEventId> {
    return createEventId(`github:${kind}:${this.eventId()}`);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function parseRepositoryReference(reference: ScmReference): string {
  if (reference.provider.toLowerCase() !== 'github') {
    throw new ScmMergeError(`GitHub SCM cannot operate on ${reference.provider} references.`);
  }
  const candidate = (reference.url ?? reference.id).trim();
  const fromApiUrl = candidate.match(
    /github\.com\/repos\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#/?].*)?$/i,
  );
  const fromUrl = candidate.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[#/?].*)?$/i);
  const fullName =
    fromApiUrl !== null
      ? `${fromApiUrl[1]}/${fromApiUrl[2]}`
      : fromUrl === null
        ? candidate.replace(/^github:/i, '').replace(/\.git$/, '')
        : `${fromUrl[1]}/${fromUrl[2]}`;
  if (!/^([^/]+)\/([^/]+)$/.test(fullName)) {
    throw new ScmMergeError(`Invalid GitHub repository reference: ${candidate}.`);
  }
  return fullName.toLowerCase();
}

const GITHUB_REPOSITORY_ID_PREFIX = 'scm:github:repository:';
const GITHUB_PULL_REQUEST_ID_PREFIX = 'scm:github:pull-request:';

function githubRepositoryId(referenceId: string): RepositoryId {
  return createRepositoryId(`${GITHUB_REPOSITORY_ID_PREFIX}${referenceId.toLowerCase()}`);
}

function githubRepositoryReferenceFromId(repositoryId: RepositoryId): string | undefined {
  const value = String(repositoryId);
  if (!value.startsWith(GITHUB_REPOSITORY_ID_PREFIX)) {
    return undefined;
  }
  return githubRepositoryName(value.slice(GITHUB_REPOSITORY_ID_PREFIX.length))?.toLowerCase();
}

function githubPullRequestId(repository: Repository, number: number): PullRequestId {
  return createPullRequestId(
    `${GITHUB_PULL_REQUEST_ID_PREFIX}${repository.reference.id.toLowerCase()}#${number}`,
  );
}

function parseGitHubPullRequestId(value: PullRequestId): {
  readonly repository: string;
  readonly number: number;
} {
  const stringValue = String(value);
  const normalized = stringValue.startsWith(GITHUB_PULL_REQUEST_ID_PREFIX)
    ? stringValue.slice(GITHUB_PULL_REQUEST_ID_PREFIX.length)
    : undefined;
  const match = normalized?.match(/^([^#]+)#(\d+)$/);
  const repository = match?.[1];
  const numberText = match?.[2];
  if (
    repository === undefined ||
    githubRepositoryName(repository) === undefined ||
    numberText === undefined ||
    !Number.isSafeInteger(Number(numberText)) ||
    Number(numberText) < 1
  ) {
    throw new ScmMergeError(`Invalid GitHub pull request ID: ${stringValue}.`);
  }
  return { repository: repository.toLowerCase(), number: Number(numberText) };
}

function repositoryPath(fullName: string): string {
  return fullName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function normalizeBranchName(value: string): string {
  const branch = value.trim().replace(/^refs\/heads\//, '');
  const parts = branch.split('/');
  if (
    branch.length === 0 ||
    branch === '.' ||
    branch === '..' ||
    branch === '@' ||
    branch.includes('..') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    /[~^:?*[\\]/.test(branch) ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    }) ||
    parts.some(
      (part) =>
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        part.endsWith('.') ||
        part.endsWith('.lock'),
    )
  ) {
    throw new ScmMergeError(`Invalid GitHub branch name: ${value}.`);
  }
  return branch;
}

function normalizeMergeStrategy(value: MergeStrategy): MergeStrategy {
  switch (value) {
    case 'merge':
    case 'squash':
    case 'rebase':
      return value;
    default:
      throw new MergePolicyError(`Unsupported GitHub merge strategy: ${String(value)}.`);
  }
}

function openTestMergeSha(pullRequest: PullRequest): string | undefined {
  return pullRequest.status === 'open' &&
    pullRequest.mergeCommitSha !== undefined &&
    pullRequest.mergeCommitSha !== pullRequest.headSha
    ? pullRequest.mergeCommitSha
    : undefined;
}

function githubIssueReference(reference: {
  readonly id: string;
  readonly url?: string;
}): { readonly repository?: string; readonly number: string } | undefined {
  const fromUrl =
    reference.url === undefined
      ? null
      : reference.url.match(/github\.com\/([^/]+\/[^/#?]+)\/issues\/(\d+)(?:$|[/?#])/i);
  if (fromUrl !== null && fromUrl[1] !== undefined && fromUrl[2] !== undefined) {
    return { repository: fromUrl[1], number: fromUrl[2] };
  }
  const fromId = reference.id.match(/^(?:github:)?([^/\s#]+\/[^/\s#]+)#(\d+)$/i);
  if (fromId !== null && fromId[1] !== undefined && fromId[2] !== undefined) {
    return { repository: fromId[1], number: fromId[2] };
  }
  const issueNumber = reference.id.match(/(?:^|#)(\d+)$/)?.[1];
  return issueNumber === undefined ? undefined : { number: issueNumber };
}

function githubRepositoryName(value: string): string | undefined {
  return /^([^/]+\/[^/]+)$/.test(value) ? value : undefined;
}

function normalizeRequiredChecks(checks: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const check of checks) {
    const name = check.trim();
    if (name.length === 0) {
      throw new Error('GitHub SCM required check names must not be empty.');
    }
    normalized.add(name);
  }
  return [...normalized];
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | undefined {
  return values.find(
    (value): value is string => value !== undefined && value !== null && value.trim().length > 0,
  );
}

const execFile = promisify(execFileCallback);
const defaultGitExecutor: GitHubGitExecutor = (file, args, options) =>
  execFile(file, [...args], options);

export async function pushGitBranch(
  input: GitHubGitPushInput,
  options: { readonly token: string | undefined },
  runGit: GitHubGitExecutor = defaultGitExecutor,
): Promise<void> {
  const commitSha = requireText(input.commitSha, 'Git commit SHA').trim();
  const branch = normalizeBranchName(input.branch);
  const remoteUrl = requireText(input.remoteUrl, 'GitHub repository remote URL');
  const worktreePath = requireText(input.worktreePath, 'Git worktree path');
  const resolvedCommit = await runGit(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${commitSha}^{commit}`],
    { cwd: worktreePath },
  );
  const verifiedCommitSha = requireVerifiedCommitSha(resolvedCommit.stdout);
  const refspec = `${input.force ? '+' : ''}${verifiedCommitSha}:refs/heads/${branch}`;
  const env =
    options.token === undefined
      ? undefined
      : {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
        };
  await runGit('git', ['push', remoteUrl, refspec], {
    cwd: worktreePath,
    ...(env === undefined ? {} : { env }),
  });
}

const GITHUB_API_PAGE_SIZE = 100;

async function collectGitHubPages<TResponse, TItem>(
  api: GitHubApiClient,
  path: string,
  selectItems: (response: TResponse) => readonly TItem[],
): Promise<readonly TItem[]> {
  const items: TItem[] = [];
  for (let page = 1; ; page += 1) {
    const response = await api.request<TResponse>(
      `${path}?per_page=${GITHUB_API_PAGE_SIZE}&page=${page}`,
    );
    const pageItems = selectItems(response);
    items.push(...pageItems);
    if (pageItems.length < GITHUB_API_PAGE_SIZE) {
      return items;
    }
  }
}

function mergeChecks(
  pullRequestId: PullRequestId,
  checkRuns: readonly GitHubCheckRunResponse[],
  statuses: readonly GitHubStatusContextResponse[],
): readonly Check[] {
  const byName = new Map<string, Check[]>();
  const add = (check: Check): void => {
    const sameName = byName.get(check.name) ?? [];
    sameName.push(check);
    byName.set(check.name, sameName);
  };
  for (const checkRun of checkRuns) {
    add({
      id: createCheckId(`github:run:${checkRun.id}`),
      pullRequestId,
      name: checkRun.name,
      status: normalizeCheckRunStatus(checkRun.status, checkRun.conclusion),
      ...(checkRun.details_url === null || checkRun.details_url === undefined
        ? {}
        : { detailsUrl: checkRun.details_url }),
    });
  }
  for (const status of statuses) {
    add({
      id: createCheckId(`github:status:${status.id}`),
      pullRequestId,
      name: status.context,
      status: normalizeStatusContext(status.state),
      ...(status.target_url === null || status.target_url === undefined
        ? {}
        : { detailsUrl: status.target_url }),
    });
  }
  return [...byName.entries()]
    .map(([name, checks]) => aggregateChecks(pullRequestId, name, checks))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const CHECK_STATUS_PRIORITY: Readonly<Record<CheckStatus, number>> = {
  passed: 0,
  queued: 1,
  running: 2,
  cancelled: 3,
  failed: 4,
};

function aggregateChecks(
  pullRequestId: PullRequestId,
  name: string,
  checks: readonly Check[],
): Check {
  const mostPessimistic = checks.reduce((current, check) =>
    CHECK_STATUS_PRIORITY[check.status] > CHECK_STATUS_PRIORITY[current.status] ? check : current,
  );
  return {
    id: createCheckId(
      `github:check:${encodeURIComponent(String(pullRequestId))}:${encodeURIComponent(name)}`,
    ),
    pullRequestId,
    name,
    status: mostPessimistic.status,
    ...(mostPessimistic.detailsUrl === undefined ? {} : { detailsUrl: mostPessimistic.detailsUrl }),
  };
}

function normalizeCheckRunStatus(
  status: string,
  conclusion: string | null | undefined,
): CheckStatus {
  if (status !== 'completed') {
    return status === 'queued' || status === 'requested' || status === 'waiting'
      ? 'queued'
      : 'running';
  }
  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'passed';
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function normalizeStatusContext(state: string): CheckStatus {
  switch (state) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'error':
      return 'failed';
    case 'pending':
      return 'running';
    default:
      return 'cancelled';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGitHubStatus(error: unknown, status: number): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === status;
}

function requireText(value: string | null | undefined, label: string): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new ScmMergeError(`${label} must not be empty.`);
  }
  return value;
}

function requireVerifiedCommitSha(value: string): string {
  const commitSha = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha)) {
    throw new ScmMergeError('Git commit SHA did not resolve to a commit object.');
  }
  return commitSha;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScmMergeError(`${label} must be a finite non-negative number.`);
  }
  return value;
}
