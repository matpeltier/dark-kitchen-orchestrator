import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryJournal } from '@dark-kitchen/workflow-engine';
import { defaultWorkflow, workflowWithVerification } from './index.js';
import type { RoleResolver } from '@dark-kitchen/workflow-engine';

function makeResolver(responses: Record<string, unknown>): RoleResolver {
  return (role) => async () => responses[role] ?? `${role}-result`;
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
    expect(result.implementationSummary).toBeTruthy();
  });

  it('applies fixes when review fails', async () => {
    const fixerCalled: boolean[] = [];
    const resolver: RoleResolver = (role) => async () => {
      if (role === 'implementer') return 'impl';
      if (role === 'reviewer') return { passed: false, findings: 'Fix X' };
      if (role === 'fixer') {
        fixerCalled.push(true);
        return 'fixed';
      }
      return 'ok';
    };

    await runWorkflow(defaultWorkflow, {
      runId: 'fix-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(fixerCalled).toHaveLength(1);
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
      verifier: { passed: true, summary: 'All checks passed' },
    });

    const result = await runWorkflow(workflowWithVerification, {
      runId: 'verify-run',
      journal: new InMemoryJournal(),
      resolver,
    });

    expect(result.verificationPassed).toBe(true);
    expect(result.verificationSummary).toBe('All checks passed');
  });
});
