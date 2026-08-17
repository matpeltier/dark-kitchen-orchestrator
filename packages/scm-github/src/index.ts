import { execFile as execFileCallback } from 'node:child_process';
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
  readonly gitPush?: (input: GitHubGitPushInput) => Promise<void>;
}

export interface GitHubGitPushInput {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly force: boolean;
}

interface GitHubRepositoryResponse {
  readonly full_name: string;
  readonly name: string;
  readonly default_branch: string;
  readonly html_url?: string;
  readonly clone_url?: string;
  readonly ssh_url?: string;
}

interface GitHubPullRequestResponse {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged_at?: string | null;
  readonly html_url?: string;
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
export function buildGitHubPullRequestContent(input: CreatePullRequestInput): {
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
    if (issue?.repository !== undefined) {
      lines.push(`Closes ${issue.repository}#${issue.number}`);
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
  private eventSequence = 0;

  public constructor(options: GitHubScmAdapterOptions = {}) {
    this.api = options.api ?? new GitHubHttpClient(options);
    this.eventPublisher = options.eventPublisher;
    this.now = options.now ?? Date.now;
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
      strategy: options.mergeStrategy ?? configuredPolicy.strategy ?? 'squash',
      requiredChecks: [...(options.requiredChecks ?? configuredPolicy.requiredChecks ?? [])],
      checkTimeoutMs: options.checkTimeoutMs ?? configuredPolicy.checkTimeoutMs ?? 300_000,
      pollIntervalMs: options.pollIntervalMs ?? configuredPolicy.pollIntervalMs ?? 10_000,
    };

    if (this.mergePolicy.checkTimeoutMs < 0 || this.mergePolicy.pollIntervalMs < 0) {
      throw new Error('GitHub SCM check timeout and poll interval must not be negative.');
    }
  }

  public async getRepository(reference: ScmReference): Promise<Repository> {
    const repositoryName = parseRepositoryReference(reference);
    const response = await this.api.request<GitHubRepositoryResponse>(
      `/repos/${repositoryPath(repositoryName)}`,
    );
    const fullName = response.full_name || repositoryName;
    const repositoryId = createRepositoryId(fullName);
    const remoteUrl =
      response.clone_url ?? response.ssh_url ?? `https://github.com/${fullName}.git`;
    const repository: Repository = {
      id: repositoryId,
      name: response.name || fullName.slice(fullName.indexOf('/') + 1),
      reference: {
        provider: this.provider,
        id: fullName,
        ...(response.html_url === undefined ? {} : { url: response.html_url }),
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
    await this.gitPush({
      remoteUrl: requireText(repository.remoteUrl, 'GitHub repository remote URL'),
      branch,
      commitSha: input.commitSha,
      force: input.force ?? false,
    });
    const commitSha = input.commitSha;
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
    const parsed = parsePullRequestReference(String(pullRequestId));
    if (parsed.repository !== undefined && parsed.repository !== repository.reference.id) {
      throw new ScmMergeError(
        `Pull request ${pullRequestId} does not belong to repository ${repositoryId}.`,
      );
    }
    const response = await this.api.request<GitHubPullRequestResponse>(
      `/repos/${repositoryPath(repository.reference.id)}/pulls/${parsed.number}`,
    );
    const previous = this.pullRequests.get(
      String(createPullRequestId(`${repository.reference.id}#${parsed.number}`)),
    );
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
    const content = buildGitHubPullRequestContent(input);
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
    const cached = await this.getCachedPullRequest(pullRequestId);
    if (cached.pullRequest.headSha === undefined) {
      throw new ScmMergeError(`Pull request ${pullRequestId} has no head commit SHA.`);
    }
    const repository = await this.getCachedRepository(cached.repositoryId);
    const pathPrefix = `/repos/${repositoryPath(repository.reference.id)}/commits/${encodeURIComponent(cached.pullRequest.headSha)}`;
    const checkRuns = await this.api.request<GitHubCheckRunsResponse>(
      `${pathPrefix}/check-runs?per_page=100`,
    );
    const statuses = await this.api.request<GitHubStatusResponse>(
      `${pathPrefix}/status?per_page=100`,
    );
    const checks = mergeChecks(
      cached.pullRequest.id,
      checkRuns.check_runs ?? [],
      statuses.statuses ?? [],
    );
    const previous = this.previousChecks.get(String(cached.pullRequest.id));
    const next = new Map(checks.map((check) => [check.name, check]));
    this.previousChecks.set(String(cached.pullRequest.id), next);
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
    return checks;
  }

  public async waitForChecks(input: WaitForChecksInput): Promise<readonly Check[]> {
    const timeoutMs = input.timeoutMs ?? this.mergePolicy.checkTimeoutMs;
    const pollIntervalMs = input.pollIntervalMs ?? this.mergePolicy.pollIntervalMs;
    const deadline = this.now() + timeoutMs;
    while (true) {
      const checks = await this.listChecks(input.pullRequestId);
      const required = this.mergePolicy.requiredChecks.map((name) =>
        checks.find((check) => check.name === name),
      );
      const failed = required.filter(
        (check): check is Check =>
          check !== undefined && (check.status === 'failed' || check.status === 'cancelled'),
      );
      if (failed.length > 0) {
        throw new RequiredChecksFailedError(failed);
      }
      const pending = required.filter(
        (check): check is Check =>
          check === undefined || check.status === 'queued' || check.status === 'running',
      );
      if (pending.length === 0) {
        return checks;
      }
      if (this.now() >= deadline) {
        throw new RequiredChecksTimeoutError(pending, timeoutMs);
      }
      await this.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - this.now())));
    }
  }

  public async mergePullRequest(input: MergePullRequestInput): Promise<PullRequest> {
    if (input.mergeStrategy !== undefined && input.mergeStrategy !== this.mergePolicy.strategy) {
      throw new MergePolicyError(
        `Merge strategy ${input.mergeStrategy} is not permitted; configured strategy is ${this.mergePolicy.strategy}.`,
      );
    }
    const initial = await this.getCachedPullRequest(input.pullRequestId);
    const expectedHeadSha = input.expectedHeadSha ?? initial.pullRequest.headSha;
    if (expectedHeadSha === undefined) {
      throw new ScmMergeError(
        `Pull request ${input.pullRequestId} has no head SHA for safe merging.`,
      );
    }
    if (
      input.expectedHeadSha !== undefined &&
      input.expectedHeadSha !== initial.pullRequest.headSha
    ) {
      throw new PullRequestHeadChangedError(
        input.expectedHeadSha,
        initial.pullRequest.headSha ?? 'missing',
      );
    }

    await this.waitForChecks({ pullRequestId: input.pullRequestId });
    const current = await this.getPullRequest(initial.repositoryId, input.pullRequestId);
    const repository = await this.getCachedRepository(initial.repositoryId);
    if (current.headSha !== expectedHeadSha) {
      throw new PullRequestHeadChangedError(expectedHeadSha, current.headSha ?? 'missing');
    }
    if (current.status !== 'open') {
      throw new ScmMergeError(`Pull request ${input.pullRequestId} is not open.`);
    }

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

    const merged = await this.getPullRequest(initial.repositoryId, input.pullRequestId);
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
    return this.getRepository({ provider: this.provider, id: String(repositoryId) });
  }

  private rememberRepository(repository: Repository): void {
    this.repositories.set(String(repository.id), repository);
    this.repositories.set(repository.reference.id, repository);
  }

  private rememberPullRequest(
    repository: Repository,
    response: GitHubPullRequestResponse,
  ): PullRequest {
    const id = createPullRequestId(`${repository.reference.id}#${response.number}`);
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
        ...(response.html_url === undefined ? {} : { url: response.html_url }),
      },
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
    const parsed = parsePullRequestReference(String(pullRequestId));
    if (parsed.repository === undefined) {
      throw new ScmMergeError(
        `Pull request ${pullRequestId} is not cached; use a GitHub pull request reference containing its repository.`,
      );
    }
    const repository = await this.getCachedRepository(createRepositoryId(parsed.repository));
    const pullRequest = await this.getPullRequest(repository.id, pullRequestId);
    const result = this.pullRequests.get(String(pullRequest.id));
    if (result === undefined) {
      throw new ScmMergeError(`Could not cache pull request ${pullRequestId}.`);
    }
    return result;
  }

  private async publish(event: DomainEvent): Promise<void> {
    if (this.eventPublisher !== undefined) {
      await this.eventPublisher.publish(event);
    }
  }

  private nextEventId(kind: string): ReturnType<typeof createEventId> {
    this.eventSequence += 1;
    return createEventId(`github:${kind}:${this.eventSequence}`);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function parseRepositoryReference(reference: ScmReference): string {
  if (reference.provider.toLowerCase() !== 'github') {
    throw new ScmMergeError(`GitHub SCM cannot operate on ${reference.provider} references.`);
  }
  const candidate = reference.url ?? reference.id;
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
  return fullName;
}

function parsePullRequestReference(value: string): {
  readonly repository?: string;
  readonly number: number;
} {
  const urlMatch = value.match(/github\.com\/([^/]+\/[^/#]+)\/pull\/(\d+)/i);
  const repositoryMatch = value.match(/^([^#]+)#(\d+)$/);
  const numberMatch = value.match(/^\d+$/);
  const repository = urlMatch?.[1] ?? repositoryMatch?.[1];
  const numberText = urlMatch?.[2] ?? repositoryMatch?.[2] ?? numberMatch?.[0];
  if (numberText === undefined) {
    throw new ScmMergeError(`Invalid GitHub pull request reference: ${value}.`);
  }
  return { ...(repository === undefined ? {} : { repository }), number: Number(numberText) };
}

function repositoryPath(fullName: string): string {
  return fullName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function normalizeBranchName(value: string): string {
  const branch = value.trim().replace(/^refs\/heads\//, '');
  if (
    branch.length === 0 ||
    branch.includes('..') ||
    branch.startsWith('/') ||
    branch.endsWith('/')
  ) {
    throw new ScmMergeError(`Invalid GitHub branch name: ${value}.`);
  }
  return branch;
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

const execFile = promisify(execFileCallback);

async function pushGitBranch(
  input: GitHubGitPushInput,
  options: { readonly token: string | undefined },
): Promise<void> {
  const refspec = `${input.force ? '+' : ''}${input.commitSha}:refs/heads/${input.branch}`;
  const env =
    options.token === undefined
      ? undefined
      : {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${options.token}`,
        };
  await execFile('git', ['push', input.remoteUrl, refspec], { env });
}

function mergeChecks(
  pullRequestId: PullRequestId,
  checkRuns: readonly GitHubCheckRunResponse[],
  statuses: readonly GitHubStatusContextResponse[],
): readonly Check[] {
  const byName = new Map<string, Check>();
  for (const checkRun of checkRuns) {
    byName.set(checkRun.name, {
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
    if (byName.has(status.context)) {
      continue;
    }
    byName.set(status.context, {
      id: createCheckId(`github:status:${status.id}`),
      pullRequestId,
      name: status.context,
      status: normalizeStatusContext(status.state),
      ...(status.target_url === null || status.target_url === undefined
        ? {}
        : { detailsUrl: status.target_url }),
    });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
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

function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ScmMergeError(`${label} must not be empty.`);
  }
  return value;
}
