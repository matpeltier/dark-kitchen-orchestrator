import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableVerificationService, parseVerificationRequirements } from './index.js';

const taskBody = `# Feature

## Verification
Profile: web-e2e
Evidence: screenshot, trace

### Scenario: User signs in
Open the login page and submit valid credentials.
Expect: The dashboard is visible.
`;

const profiles = [
  {
    id: 'web-e2e',
    verifierRoleId: 'verifier',
    blocking: true,
    retryPolicy: { maxAttempts: 2, delaySeconds: 0 },
  },
] as const;

describe('portable verification requirements', () => {
  it('parses profiles, observable scenarios, and requested evidence', () => {
    expect(parseVerificationRequirements(taskBody)).toEqual([
      {
        profileId: 'web-e2e',
        requestedEvidence: ['screenshot', 'trace'],
        scenarios: [
          {
            name: 'User signs in',
            description:
              'Open the login page and submit valid credentials.\nExpect: The dashboard is visible.',
            expectedOutcome: 'The dashboard is visible.',
          },
        ],
      },
    ]);
  });

  it('keeps tasks without a Verification section lightweight', () => {
    expect(parseVerificationRequirements('# Small refactor')).toEqual([]);
  });
});

describe('DurableVerificationService', () => {
  it('persists evidence, resumes passed work, gates merges, and bounds retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dk-verification-'));
    const statePath = join(root, 'verification.json');
    const options = {
      statePath,
      profiles,
      getTaskDescription: async () => taskBody,
    };
    const service = new DurableVerificationService(options);
    const run = await service.request({ taskId: 'task-1', profileId: 'web-e2e' });
    await service.markRunning(run.id);
    const failed = await service.complete(run.id, {
      state: 'failed',
      criterionResults: [{ criterionName: 'User signs in', status: 'fail' }],
    });
    const retry = await service.retry(failed.id);
    await service.complete(retry.id, {
      state: 'passed',
      criterionResults: [
        {
          criterionName: 'User signs in',
          status: 'pass',
          evidence: [
            {
              id: 'evidence-1',
              kind: 'screenshot',
              name: 'dashboard',
              artifactRef: 'artifacts/task-1/dashboard.png',
              capturedAt: new Date().toISOString(),
            },
          ],
        },
      ],
    });

    const reopened = new DurableVerificationService(options);
    expect((await reopened.request({ taskId: 'task-1', profileId: 'web-e2e' })).id).toBe(retry.id);
    expect(await reopened.gate('task-1')).toMatchObject({
      passed: true,
      blockingProfiles: ['web-e2e'],
      failedProfiles: [],
      evidenceRefs: ['artifacts/task-1/dashboard.png'],
    });
    await expect(reopened.retry(retry.id)).rejects.toThrow(/cannot be retried/);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('reports a failed blocking gate and cancels idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dk-verification-'));
    const service = new DurableVerificationService({
      statePath: join(root, 'verification.json'),
      profiles,
      getTaskDescription: async () => taskBody,
    });
    const run = await service.request({ taskId: 'task-2' });
    expect((await service.cancel(run.id)).state).toBe('cancelled');
    expect((await service.cancel(run.id)).state).toBe('cancelled');
    expect(await service.gate('task-2')).toMatchObject({
      passed: false,
      failedProfiles: ['web-e2e'],
    });
  });
});
