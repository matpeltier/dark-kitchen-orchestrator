/**
 * Autonomous PR, CI, merge, and task-transition lifecycle (Issue 22).
 *
 * Dark Kitchen owns: branch push, PR creation, CI gate, merge, tracker
 * closure, worktree cleanup. Workers (coding agents) own: the implementation.
 */

import type { PullRequestId, RepositoryId, TaskId } from '@dark-kitchen/core';
import type { FullScmAdapter, MergePullRequestInput } from '@dark-kitchen/scm';
import type { FullTrackerAdapter } from '@dark-kitchen/tracker';

export interface WorkflowResult {
  readonly taskId: TaskId;
  readonly summary: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly commits: readonly string[];
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
  readonly warnings?: readonly string[];
  /** Set to true when the outcome is intentionally no code change. */
  readonly noCodeOutcome?: boolean;
}

export interface PrLifecycleOptions {
  readonly repositoryId: RepositoryId;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly requiredChecks?: readonly string[];
  readonly mergeStrategy?: 'squash' | 'merge' | 'rebase';
  readonly autoMerge?: boolean;
  readonly requiredVerificationProfiles?: readonly string[];
  readonly checkPollIntervalMs?: number;
  readonly checkTimeoutMs?: number;
}

export interface PrLifecycleResult {
  readonly pullRequestId?: PullRequestId;
  readonly merged: boolean;
  readonly trackerClosed: boolean;
  readonly worktreeReleased: boolean;
  readonly state:
    | 'pr-created'
    | 'checks-failed'
    | 'merge-refused'
    | 'merged'
    | 'tracker-close-failed'
    | 'awaiting-approval'
    | 'no-code-outcome';
  readonly errorMessage?: string;
}

export type WorktreeReleaseFn = (taskId: TaskId) => Promise<void>;

/**
 * Orchestrates the full autonomous lifecycle after a workflow completes.
 */
export class PrLifecycleOrchestrator {
  private readonly scm: FullScmAdapter;
  private readonly tracker: FullTrackerAdapter;

  public constructor(scm: FullScmAdapter, tracker: FullTrackerAdapter) {
    this.scm = scm;
    this.tracker = tracker;
  }

  public async run(
    result: WorkflowResult,
    options: PrLifecycleOptions,
    releaseWorktree?: WorktreeReleaseFn,
  ): Promise<PrLifecycleResult> {
    // No-code outcome: skip PR creation
    if (result.noCodeOutcome && result.commits?.length === 0) {
      await this.closeTrackerTask(result.taskId);
      if (releaseWorktree) await releaseWorktree(result.taskId);
      return {
        merged: false,
        trackerClosed: true,
        worktreeReleased: true,
        state: 'no-code-outcome',
      };
    }

    // Validate workflow result before proceeding
    if (!result.repositoryTestsPassed) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'checks-failed',
        errorMessage: 'Repository tests did not pass',
      };
    }

    if (result.commits.length === 0 && !result.noCodeOutcome) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'checks-failed',
        errorMessage: 'No commits in worktree',
      };
    }

    // Create or reuse PR
    let pr = await this.scm.findPullRequestByBranch(options.repositoryId, options.sourceBranch);
    if (!pr) {
      const body = buildPrBody(result);
      pr = await this.scm.createPullRequest({
        repositoryId: options.repositoryId,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        title: `[DK] Task ${result.taskId}: ${result.summary}`,
        body,
        taskId: result.taskId,
      });
    }

    if (!options.autoMerge) {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'awaiting-approval',
      };
    }

    // Poll checks
    const checks = await this.scm.pollChecks(pr.id, {
      intervalMs: options.checkPollIntervalMs ?? 30_000,
      timeoutMs: options.checkTimeoutMs ?? 600_000,
    });

    const failedChecks = (options.requiredChecks ?? []).filter((req) => {
      const check = checks.find((c) => c.name === req);
      return !check || check.status !== 'passed';
    });

    if (failedChecks.length > 0) {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'checks-failed',
        errorMessage: `Required checks failed: ${failedChecks.join(', ')}`,
      };
    }

    // Merge
    const mergeInput: MergePullRequestInput = {
      pullRequestId: pr.id,
      repositoryId: options.repositoryId,
      strategy: options.mergeStrategy ?? 'squash',
      ...(options.requiredChecks ? { requiredChecks: options.requiredChecks } : {}),
    };

    let mergedPr;
    try {
      mergedPr = await this.scm.merge(mergeInput);
    } catch (err) {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'merge-refused',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    // Close tracker task (if merge succeeds but tracker fails, preserve recoverable state)
    let trackerClosed = false;
    try {
      await this.closeTrackerTask(result.taskId);
      trackerClosed = true;
    } catch {
      return {
        pullRequestId: mergedPr.id,
        merged: true,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'tracker-close-failed',
        errorMessage: 'PR merged but tracker close failed — retry with dk runs',
      };
    }

    // Release worktree
    if (releaseWorktree) await releaseWorktree(result.taskId);

    return {
      pullRequestId: mergedPr.id,
      merged: true,
      trackerClosed,
      worktreeReleased: true,
      state: 'merged',
    };
  }

  private async closeTrackerTask(taskId: TaskId): Promise<void> {
    await this.tracker.updateTask(taskId, { status: 'completed' });
  }
}

function buildPrBody(result: WorkflowResult): string {
  const lines: string[] = [result.summary];
  if (result.verificationGateSummary) {
    lines.push('', `**Verification:** ${result.verificationGateSummary}`);
  }
  if (result.evidenceRefs && result.evidenceRefs.length > 0) {
    lines.push('', '**Evidence:**');
    for (const ref of result.evidenceRefs) {
      lines.push(`- ${ref}`);
    }
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('', '**Warnings:**');
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
  }
  return lines.join('\n');
}
