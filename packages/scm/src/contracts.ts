import type {
  Check,
  CheckId,
  CheckStatus,
  PullRequest,
  PullRequestId,
  PullRequestStatus,
  Repository,
  RepositoryId,
  ScmReference,
  TaskId,
} from '@dark-kitchen/core';

export type { Check, PullRequest, Repository };

export interface CreateBranchInput {
  readonly repositoryId: RepositoryId;
  readonly branchName: string;
  readonly baseBranch?: string;
}

export interface PushBranchInput {
  readonly repositoryId: RepositoryId;
  readonly branchName: string;
  readonly localPath: string;
}

export interface CreatePullRequestInput {
  readonly repositoryId: RepositoryId;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly body?: string;
  /** Normalized task context (not GitHub-specific close syntax). */
  readonly taskId?: TaskId;
  readonly taskTitle?: string;
}

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface MergePullRequestInput {
  readonly pullRequestId: PullRequestId;
  readonly repositoryId: RepositoryId;
  readonly strategy: MergeStrategy;
  readonly requiredChecks?: readonly string[];
  readonly expectedHeadSha?: string;
}

export type CheckPollPolicy = {
  readonly intervalMs: number;
  readonly timeoutMs: number;
};

export interface FullScmAdapter {
  readonly provider: string;
  getRepository(reference: ScmReference): Promise<Repository>;
  getDefaultBranch(repositoryId: RepositoryId): Promise<string>;
  pushBranch(input: PushBranchInput): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  getPullRequest(repositoryId: RepositoryId, pullRequestId: PullRequestId): Promise<PullRequest>;
  findPullRequestByBranch(repositoryId: RepositoryId, sourceBranch: string): Promise<PullRequest | undefined>;
  listChecks(pullRequestId: PullRequestId): Promise<readonly Check[]>;
  pollChecks(pullRequestId: PullRequestId, policy: CheckPollPolicy): Promise<readonly Check[]>;
  merge(input: MergePullRequestInput): Promise<PullRequest>;
  verifyMerged(pullRequestId: PullRequestId): Promise<boolean>;
}

export class ScmError extends Error {
  public constructor(message: string, public readonly scmCause?: unknown) {
    super(message);
    this.name = 'ScmError';
  }
}

export class MergeRefusedError extends ScmError {
  public constructor(reason: string) {
    super(`Merge refused: ${reason}`);
    this.name = 'MergeRefusedError';
  }
}

export class ChecksFailedError extends ScmError {
  public readonly failedChecks: readonly string[];
  public constructor(failedChecks: string[]) {
    super(`Required checks failed: ${failedChecks.join(', ')}`);
    this.name = 'ChecksFailedError';
    this.failedChecks = failedChecks;
  }
}
