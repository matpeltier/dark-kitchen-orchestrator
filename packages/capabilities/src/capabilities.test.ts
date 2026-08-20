import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityService,
  FIRST_PARTY_CAPABILITY_CATALOG,
  runCommandVerification,
  runHttpVerification,
  type ApprovalGateway,
  type CapabilityInspection,
  type ManagedCapabilityProvider,
} from './index.js';

class FakeApprovalGateway implements ApprovalGateway {
  public approved = false;
  public async requestApproval(input: { readonly planId: string }): Promise<string> {
    return `approval:${input.planId}`;
  }
  public async isApproved(approvalId: string, planId: string): Promise<boolean> {
    return this.approved && approvalId === `approval:${planId}`;
  }
}

class FakeManagedProvider implements ManagedCapabilityProvider {
  public readonly descriptor = {
    ...FIRST_PARTY_CAPABILITY_CATALOG[0]!,
    ownership: 'managed' as const,
    provenance: { source: 'fake:test', version: '1.62.1' },
  };
  public installs = 0;
  private available = false;
  public plan(toolRoot: string) {
    return [{ kind: 'filesystem' as const, target: toolRoot, description: 'test change' }];
  }
  public async inspect(): Promise<CapabilityInspection> {
    const result: CapabilityInspection = {
      capabilityId: this.descriptor.capabilityId,
      providerId: this.descriptor.providerId,
      nodeId: 'local',
      state: this.available ? 'available' : 'provisionable',
      message: this.available ? 'healthy' : 'can install',
      checkedAt: new Date().toISOString(),
    };
    return this.available ? { ...result, version: '1.62.1' } : result;
  }
  public async install(): Promise<void> {
    this.installs += 1;
    this.available = true;
  }
  public async remove(): Promise<void> {
    this.available = false;
  }
}

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('CapabilityService', () => {
  it('persists an auditable plan, requires the matching approval, and ensures idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dk-capability-'));
    const approval = new FakeApprovalGateway();
    const provider = new FakeManagedProvider();
    const service = new CapabilityService({
      toolRoot: join(root, 'tools'),
      statePath: join(root, 'state.json'),
      approvalGateway: approval,
      managedProviders: [provider],
    });

    const plan = await service.planProvisioning({ capabilityId: 'browser.playwright' });
    await expect(
      service.ensureManaged({ planId: plan.id, approvalId: plan.approvalId }),
    ).rejects.toThrow(/not resolved/);
    approval.approved = true;
    expect(
      (await service.ensureManaged({ planId: plan.id, approvalId: plan.approvalId })).state,
    ).toBe('available');
    await service.ensureManaged({ planId: plan.id, approvalId: plan.approvalId });
    expect(provider.installs).toBe(1);

    const reopened = new CapabilityService({
      toolRoot: join(root, 'tools'),
      statePath: join(root, 'state.json'),
      approvalGateway: approval,
      managedProviders: [provider],
    });
    expect((await reopened.validate({ capabilityId: 'playwright' })).state).toBe('available');
  });

  it('reports built-in, project-provided, unsupported-node and unknown states honestly', async () => {
    const service = new CapabilityService({
      approvalGateway: new FakeApprovalGateway(),
      managedProviders: [],
      projectCapabilities: { 'command.exec': { available: true, version: 'project' } },
    });
    expect((await service.inspect({ capabilityId: 'api.http' })).state).toBe('available');
    expect((await service.inspect({ capabilityId: 'command.exec' })).state).toBe('available');
    expect((await service.inspect({ capabilityId: 'api.http', nodeId: 'remote-1' })).state).toBe(
      'unsupported',
    );
    await expect(service.inspect({ capabilityId: 'made.up' })).rejects.toThrow(/Unknown/);
  });
});

describe('first-party verification runners', () => {
  it('performs a real local HTTP round-trip with structured evidence', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"ready":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const result = await runHttpVerification({
      url: `http://127.0.0.1:${address.port}/health`,
      expectedStatus: 201,
      bodyIncludes: '"ready":true',
    });
    expect(result).toMatchObject({ passed: true, status: 201 });
  });

  it('runs an explicit command without interpreting shell-looking stdin', async () => {
    const payload = '$(touch should-not-exist); `whoami`; snow=雪';
    const result = await runCommandVerification({
      executable: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      stdin: payload,
    });
    expect(result).toMatchObject({ passed: true, stdout: payload });
  });
});
