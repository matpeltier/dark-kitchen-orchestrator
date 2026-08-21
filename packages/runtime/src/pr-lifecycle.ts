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
  /** Content digests (`sha256:<hex>`) keyed by evidence reference when readable. */
  readonly evidenceAttestations?: Readonly<Record<string, string>>;
  /** Structured, independently produced verification proofs. */
  readonly verificationResults?: readonly VerificationProof[];
  readonly warnings?: readonly string[];
  /** False when unintended uncommitted changes remain in the task worktree. */
  readonly worktreeClean?: boolean;
  /** Set to true when the outcome is intentionally no code change. */
  readonly noCodeOutcome?: boolean;
}

export interface VerificationProof {
  readonly profileId: string;
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly summary?: string;
  readonly evidenceRefs: readonly string[];
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
  readonly deleteHeadBranchAfterMerge?: boolean;
}

export interface PrLifecycleResult {
  readonly pullRequestId?: PullRequestId;
  readonly merged: boolean;
  readonly trackerClosed: boolean;
  readonly worktreeReleased: boolean;
  readonly state:
    | 'pr-created'
    | 'checks-failed'
    | 'pr-failed'
    | 'merge-refused'
    | 'merged'
    | 'tracker-close-failed'
    | 'verification-failed'
    | 'workflow-invalid'
    | 'merge-verification-failed'
    | 'worktree-release-failed'
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
    if (!result.summary.trim()) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Workflow summary must not be empty',
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

    if (!result.reviewPassed) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Independent review did not pass',
      };
    }

    if (result.worktreeClean === false) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Task worktree contains unintended uncommitted changes',
      };
    }

    const verificationError = validateVerificationProofs(result, options);
    if (verificationError) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'verification-failed',
        errorMessage: verificationError,
      };
    }

    // A valid no-code outcome still has to pass tests, independent review, and
    // any configured verification gate before the tracker can be closed.
    if (result.noCodeOutcome) {
      if (result.commits.length > 0) {
        return {
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'workflow-invalid',
          errorMessage: 'No-code outcome unexpectedly contains commits',
        };
      }
      try {
        await this.closeTrackerTask(result.taskId);
      } catch (error) {
        return {
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'tracker-close-failed',
          errorMessage: `No-code outcome passed but tracker close failed: ${safeErrorMessage(error)}`,
        };
      }
      if (releaseWorktree) {
        try {
          await releaseWorktree(result.taskId);
        } catch (error) {
          return {
            merged: false,
            trackerClosed: true,
            worktreeReleased: false,
            state: 'worktree-release-failed',
            errorMessage: safeErrorMessage(error),
          };
        }
      }
      return {
        merged: false,
        trackerClosed: true,
        worktreeReleased: releaseWorktree !== undefined,
        state: 'no-code-outcome',
      };
    }

    if (result.commits.length === 0) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'checks-failed',
        errorMessage: 'No commits in worktree',
      };
    }
    if (result.commits.some((commit) => !commit.trim())) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Workflow result contains an empty commit reference',
      };
    }

    if (!options.sourceBranch.trim() || !options.targetBranch.trim()) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Source and target branches must not be empty',
      };
    }
    if (options.sourceBranch === options.targetBranch) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'Source and target branches must be different',
      };
    }

    const body = buildPrBody(result);
    if (body.length > 60_000) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'workflow-invalid',
        errorMessage: 'PR summary and proof metadata exceed the safe body limit',
      };
    }

    // Create or reuse PR
    let pr;
    try {
      pr = await this.scm.findPullRequestByBranch(options.repositoryId, options.sourceBranch);
      if (!pr) {
        pr = await this.scm.createPullRequest({
          repositoryId: options.repositoryId,
          sourceBranch: options.sourceBranch,
          targetBranch: options.targetBranch,
          title: buildPrTitle(result),
          body,
          taskId: result.taskId,
        });
      } else if (pr.status === 'open') {
        // A reused PR must always carry the freshest proofs from this run;
        // otherwise retries publish evidence that never reaches GitHub.
        await this.scm.updatePullRequestBody({ pullRequestId: pr.id, body });
      }
    } catch (error) {
      return {
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'pr-failed',
        errorMessage: `Could not create or recover pull request: ${safeErrorMessage(error)}`,
      };
    }
    if (pr.status === 'closed') {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'pr-failed',
        errorMessage: 'Existing pull request is closed without merge',
      };
    }

    if (!options.autoMerge && pr.status !== 'merged') {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'awaiting-approval',
      };
    }

    if (
      options.autoMerge &&
      pr.status !== 'merged' &&
      (options.requiredChecks === undefined || options.requiredChecks.length === 0)
    ) {
      return {
        pullRequestId: pr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'merge-refused',
        errorMessage: 'Auto-merge requires at least one explicitly configured required SCM check.',
      };
    }

    let mergedPr = pr;
    if (pr.status !== 'merged') {
      // Poll checks. Network/timeouts become recoverable lifecycle state rather
      // than escaping and losing the run's PR/evidence context.
      let checks;
      try {
        checks = await this.scm.pollChecks(pr.id, {
          intervalMs: options.checkPollIntervalMs ?? 30_000,
          timeoutMs: options.checkTimeoutMs ?? 600_000,
          ...(options.requiredChecks ? { requiredChecks: options.requiredChecks } : {}),
        });
      } catch (error) {
        return {
          pullRequestId: pr.id,
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'checks-failed',
          errorMessage: `Could not poll SCM checks: ${safeErrorMessage(error)}`,
        };
      }

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

      // Refresh the PR after checks and bind the merge to its exact head. A
      // force-push between proof and merge must fail rather than merge untested code.
      let mergeHeadSha: string | undefined;
      try {
        mergeHeadSha = (await this.scm.getPullRequest(options.repositoryId, pr.id)).headSha;
      } catch (error) {
        return {
          pullRequestId: pr.id,
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'merge-refused',
          errorMessage: `Could not refresh PR head before merge: ${safeErrorMessage(error)}`,
        };
      }
      if (!mergeHeadSha) {
        return {
          pullRequestId: pr.id,
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'merge-refused',
          errorMessage: 'SCM did not provide a PR head SHA for compare-and-merge protection',
        };
      }

      // Merge
      const mergeInput: MergePullRequestInput = {
        pullRequestId: pr.id,
        repositoryId: options.repositoryId,
        strategy: options.mergeStrategy ?? 'squash',
        expectedHeadSha: mergeHeadSha,
        ...(options.requiredChecks ? { requiredChecks: options.requiredChecks } : {}),
      };

      try {
        mergedPr = await this.scm.merge(mergeInput);
      } catch (err) {
        return {
          pullRequestId: pr.id,
          merged: false,
          trackerClosed: false,
          worktreeReleased: false,
          state: 'merge-refused',
          errorMessage: safeErrorMessage(err),
        };
      }
    }

    let mergeVerified = false;
    try {
      mergeVerified = await this.scm.verifyMerged(mergedPr.id);
    } catch (error) {
      return {
        pullRequestId: mergedPr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'merge-verification-failed',
        errorMessage: `Could not verify merged state: ${safeErrorMessage(error)}`,
      };
    }
    if (!mergeVerified) {
      return {
        pullRequestId: mergedPr.id,
        merged: false,
        trackerClosed: false,
        worktreeReleased: false,
        state: 'merge-verification-failed',
        errorMessage: 'SCM did not confirm that the pull request is merged',
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

    // Cleanup only after both SCM merge and tracker completion are verified.
    if (options.deleteHeadBranchAfterMerge) {
      await this.scm
        .deleteBranch({ repositoryId: options.repositoryId, branchName: options.sourceBranch })
        .catch(() => {});
    }

    // Release worktree
    if (releaseWorktree) {
      try {
        await releaseWorktree(result.taskId);
      } catch (error) {
        return {
          pullRequestId: mergedPr.id,
          merged: true,
          trackerClosed,
          worktreeReleased: false,
          state: 'worktree-release-failed',
          errorMessage: safeErrorMessage(error),
        };
      }
    }

    return {
      pullRequestId: mergedPr.id,
      merged: true,
      trackerClosed,
      worktreeReleased: releaseWorktree !== undefined,
      state: 'merged',
    };
  }

  private async closeTrackerTask(taskId: TaskId): Promise<void> {
    await this.tracker.updateTask(taskId, { status: 'completed' });
  }
}

function buildPrTitle(result: WorkflowResult): string {
  const maxTitleLength = 256;
  const summary = redactSecrets(result.summary)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = `[DK] Task ${result.taskId}: ${summary}`.trim();
  if (title.length <= maxTitleLength) return title;
  return `${title.slice(0, maxTitleLength - 3).trimEnd()}...`;
}

function buildPrBody(result: WorkflowResult): string {
  const lines: string[] = [sanitizePrText(result.summary)];
  if (result.verificationResults && result.verificationResults.length > 0) {
    lines.push('', '**Verification proofs:**');
    for (const proof of result.verificationResults) {
      const summary = proof.summary ? ` — ${sanitizePrText(proof.summary)}` : '';
      lines.push(`- ${escapeMarkdown(proof.profileId)}: **${proof.status}**${summary}`);
      for (const ref of proof.evidenceRefs)
        lines.push(`  - Evidence: ${formatEvidenceRef(ref, result.evidenceAttestations)}`);
    }
  }
  if (result.verificationGateSummary) {
    lines.push('', `**Verification:** ${sanitizePrText(result.verificationGateSummary)}`);
  }
  if (result.evidenceRefs && result.evidenceRefs.length > 0) {
    lines.push('', '**Evidence:**');
    for (const ref of result.evidenceRefs) {
      lines.push(`- ${formatEvidenceRef(ref, result.evidenceAttestations)}`);
    }
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('', '**Warnings:**');
    for (const w of result.warnings) {
      lines.push(`- ${sanitizePrText(w)}`);
    }
  }
  return lines.join('\n');
}

function formatEvidenceRef(ref: string, attestations?: Readonly<Record<string, string>>): string {
  const digest = attestations?.[ref];
  return escapeMarkdown(digest ? `${ref} — ${digest}` : ref);
}

function validateVerificationProofs(
  result: WorkflowResult,
  options: PrLifecycleOptions,
): string | undefined {
  const required = [...new Set(options.requiredVerificationProfiles ?? [])];
  const proofs = result.verificationResults ?? [];
  if (proofs.length > 50) return 'Workflow contains too many verification proof records';
  let evidenceCount = result.evidenceRefs?.length ?? 0;
  for (const proof of proofs) {
    if (!proof.profileId.trim()) return 'Verification proof contains an empty profile ID';
    for (const ref of proof.evidenceRefs) {
      evidenceCount += 1;
      if (!isSafeEvidenceRef(ref)) {
        return `Verification profile "${proof.profileId}" contains an invalid or sensitive evidence reference`;
      }
    }
  }
  if (evidenceCount > 100) return 'Workflow contains too many evidence references';
  for (const profileId of required) {
    if (!profileId.trim()) return 'Required verification profile ID must not be empty';
    const proof = [...proofs].reverse().find((candidate) => candidate.profileId === profileId);
    if (!proof) return `Missing blocking verification proof for profile "${profileId}"`;
    if (proof.status !== 'passed') {
      return `Blocking verification profile "${profileId}" is ${proof.status}`;
    }
    if (proof.evidenceRefs.length === 0) {
      return `Blocking verification profile "${profileId}" passed without evidence references`;
    }
  }
  for (const ref of result.evidenceRefs ?? []) {
    if (!isSafeEvidenceRef(ref))
      return 'Workflow contains an invalid or sensitive evidence reference';
  }
  return undefined;
}

function isSafeEvidenceRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    !hasControlCharacters(value) &&
    !containsSecret(value)
  );
}

function sanitizePrText(value: string): string {
  return redactSecrets(value).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function escapeMarkdown(value: string): string {
  return sanitizePrText(value).replace(/([\\`*_[\]<>])/g, '\\$1');
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
}

function containsSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

function safeErrorMessage(error: unknown): string {
  return redactSecrets(
    error instanceof Error ? error.message : String(error ?? 'Unknown error'),
  ).slice(0, 1_000);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
