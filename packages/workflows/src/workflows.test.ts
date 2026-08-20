import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryJournal } from '@dark-kitchen/workflow-engine';
import {
  WorkflowInterventionRequired,
  createDesignFrontendWorkflow,
  createHighRiskWorkflow,
  defaultWorkflow,
  securityReviewWorkflow,
  selectWorkflowForTask,
  workflowWithVerification,
} from './index.js';
import type { RoleResolver } from '@dark-kitchen/workflow-engine';

function makeResolver(responses: Record<string, unknown>): RoleResolver {
  return (role) => async () =>
    responses[role] ?? (role === 'repository-tester' ? { passed: true } : `${role}-result`);
}

describe('defaultWorkflow', () => {
  it('runs implement → review path', async () => {
    const resolver = makeResolver({
      implementer: 'implementation done',
      reviewer: { passed: true },
      fixer: 'fixed',
    });

    const result = await runWorkflow(defaultWorkflow, {
      runId: 'test-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.reviewPassed).toBe(true);
    expect(result.repositoryTestsPassed).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  it('applies fixes when review fails, then re-reviews until passed', async () => {
    const fixerCalled: boolean[] = [];
    const reviewVerdicts = [{ passed: false, findings: 'Fix X' }, { passed: true }];
    let reviewCount = 0;
    const resolver: RoleResolver = (role) => async () => {
      if (role === 'implementer') return 'impl';
      if (role === 'reviewer') {
        const v = reviewVerdicts[Math.min(reviewCount, reviewVerdicts.length - 1)];
        reviewCount++;
        return v;
      }
      if (role === 'fixer') {
        fixerCalled.push(true);
        return 'fixed';
      }
      return 'ok';
    };

    const result = await runWorkflow(defaultWorkflow, {
      runId: 'fix-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(fixerCalled).toHaveLength(1);
    expect(result.reviewPassed).toBe(true);
  });

  it('parses a JSON verdict out of prose and markdown fences', async () => {
    const resolver = makeResolver({
      implementer: 'impl',
      reviewer: 'Here is my review:\n```json\n{"passed": true}\n```',
    });

    const result = await runWorkflow(defaultWorkflow, {
      runId: 'parse-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.reviewPassed).toBe(true);
  });

  it('normalizes nullable optional verdict fields without retrying', async () => {
    let reviews = 0;
    const resolver: RoleResolver = (role) => async () => {
      if (role === 'implementer') return 'impl';
      if (role === 'reviewer') {
        reviews++;
        return { passed: true, findings: null };
      }
      return { passed: true };
    };

    const result = await runWorkflow(defaultWorkflow, {
      runId: 'nullable-verdict',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.reviewPassed).toBe(true);
    expect(reviews).toBe(1);
  });

  it('extracts a failed verdict from plain text and runs the fixer', async () => {
    const fixerCalled: boolean[] = [];
    const reviewVerdicts = [
      'I found problems. {"passed": false, "findings": "missing tests"}',
      { passed: true },
    ];
    let reviewCount = 0;
    const resolver: RoleResolver = (role) => async () => {
      if (role === 'implementer') return 'impl';
      if (role === 'reviewer') {
        const v = reviewVerdicts[Math.min(reviewCount, reviewVerdicts.length - 1)];
        reviewCount++;
        return v;
      }
      if (role === 'fixer') {
        fixerCalled.push(true);
        return 'fixed';
      }
      return { passed: true };
    };

    const result = await runWorkflow(defaultWorkflow, {
      runId: 'extract-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(fixerCalled.length).toBeGreaterThanOrEqual(1);
    expect(result.reviewPassed).toBe(true);
  });

  it('replays from journal on second run', async () => {
    const journal = new InMemoryJournal();
    let implCalls = 0;
    const resolver: RoleResolver = (role) => async () => {
      if (role === 'implementer') {
        implCalls++;
        return 'impl';
      }
      return { passed: true };
    };

    await runWorkflow(defaultWorkflow, { runId: 'replay-wf', journal, resolver });
    implCalls = 0;
    await runWorkflow(defaultWorkflow, { runId: 'replay-wf', journal, resolver });
    expect(implCalls).toBe(0);
  });
});

describe('workflowWithVerification', () => {
  it('runs with verifier role', async () => {
    const resolver = makeResolver({
      implementer: 'impl',
      reviewer: { passed: true },
      verifier: {
        passed: true,
        summary: 'All checks passed',
        evidenceRefs: ['artifact://verification/report'],
      },
    });

    const result = await runWorkflow(workflowWithVerification, {
      runId: 'verify-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.verificationPassed).toBe(true);
    expect(result.verificationSummary).toBe('All checks passed');
    expect(result.verificationGateSummary).toBe('All checks passed');
    expect(result.evidenceRefs).toEqual(['artifact://verification/report']);
  });

  it('bounds verification fixes and reverifies without rerunning implementation', async () => {
    const calls: string[] = [];
    let verifications = 0;
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'implementer') return 'impl';
      if (role === 'reviewer' || role === 'repository-tester') return { passed: true };
      if (role === 'verifier') {
        verifications++;
        return verifications === 1
          ? { passed: false, summary: 'observable mismatch' }
          : { passed: true, summary: 'fixed' };
      }
      return 'fixed';
    };

    const result = await runWorkflow(workflowWithVerification, {
      runId: 'verify-fix',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.verificationPassed).toBe(true);
    expect(calls.filter((role) => role === 'implementer')).toHaveLength(1);
    expect(calls.filter((role) => role === 'fixer')).toHaveLength(1);
    expect(calls.filter((role) => role === 'verifier')).toHaveLength(2);
    expect(calls.at(-1)).toBe('repository-tester');
  });
});

describe('securityReviewWorkflow', () => {
  it('reports the repository tester verdict instead of assuming success', async () => {
    const calls: string[] = [];
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'security-reviewer') return { passed: true };
      if (role === 'repository-tester') return { passed: false, findings: 'lint failed' };
      return `${role}-result`;
    };

    const result = await runWorkflow(securityReviewWorkflow, {
      runId: 'security-validation',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result).toMatchObject({ reviewPassed: true, repositoryTestsPassed: false });
    expect(calls).toContain('repository-tester');
  });
});

describe('design/frontend workflow', () => {
  it('runs the designer before implementation and conditionally verifies with structured proof', async () => {
    const calls: Array<{ role: string; context?: Record<string, unknown> }> = [];
    const resolver: RoleResolver = (role) => async (input) => {
      calls.push({ role, ...(input.context ? { context: input.context } : {}) });
      if (role === 'designer') return { brief: 'responsive accessible UI' };
      if (role === 'implementer') return 'frontend implemented';
      if (role === 'reviewer' || role === 'repository-tester') return { passed: true };
      if (role === 'verifier') {
        return {
          passed: true,
          summary: 'web-e2e passed',
          evidenceRefs: ['artifact://screenshot/home'],
        };
      }
      return 'ok';
    };
    const workflow = createDesignFrontendWorkflow({
      task: { id: 'task-ui', title: 'Build responsive home page' },
      verificationProfileId: 'web-e2e',
    });

    const result = await runWorkflow(workflow, {
      runId: 'design-frontend',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(calls.map((call) => call.role)).toEqual([
      'designer',
      'implementer',
      'reviewer',
      'verifier',
      'repository-tester',
    ]);
    expect(calls[1]?.context).toMatchObject({
      designBrief: { brief: 'responsive accessible UI' },
    });
    expect(result).toMatchObject({
      taskId: 'task-ui',
      status: 'success',
      verificationPassed: true,
      verificationGateSummary: 'web-e2e passed',
      evidenceRefs: ['artifact://screenshot/home'],
    });
  });

  it('bounds the verification fix loop and emits an intervention outcome', async () => {
    const calls: string[] = [];
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'designer' || role === 'implementer' || role === 'fixer') return 'ok';
      if (role === 'reviewer' || role === 'repository-tester') return { passed: true };
      return { passed: false, summary: 'still visually broken' };
    };
    const workflow = createDesignFrontendWorkflow({
      verificationProfileId: 'web-e2e',
      maxVerificationFixCycles: 1,
    });

    const result = await runWorkflow(workflow, {
      runId: 'design-verification-fails',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(calls.filter((role) => role === 'verifier')).toHaveLength(2);
    expect(calls.filter((role) => role === 'fixer')).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'intervention',
      verificationPassed: false,
      intervention: { kind: 'verification-failed', retryable: true },
    });
  });
});

describe('high-risk workflow', () => {
  it('pauses at a stable approval gate and resumes without rerunning architecture', async () => {
    const calls: string[] = [];
    const gateIds: string[] = [];
    let approved = false;
    const approvalGate = {
      request: (request: { gateId: string }) => {
        gateIds.push(request.gateId);
        return Promise.resolve(
          approved
            ? ({ status: 'approved', interventionId: 'intervention-1' } as const)
            : ({ status: 'pending', interventionId: 'intervention-1' } as const),
        );
      },
    };
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'security-reviewer' || role === 'reviewer' || role === 'repository-tester') {
        return { passed: true };
      }
      return `${role}-result`;
    };
    const workflow = createHighRiskWorkflow({
      approvalGate,
      task: { id: 'task-risk', title: 'Rotate production encryption keys' },
      requestedActions: ['Rotate the production key'],
    });
    const journal = new InMemoryJournal();

    await expect(
      runWorkflow(workflow, { runId: 'high-risk-resume', journal, resolver }),
    ).rejects.toMatchObject({
      name: 'WorkflowInterventionRequired',
      outcome: {
        status: 'intervention',
        gateId: 'task-risk:high-risk:pre-implementation-approval',
        interventionId: 'intervention-1',
      },
    });
    expect(calls).toEqual(['architect']);

    approved = true;
    const result = await runWorkflow(workflow, {
      runId: 'high-risk-resume',
      journal,
      resolver,
    });

    expect(gateIds).toEqual([
      'task-risk:high-risk:pre-implementation-approval',
      'task-risk:high-risk:pre-implementation-approval',
    ]);
    expect(calls.filter((role) => role === 'architect')).toHaveLength(1);
    expect(calls).toEqual([
      'architect',
      'implementer',
      'security-reviewer',
      'reviewer',
      'repository-tester',
    ]);
    expect(result).toMatchObject({
      status: 'success',
      approvalStatus: 'approved',
      reviewPassed: true,
    });
  });

  it('fails closed and bounds repeated security review fixes', async () => {
    const calls: string[] = [];
    const workflow = createHighRiskWorkflow({
      approvalGate: { request: () => Promise.resolve({ status: 'approved' }) },
      maxFixCycles: 1,
    });
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'security-reviewer') return { passed: false, findings: 'unsafe input' };
      if (role === 'repository-tester') return { passed: true };
      return `${role}-result`;
    };

    const result = await runWorkflow(workflow, {
      runId: 'high-risk-bounded',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(calls.filter((role) => role === 'security-reviewer')).toHaveLength(2);
    expect(calls.filter((role) => role === 'fixer')).toHaveLength(1);
    expect(calls).not.toContain('reviewer');
    expect(result).toMatchObject({ status: 'failure', reviewPassed: false });
    expect(() =>
      createHighRiskWorkflow({
        approvalGate: { request: () => Promise.resolve({ status: 'approved' }) },
        maxFixCycles: 11,
      }),
    ).toThrow('between 0 and 10');
  });

  it('runs blocking verification after high-risk approval and independent reviews', async () => {
    const calls: string[] = [];
    const workflow = createHighRiskWorkflow({
      approvalGate: { request: () => Promise.resolve({ status: 'approved' }) },
      verificationProfileId: 'command-e2e',
      maxVerificationFixCycles: 0,
    });
    const resolver: RoleResolver = (role) => async () => {
      calls.push(role);
      if (role === 'security-reviewer' || role === 'reviewer' || role === 'repository-tester') {
        return { passed: true };
      }
      if (role === 'verifier') {
        return { passed: true, summary: 'command E2E passed', evidenceRefs: ['artifact://e2e'] };
      }
      return `${role}-result`;
    };
    const result = await runWorkflow(workflow, {
      runId: 'high-risk-verification',
      journal: new InMemoryJournal(),
      resolver,
    });
    expect(calls).toContain('verifier');
    expect(result).toMatchObject({
      status: 'success',
      verificationPassed: true,
      evidenceRefs: ['artifact://e2e'],
    });
  });

  it('exposes the typed intervention error for host integration', () => {
    expect(WorkflowInterventionRequired.prototype).toBeInstanceOf(Error);
  });
});

describe('workflow selection', () => {
  const workflows = [
    { id: 'default', default: true },
    {
      id: 'design',
      priority: 10,
      taskSelector: { labelsAny: ['frontend', 'design'] },
    },
    {
      id: 'high-risk',
      priority: 100,
      taskSelector: {
        descriptionIncludes: ['production secret'],
        statuses: ['ready'] as const,
      },
    },
  ] as const;

  it('uses predicates, priority, and declaration order deterministically', () => {
    expect(
      selectWorkflowForTask(workflows, {
        id: 'task-1',
        title: 'Frontend settings',
        description: 'Rotate a production secret safely',
        status: 'ready',
        labels: ['FRONTEND'],
      })?.id,
    ).toBe('high-risk');

    expect(
      selectWorkflowForTask(workflows, {
        id: 'task-2',
        title: 'UI polish',
        labels: ['design'],
      })?.id,
    ).toBe('design');
  });

  it('falls back to the explicit default for an unmatched normalized task', () => {
    expect(
      selectWorkflowForTask(workflows, { id: 'task-3', title: 'Update dependencies' })?.id,
    ).toBe('default');
  });
});

describe('harness/model independence', () => {
  it.each([
    {
      name: 'Codex',
      routes: {
        implementer: ['acpx:codex', 'gpt-5.6-codex'],
        reviewer: ['acpx:codex', 'gpt-5.6-codex'],
        fixer: ['acpx:codex', 'gpt-5.6-codex'],
        'repository-tester': ['acpx:codex', 'gpt-5.6-codex'],
      },
    },
    {
      name: 'OpenCode',
      routes: {
        implementer: ['acpx:opencode', 'openai/gpt-5.4'],
        reviewer: ['acpx:opencode', 'anthropic/claude-sonnet-4-5'],
        fixer: ['acpx:opencode', 'openai/gpt-5.4'],
        'repository-tester': ['acpx:opencode', 'openai/gpt-5.4'],
      },
    },
    {
      name: 'mixed DSH promotion',
      routes: {
        implementer: ['acpx:codex', 'gpt-5.6-codex-mini'],
        reviewer: ['acpx:opencode', 'anthropic/claude-sonnet-4-5'],
        fixer: ['native:deepseek-harness', 'profile-owned'],
        'repository-tester': ['acpx:codex', 'gpt-5.6-codex'],
      },
    },
  ])('runs the same semantic workflow with $name routing', async ({ routes }) => {
    const calls: Array<{ role: string; harness: string; model: string }> = [];
    let reviews = 0;
    const resolver: RoleResolver = (role) => async () => {
      const route = routes[role as keyof typeof routes];
      calls.push({ role, harness: route[0]!, model: route[1]! });
      if (role === 'implementer') return 'implementation';
      if (role === 'reviewer') {
        reviews++;
        return reviews === 1
          ? { passed: false, findings: 'fix once' }
          : { passed: true, findings: null };
      }
      if (role === 'repository-tester') return { passed: true };
      return 'fixed';
    };

    const result = await runWorkflow(defaultWorkflow, {
      runId: `matrix-${routes.implementer[0]}`,
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result).toMatchObject({ reviewPassed: true, repositoryTestsPassed: true });
    expect(calls.map((call) => call.role)).toEqual([
      'implementer',
      'reviewer',
      'fixer',
      'reviewer',
      'repository-tester',
    ]);
  });
});
