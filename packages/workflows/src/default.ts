/**
 * Default Dark Kitchen workflow.
 *
 * Implements the standard implement → review → optional-verify path.
 * No provider/model names are hardcoded; roles are resolved by the router.
 *
 * Role conventions:
 * - 'implementer': the coding role that writes/modifies code
 * - 'reviewer': independent code review
 * - 'fixer': applies reviewer feedback (may be same or different profile)
 * - 'verifier': runs E2E/verification when a profile is requested
 *
 * These roles are semantic identifiers; the actual harness/model comes from
 * the project config role definitions.
 */

import type { WorkflowBuilder, WorkflowFn } from '@dark-kitchen/workflow-engine';
import {
  requireWorkflowApproval,
  type ResumableApprovalGate,
  type WorkflowApprovalRequest,
} from './approval-gate.js';

export interface DefaultWorkflowInput {
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  readonly verificationProfileId?: string;
  readonly maxFixCycles?: number;
}

export interface DefaultWorkflowResult {
  readonly taskId: string;
  readonly status: 'success' | 'failure' | 'intervention';
  readonly summary: string;
  readonly repositoryTestsPassed: boolean;
  readonly reviewPassed: boolean;
  readonly reviewFindings?: string;
  readonly verificationPassed?: boolean;
  readonly verificationSummary?: string;
  /** SCM-facing alias consumed by the workflow executor/lifecycle. */
  readonly verificationGateSummary?: string;
  readonly evidenceRefs?: readonly string[];
  readonly commits: readonly string[];
  readonly noCodeOutcome?: boolean;
  readonly approvalStatus?: 'approved' | 'rejected';
  readonly intervention?: {
    readonly kind: 'verification-failed' | WorkflowApprovalRequest['kind'];
    readonly gateId?: string;
    readonly summary: string;
    readonly details: string;
    readonly retryable: boolean;
  };
}

export interface SpecializedWorkflowTaskContext {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface DesignFrontendWorkflowOptions {
  readonly task?: SpecializedWorkflowTaskContext;
  /** Present only when the normalized task requests a configured profile. */
  readonly verificationProfileId?: string;
  readonly maxFixCycles?: number;
  readonly maxVerificationFixCycles?: number;
  readonly verificationRetryDelayMs?: number;
}

export interface HighRiskWorkflowOptions {
  readonly approvalGate: ResumableApprovalGate;
  readonly task?: SpecializedWorkflowTaskContext;
  readonly gateId?: string;
  readonly riskKind?: WorkflowApprovalRequest['kind'];
  readonly requestedActions?: readonly string[];
  readonly maxFixCycles?: number;
  readonly verificationProfileId?: string;
  readonly maxVerificationFixCycles?: number;
  readonly verificationRetryDelayMs?: number;
}

const REVIEW_PROMPT = [
  'Review the implementation by inspecting the working tree: run `git status` and',
  '`git diff` and read the changed files. Check for correctness, edge cases, missing',
  'tests, and anything that does not satisfy the task requirements.',
  '',
  'You MUST respond with a single JSON object and nothing else — no prose, no',
  'markdown code fences, no trailing text. Use exactly this shape:',
  '  {"passed": true}',
  'or, if there are problems:',
  '  {"passed": false, "findings": "a concise, actionable list of issues to fix"}',
].join('\n');

const DEFAULT_MAX_FIX_CYCLES = 2;

/**
 * Default implementation workflow:
 * 1. Implement the task (implementer role)
 * 2. Independent review (reviewer role)
 * 3. If review findings: apply fixes (fixer role) and re-review, bounded
 * 4. If verification profile: verify (verifier role) - bounded loops
 */
export const defaultWorkflow: WorkflowFn<DefaultWorkflowResult> = async (builder) => {
  const taskPhase = builder.phase('implementation');

  // Step 1: Implementation
  const implResult = await taskPhase.agent({
    role: 'implementer',
    prompt: 'Implement the task according to the requirements.',
  });

  // Step 2: Independent review with bounded fix cycles
  const review = await runReviewLoop(builder, implResult.result, DEFAULT_MAX_FIX_CYCLES);

  // Step 3: Explicit repository validation. The workflow reports the actual
  // semantic tester verdict instead of assuming tests passed.
  const repositoryTestsPassed = await runRepositoryValidation(builder);

  const baseResult: DefaultWorkflowResult = {
    taskId: 'unknown',
    status: review.passed && repositoryTestsPassed ? 'success' : 'failure',
    summary: String(implResult.result ?? ''),
    repositoryTestsPassed,
    reviewPassed: review.passed,
    commits: [],
  };
  if (review.findings) Object.assign(baseResult, { reviewFindings: review.findings });
  return baseResult;
};

/**
 * Workflow with optional E2E verification gate.
 */
export function createWorkflowWithVerification(
  options: {
    readonly maxVerificationFixCycles?: number;
    readonly verificationRetryDelayMs?: number;
  } = {},
): WorkflowFn<DefaultWorkflowResult> {
  const maxVerificationFixCycles = normalizeLoopBound(
    options.maxVerificationFixCycles,
    DEFAULT_MAX_FIX_CYCLES,
  );
  return async (builder) => {
    // Run base workflow steps
    const basePhase = builder.phase('base');
    const implResult = await basePhase.agent({
      role: 'implementer',
      prompt: 'Implement the task.',
    });

    const review = await runReviewLoop(builder, implResult.result, DEFAULT_MAX_FIX_CYCLES);
    const verifyData = await runVerificationLoop(
      builder,
      implResult.result,
      maxVerificationFixCycles,
      {},
      options.verificationRetryDelayMs,
    );

    // Verification fixes may change the repository, so final validation must
    // happen after the bounded fix/reverify loop rather than before it.
    const repositoryTestsPassed = await runRepositoryValidation(builder);

    const verifyResult2: DefaultWorkflowResult = {
      taskId: 'unknown',
      status:
        review.passed && repositoryTestsPassed
          ? verifyData.passed
            ? 'success'
            : 'intervention'
          : 'failure',
      summary: String(implResult.result ?? ''),
      repositoryTestsPassed,
      reviewPassed: review.passed,
      verificationPassed: verifyData.passed,
      commits: [],
    };
    if (verifyData.summary) {
      Object.assign(verifyResult2, {
        verificationSummary: verifyData.summary,
        verificationGateSummary: verifyData.summary,
      });
    }
    if (verifyData.evidenceRefs) {
      Object.assign(verifyResult2, { evidenceRefs: [...verifyData.evidenceRefs] });
    }
    if (!verifyData.passed) {
      Object.assign(verifyResult2, {
        intervention: {
          kind: 'verification-failed',
          summary: 'Independent verification did not pass.',
          details: verifyData.summary ?? 'The verifier exhausted its bounded retry budget.',
          retryable: true,
        },
      });
    }
    return verifyResult2;
  };
}

export const workflowWithVerification = createWorkflowWithVerification();

/**
 * Specialized design/frontend example. The designer is a semantic role and
 * the optional verification profile comes from normalized task/config input.
 */
export function createDesignFrontendWorkflow(
  options: DesignFrontendWorkflowOptions = {},
): WorkflowFn<DefaultWorkflowResult> {
  const maxFixCycles = normalizeLoopBound(options.maxFixCycles, DEFAULT_MAX_FIX_CYCLES);
  const maxVerificationFixCycles = normalizeLoopBound(
    options.maxVerificationFixCycles,
    DEFAULT_MAX_FIX_CYCLES,
  );
  const taskContext = options.task ? { ...options.task } : {};

  return async (builder) => {
    const design = await builder.phase('design').agent({
      role: 'designer',
      prompt: [
        'Produce an implementation-ready frontend design for the task.',
        'Cover interaction states, accessibility, responsive behavior, and visual acceptance criteria.',
        'Return a concise structured design brief; do not modify the roadmap or launch other tasks.',
      ].join('\n'),
      context: { task: taskContext },
    });

    const implementation = await builder.phase('implementation').agent({
      role: 'implementer',
      prompt: [
        'Implement the task in the existing task worktree using the approved design brief.',
        'Do not mutate the roadmap or launch other tracker tasks.',
      ].join('\n'),
      context: { task: taskContext, designBrief: design.result },
    });

    const review = await runReviewLoop(builder, implementation.result, maxFixCycles, {
      taskContext,
      validationContext: { designBrief: design.result },
    });

    const verification =
      options.verificationProfileId && review.passed
        ? await runVerificationLoop(
            builder,
            implementation.result,
            maxVerificationFixCycles,
            {
              taskContext,
              verificationProfileId: options.verificationProfileId,
              expectations: design.result,
            },
            options.verificationRetryDelayMs,
          )
        : undefined;
    const repositoryTestsPassed = await runRepositoryValidation(builder, {
      task: taskContext,
      designBrief: design.result,
      ...(options.verificationProfileId
        ? { verificationProfileId: options.verificationProfileId }
        : {}),
    });
    const status = outcomeStatus(review.passed, repositoryTestsPassed, verification?.passed);
    const result: DefaultWorkflowResult = {
      taskId: options.task?.id ?? 'unknown',
      status,
      summary: String(implementation.result ?? ''),
      repositoryTestsPassed,
      reviewPassed: review.passed,
      ...(review.findings ? { reviewFindings: review.findings } : {}),
      ...(verification
        ? {
            verificationPassed: verification.passed,
            ...(verification.summary
              ? {
                  verificationSummary: verification.summary,
                  verificationGateSummary: verification.summary,
                }
              : {}),
            ...(verification.evidenceRefs ? { evidenceRefs: [...verification.evidenceRefs] } : {}),
          }
        : {}),
      commits: [],
    };
    if (verification && !verification.passed) {
      Object.assign(result, {
        intervention: {
          kind: 'verification-failed',
          summary: `Verification profile ${options.verificationProfileId ?? 'requested'} failed.`,
          details: verification.summary ?? 'The bounded fix and reverify loop was exhausted.',
          retryable: true,
        },
      });
    }
    return result;
  };
}

export const designFrontendWorkflow = createDesignFrontendWorkflow();

/**
 * High-risk example with architecture and security review around a durable,
 * resumable human approval boundary. The host must persist resolutions by the
 * stable gate ID and rerun with the same workflow run ID/journal.
 */
export function createHighRiskWorkflow(
  options: HighRiskWorkflowOptions,
): WorkflowFn<DefaultWorkflowResult> {
  const maxFixCycles = normalizeLoopBound(options.maxFixCycles, DEFAULT_MAX_FIX_CYCLES);
  const maxVerificationFixCycles = normalizeLoopBound(
    options.maxVerificationFixCycles,
    DEFAULT_MAX_FIX_CYCLES,
  );
  const taskContext = options.task ? { ...options.task } : {};
  const gateId =
    options.gateId ?? `${options.task?.id ?? 'unknown'}:high-risk:pre-implementation-approval`;

  return async (builder) => {
    const architecture = await builder.phase('architecture').agent({
      role: 'architect',
      prompt: [
        'Define the implementation plan, trust boundaries, rollback strategy, and blast radius.',
        'Identify every destructive or sensitive action that needs explicit human approval.',
        'Do not implement changes or launch other tracker tasks.',
      ].join('\n'),
      context: { task: taskContext },
    });

    const approvalRequest: WorkflowApprovalRequest = {
      gateId,
      kind: options.riskKind ?? 'sensitive-change-approval',
      summary: 'Approve the high-risk implementation plan before repository mutation.',
      details: String(architecture.result ?? 'No architecture details were returned.'),
      requestedActions: options.requestedActions ?? [
        'Apply the reviewed sensitive changes in the existing task worktree.',
      ],
      taskContext,
    };
    const approval = await requireWorkflowApproval(options.approvalGate, approvalRequest);
    if (approval.status === 'rejected') {
      return {
        taskId: options.task?.id ?? 'unknown',
        status: 'failure',
        summary: approval.note ?? 'The high-risk implementation was rejected.',
        repositoryTestsPassed: false,
        reviewPassed: false,
        approvalStatus: 'rejected',
        commits: [],
      };
    }

    const implementation = await builder.phase('implementation').agent({
      role: 'implementer',
      prompt: [
        'Implement only the approved high-risk plan in the existing task worktree.',
        'Preserve rollback safety and do not mutate the roadmap or launch other tracker tasks.',
      ].join('\n'),
      context: {
        task: taskContext,
        approvedArchitecture: architecture.result,
        approval: {
          gateId,
          ...(approval.interventionId ? { interventionId: approval.interventionId } : {}),
          ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
        },
      },
    });

    const securityReview = await runReviewLoop(builder, implementation.result, maxFixCycles, {
      reviewerRole: 'security-reviewer',
      reviewPhase: 'security-review',
      fixPhase: 'security-fix',
      taskContext,
      validationContext: { approvedArchitecture: architecture.result, gateId },
    });
    const independentReview = securityReview.passed
      ? await runReviewLoop(builder, implementation.result, maxFixCycles, {
          taskContext,
          validationContext: { approvedArchitecture: architecture.result, gateId },
        })
      : { passed: false, findings: 'Security review did not pass.' };
    const verification =
      options.verificationProfileId && securityReview.passed && independentReview.passed
        ? await runVerificationLoop(
            builder,
            implementation.result,
            maxVerificationFixCycles,
            {
              taskContext,
              verificationProfileId: options.verificationProfileId,
              expectations: architecture.result,
            },
            options.verificationRetryDelayMs,
          )
        : undefined;
    const repositoryTestsPassed = await runRepositoryValidation(builder, {
      task: taskContext,
      approvedArchitecture: architecture.result,
      gateId,
    });
    const reviewPassed = securityReview.passed && independentReview.passed;
    const findings = [securityReview.findings, independentReview.findings]
      .filter((finding): finding is string => Boolean(finding))
      .join('\n');

    const result: DefaultWorkflowResult = {
      taskId: options.task?.id ?? 'unknown',
      status: outcomeStatus(reviewPassed, repositoryTestsPassed, verification?.passed),
      summary: String(implementation.result ?? ''),
      repositoryTestsPassed,
      reviewPassed,
      ...(findings ? { reviewFindings: findings } : {}),
      approvalStatus: 'approved',
      commits: [],
    };
    if (verification) {
      Object.assign(result, {
        verificationPassed: verification.passed,
        ...(verification.summary
          ? {
              verificationSummary: verification.summary,
              verificationGateSummary: verification.summary,
            }
          : {}),
        ...(verification.evidenceRefs ? { evidenceRefs: [...verification.evidenceRefs] } : {}),
      });
      if (!verification.passed) {
        Object.assign(result, {
          intervention: {
            kind: 'verification-failed',
            summary: `Verification profile ${options.verificationProfileId} failed.`,
            details: verification.summary ?? 'The bounded verification retry budget was exhausted.',
            retryable: true,
          },
        });
      }
    }
    return result;
  };
}

/** Fail-closed stock example; production hosts inject their durable gate via the factory. */
export const highRiskWorkflow = createHighRiskWorkflow({
  approvalGate: {
    request: () => Promise.resolve({ status: 'pending' }),
  },
});

/**
 * Specialized security-review workflow.
 * Adds an architect/designer pre-phase and a security reviewer.
 */
export const securityReviewWorkflow: WorkflowFn<DefaultWorkflowResult> = async (builder) => {
  // Architect phase
  await builder.phase('architecture').agent({
    role: 'architect',
    prompt: 'Define the approach and design boundaries before implementation.',
  });

  // Parallel: implement + security-focused review plan
  const [implResult] = await builder.parallel([
    async (b) => b.agent({ role: 'implementer', prompt: 'Implement the feature.' }),
  ]);

  // Security review
  const secReviewResult = await builder.phase('security-review').agent({
    role: 'security-reviewer',
    prompt: 'Review the implementation for security issues.',
    context: { impl: implResult?.result },
  });

  const secData = parseReviewResult(secReviewResult.result);
  const repositoryTestsPassed = await runRepositoryValidation(builder);

  const secResult: DefaultWorkflowResult = {
    taskId: 'unknown',
    status: secData.passed && repositoryTestsPassed ? 'success' : 'failure',
    summary: String(implResult?.result ?? ''),
    repositoryTestsPassed,
    reviewPassed: secData.passed,
    commits: [],
  };
  if (secData.findings) Object.assign(secResult, { reviewFindings: secData.findings });
  return secResult;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a JSON object from an agent's output. Agents often wrap the JSON in
 * prose, markdown code fences, or stray characters, so we accept any of:
 *   - the value already being an object,
 *   - the whole string being JSON,
 *   - a ```json … ``` fenced block,
 *   - the first balanced { … } object in the text.
 */
function extractJsonObject(result: unknown): Record<string, unknown> | null {
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  if (typeof result !== 'string') return null;
  const text = result.trim();

  // Whole-string JSON
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  // Fenced code block (```json … ``` or ``` … ```)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }

  // First balanced { … } object
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // fall through
          }
          break;
        }
      }
    }
  }

  return null;
}

function parseReviewResult(result: unknown): { passed: boolean; findings?: string } {
  const r = extractJsonObject(result);
  if (!r) return { passed: false, findings: 'Reviewer did not return a valid JSON verdict.' };
  const base: { passed: boolean; findings?: string } = { passed: r['passed'] === true };
  if (typeof r['findings'] === 'string') Object.assign(base, { findings: r['findings'] });
  return base;
}

async function runReviewLoop(
  builder: WorkflowBuilder,
  implementation: unknown,
  maxFixCycles: number,
  options: {
    readonly reviewerRole?: string;
    readonly reviewPhase?: string;
    readonly fixPhase?: string;
    readonly taskContext?: Readonly<Record<string, unknown>>;
    readonly validationContext?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<{ passed: boolean; findings?: string }> {
  const reviewerRole = options.reviewerRole ?? 'reviewer';
  const reviewPhase = options.reviewPhase ?? 'review';
  const fixPhase = options.fixPhase ?? 'fix';
  let latest: { passed: boolean; findings?: string } = { passed: false };
  for (let cycle = 0; cycle <= maxFixCycles; cycle++) {
    const reviewResult = await builder.phase(`${reviewPhase}-${cycle}`).agent({
      role: reviewerRole,
      prompt: REVIEW_PROMPT,
      context: {
        implementation,
        preserveExistingWorktree: true,
        ...(options.taskContext ? { task: options.taskContext } : {}),
        ...(options.validationContext ? { validation: options.validationContext } : {}),
        ...(latest.findings ? { priorFindings: latest.findings } : {}),
      },
    });
    latest = parseReviewResult(reviewResult.result);
    if (latest.passed) return latest;
    if (cycle < maxFixCycles) {
      await builder.phase(`${fixPhase}-${cycle}`).agent({
        role: 'fixer',
        prompt:
          'Continue in the existing task worktree. Resolve every review finding at its root cause, inspect the surrounding subsystem for the same defect class, rerun relevant validation, reread the acceptance criteria, and inspect the final diff before returning. Do not restart the implementation, mutate the roadmap, or launch other tracker tasks.',
        context: {
          implementation,
          preserveExistingWorktree: true,
          findings: latest.findings ?? 'Reviewer returned no actionable findings.',
          ...(options.taskContext ? { task: options.taskContext } : {}),
          ...(options.validationContext ? { validation: options.validationContext } : {}),
        },
      });
    }
  }
  return latest;
}

async function runRepositoryValidation(
  builder: WorkflowBuilder,
  context: Readonly<Record<string, unknown>> = {},
): Promise<boolean> {
  const result = await builder.phase('repository-validation').agent({
    role: 'repository-tester',
    prompt: [
      'Run the repository tests, typecheck, and lint relevant to the changes.',
      'Inspect failures rather than claiming success without execution.',
      'Return JSON only: {"passed": true} or {"passed": false, "findings": "..."}.',
    ].join('\n'),
    context,
  });
  return parseReviewResult(result.result).passed;
}

async function runVerificationLoop(
  builder: WorkflowBuilder,
  implementation: unknown,
  maxFixCycles: number,
  context: Readonly<Record<string, unknown>> = {},
  retryDelayMs = 0,
): Promise<{ passed: boolean; summary?: string; evidenceRefs?: readonly string[] }> {
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3_600_000) {
    throw new Error('Verification retry delay must be an integer between 0 and 3600000 ms.');
  }
  let latest: { passed: boolean; summary?: string; evidenceRefs?: readonly string[] } = {
    passed: false,
  };
  for (let cycle = 0; cycle <= maxFixCycles; cycle++) {
    const verifyResult = await builder.phase(`verification-${cycle}`).agent({
      role: 'verifier',
      prompt: [
        'Independently verify the observable acceptance criteria in the configured environment.',
        'Use only configured tools, MCP servers, skills, and capabilities; do not mutate the roadmap or launch tracker tasks.',
        'Return JSON only: {"passed": true|false, "summary": "...", "evidenceRefs": ["..."]}.',
      ].join('\n'),
      context: { implementation, ...context },
    });
    latest = parseVerificationResult(verifyResult.result);
    if (latest.passed) return latest;
    if (cycle < maxFixCycles) {
      if (retryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
      await builder.phase(`verification-fix-${cycle}`).agent({
        role: 'fixer',
        prompt:
          'Continue in the existing task worktree. Resolve the verification failure at its root cause, inspect the surrounding subsystem for the same defect class, rerun relevant validation, reread the acceptance criteria, and inspect the final diff. Do not restart the implementation, mutate the roadmap, or launch other tracker tasks.',
        context: {
          implementation,
          preserveExistingWorktree: true,
          verificationSummary: latest.summary ?? 'Verification failed.',
          evidenceRefs: latest.evidenceRefs ?? [],
          ...context,
        },
      });
    }
  }
  return latest;
}

function normalizeLoopBound(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 10) {
    throw new Error('Workflow fix-cycle limit must be an integer between 0 and 10.');
  }
  return resolved;
}

function outcomeStatus(
  reviewPassed: boolean,
  repositoryTestsPassed: boolean,
  verificationPassed?: boolean,
): DefaultWorkflowResult['status'] {
  if (!reviewPassed || !repositoryTestsPassed) return 'failure';
  if (verificationPassed === false) return 'intervention';
  return 'success';
}

function parseVerificationResult(result: unknown): {
  passed: boolean;
  summary?: string;
  evidenceRefs?: readonly string[];
} {
  const r = extractJsonObject(result);
  if (!r) return { passed: false, summary: 'Verifier did not return a valid JSON verdict.' };
  const base: { passed: boolean; summary?: string; evidenceRefs?: readonly string[] } = {
    passed: r['passed'] === true,
  };
  if (typeof r['summary'] === 'string') Object.assign(base, { summary: r['summary'] });
  if (
    Array.isArray(r['evidenceRefs']) &&
    r['evidenceRefs'].every((ref) => typeof ref === 'string')
  ) {
    Object.assign(base, { evidenceRefs: [...r['evidenceRefs']] });
  }
  return base;
}
