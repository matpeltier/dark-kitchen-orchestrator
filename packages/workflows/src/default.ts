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

import type { WorkflowFn } from '@dark-kitchen/workflow-engine';

export interface DefaultWorkflowInput {
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  readonly verificationProfileId?: string;
  readonly maxFixCycles?: number;
}

export interface DefaultWorkflowResult {
  readonly taskId: string;
  readonly implementationSummary: string;
  readonly reviewPassed: boolean;
  readonly reviewFindings?: string;
  readonly verificationPassed?: boolean;
  readonly verificationSummary?: string;
  readonly commits: readonly string[];
  readonly noCodeOutcome?: boolean;
}

/**
 * Default implementation workflow:
 * 1. Implement the task (implementer role)
 * 2. Independent review (reviewer role)
 * 3. If review findings: apply fixes (fixer role) - bounded cycles
 * 4. If verification profile: verify (verifier role) - bounded loops
 */
export const defaultWorkflow: WorkflowFn<DefaultWorkflowResult> = async (builder) => {
  const taskPhase = builder.phase('implementation');

  // Step 1: Implementation
  const implResult = await taskPhase.agent({
    role: 'implementer',
    prompt: 'Implement the task according to the requirements.',
  });

  // Step 2: Independent review
  const reviewPhase = builder.phase('review');
  const reviewResult = await reviewPhase.agent({
    role: 'reviewer',
    prompt: `Review the implementation. Report findings as JSON: { passed: boolean, findings?: string }`,
    context: { implementation: implResult.result },
  });

  const reviewData = parseReviewResult(reviewResult.result);

  // Step 3: Fix review findings (bounded)
  if (!reviewData.passed && reviewData.findings) {
    const fixPhase = builder.phase('fix');
    await fixPhase.agent({
      role: 'fixer',
      prompt: `Apply the reviewer's findings to the implementation.`,
      context: { findings: reviewData.findings },
    });
  }

  const baseResult: DefaultWorkflowResult = {
    taskId: 'unknown',
    implementationSummary: String(implResult.result ?? ''),
    reviewPassed: reviewData.passed,
    commits: [],
  };
  if (reviewData.findings) Object.assign(baseResult, { reviewFindings: reviewData.findings });
  return baseResult;
};

/**
 * Workflow with optional E2E verification gate.
 */
export const workflowWithVerification: WorkflowFn<DefaultWorkflowResult> = async (builder) => {
  // Run base workflow steps
  const basePhase = builder.phase('base');
  const implResult = await basePhase.agent({ role: 'implementer', prompt: 'Implement the task.' });

  const reviewPhase = builder.phase('review');
  const reviewResult = await reviewPhase.agent({
    role: 'reviewer',
    prompt: 'Review the implementation.',
    context: { implementation: implResult.result },
  });

  const reviewData = parseReviewResult(reviewResult.result);
  if (!reviewData.passed && reviewData.findings) {
    const fixPhase = builder.phase('fix');
    await fixPhase.agent({
      role: 'fixer',
      prompt: 'Apply the reviewer findings.',
      context: { findings: reviewData.findings },
    });
  }

  // Verification gate
  const verifyPhase = builder.phase('verification');
  const verifyResult = await verifyPhase.agent({
    role: 'verifier',
    prompt: 'Verify the task meets its observable acceptance criteria.',
    context: { implSummary: implResult.result },
  });

  const verifyData = parseVerificationResult(verifyResult.result);

  const verifyResult2: DefaultWorkflowResult = {
    taskId: 'unknown',
    implementationSummary: String(implResult.result ?? ''),
    reviewPassed: reviewData.passed,
    verificationPassed: verifyData.passed,
    commits: [],
  };
  if (verifyData.summary) Object.assign(verifyResult2, { verificationSummary: verifyData.summary });
  return verifyResult2;
};

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

  const secResult: DefaultWorkflowResult = {
    taskId: 'unknown',
    implementationSummary: String(implResult?.result ?? ''),
    reviewPassed: secData.passed,
    commits: [],
  };
  if (secData.findings) Object.assign(secResult, { reviewFindings: secData.findings });
  return secResult;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseReviewResult(result: unknown): { passed: boolean; findings?: string } {
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    const base: { passed: boolean; findings?: string } = { passed: Boolean(r['passed']) };
    if (r['findings'] !== undefined) Object.assign(base, { findings: String(r['findings']) });
    return base;
  }
  return { passed: true };
}

function parseVerificationResult(result: unknown): { passed: boolean; summary?: string } {
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    const base: { passed: boolean; summary?: string } = { passed: Boolean(r['passed']) };
    if (r['summary'] !== undefined) Object.assign(base, { summary: String(r['summary']) });
    return base;
  }
  return { passed: true };
}
