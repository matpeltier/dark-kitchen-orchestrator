import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  controlArgument,
  defineProcess,
  executeProcess,
  stdinPayload,
} from '@dark-kitchen/process-execution';

export type CapabilityOwnership = 'managed' | 'project-provided' | 'user-managed';
export type CapabilityState =
  | 'available'
  | 'provisionable'
  | 'missing'
  | 'unhealthy'
  | 'requires_auth'
  | 'unsupported';

export interface CapabilityCatalogEntry {
  readonly capabilityId: string;
  readonly providerId: string;
  readonly ownership: CapabilityOwnership;
  readonly versionConstraint?: string;
  readonly supportedPlatforms: readonly NodeJS.Platform[];
  readonly provenance: { readonly source: string; readonly version?: string };
  readonly healthProbe: string;
}

export interface CapabilityInspection {
  readonly capabilityId: string;
  readonly providerId: string;
  readonly nodeId: string;
  readonly state: CapabilityState;
  readonly version?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export interface ProvisioningChange {
  readonly kind: 'filesystem' | 'network' | 'process';
  readonly target: string;
  readonly description: string;
}

export interface ProvisioningPlan {
  readonly id: string;
  readonly capabilityId: string;
  readonly providerId: string;
  readonly nodeId: string;
  readonly version: string;
  readonly changes: readonly ProvisioningChange[];
  readonly requiresApproval: true;
  readonly approvalId: string;
  readonly status: 'pending-approval' | 'approved' | 'completed';
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface ApprovalGateway {
  requestApproval(input: {
    readonly planId: string;
    readonly capabilityId: string;
    readonly summary: string;
    readonly details: string;
  }): Promise<string>;
  isApproved(approvalId: string, planId: string): Promise<boolean>;
}

export interface ManagedCapabilityProvider {
  readonly descriptor: CapabilityCatalogEntry & {
    readonly ownership: 'managed';
    readonly provenance: { readonly source: string; readonly version: string };
  };
  plan(toolRoot: string): readonly ProvisioningChange[];
  inspect(toolRoot: string): Promise<CapabilityInspection>;
  install(toolRoot: string): Promise<void>;
  remove(toolRoot: string): Promise<void>;
}

interface CapabilityStateFile {
  readonly plans: readonly ProvisioningPlan[];
}

export interface CapabilityServiceOptions {
  readonly toolRoot?: string;
  readonly statePath?: string;
  readonly approvalGateway: ApprovalGateway;
  readonly managedProviders?: readonly ManagedCapabilityProvider[];
  readonly projectCapabilities?: Readonly<
    Record<string, { readonly available: boolean; readonly version?: string }>
  >;
}

export const FIRST_PARTY_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    capabilityId: 'browser.playwright',
    providerId: 'playwright',
    ownership: 'managed',
    versionConstraint: '1.62.1',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    provenance: { source: 'npm:playwright', version: '1.62.1' },
    healthProbe: 'Launch and close a real Chromium browser process.',
  },
  {
    capabilityId: 'mobile.maestro',
    providerId: 'maestro',
    ownership: 'managed',
    versionConstraint: '2.8.0',
    supportedPlatforms: ['darwin', 'linux'],
    provenance: {
      source: 'https://github.com/mobile-dev-inc/Maestro/releases/tag/cli-2.8.0',
      version: '2.8.0',
    },
    healthProbe: 'Run maestro --version and detect a compatible booted device.',
  },
  {
    capabilityId: 'api.http',
    providerId: 'api-http',
    ownership: 'managed',
    versionConstraint: 'builtin',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    provenance: { source: 'dark-kitchen:builtin', version: '1' },
    healthProbe: 'Execute an isolated local HTTP request and structured assertions.',
  },
  {
    capabilityId: 'command.exec',
    providerId: 'command-exec',
    ownership: 'project-provided',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    provenance: { source: 'project-config' },
    healthProbe: 'Resolve an explicitly configured executable without shell evaluation.',
  },
];

export class CapabilityService {
  private readonly toolRoot: string;
  private readonly statePath: string;
  private readonly approvalGateway: ApprovalGateway;
  private readonly providers: Map<string, ManagedCapabilityProvider>;
  private readonly projectCapabilities: CapabilityServiceOptions['projectCapabilities'];
  private loaded = false;
  private plans = new Map<string, ProvisioningPlan>();

  public constructor(options: CapabilityServiceOptions) {
    this.toolRoot = options.toolRoot ?? join(homedir(), '.dark-kitchen', 'tools');
    this.statePath =
      options.statePath ?? join(homedir(), '.dark-kitchen', 'state', 'capabilities.json');
    this.approvalGateway = options.approvalGateway;
    const providers = options.managedProviders ?? [new PlaywrightProvider(), new MaestroProvider()];
    this.providers = new Map(
      providers.map((provider) => [provider.descriptor.providerId, provider]),
    );
    this.projectCapabilities = options.projectCapabilities;
  }

  public async listCatalog(): Promise<readonly CapabilityCatalogEntry[]> {
    return FIRST_PARTY_CAPABILITY_CATALOG;
  }

  public async inspect(input: {
    readonly capabilityId: string;
    readonly nodeId?: string;
  }): Promise<CapabilityInspection> {
    const descriptor = requireDescriptor(input.capabilityId);
    const nodeId = input.nodeId ?? 'local';
    if (nodeId !== 'local') {
      return inspection(
        descriptor,
        nodeId,
        'unsupported',
        'Remote provisioning is not configured.',
      );
    }
    if (!descriptor.supportedPlatforms.includes(process.platform)) {
      return inspection(
        descriptor,
        nodeId,
        'unsupported',
        `${descriptor.capabilityId} is unsupported on ${process.platform}.`,
      );
    }
    if (descriptor.capabilityId === 'api.http') {
      return inspection(
        descriptor,
        nodeId,
        'available',
        'Built-in HTTP verifier is available.',
        'builtin',
      );
    }
    if (descriptor.ownership === 'project-provided') {
      const configured = this.projectCapabilities?.[descriptor.capabilityId];
      return inspection(
        descriptor,
        nodeId,
        configured?.available ? 'available' : 'missing',
        configured?.available
          ? 'Project-provided capability is configured.'
          : 'Configure an explicit project command before using command.exec.',
        configured?.version,
      );
    }
    const provider = this.providers.get(descriptor.providerId);
    if (!provider) {
      return inspection(
        descriptor,
        nodeId,
        'missing',
        'No trusted managed provider is registered.',
      );
    }
    return provider.inspect(this.toolRoot);
  }

  public async planProvisioning(input: {
    readonly capabilityId: string;
    readonly nodeId?: string;
  }): Promise<ProvisioningPlan> {
    await this.load();
    const descriptor = requireDescriptor(input.capabilityId);
    const nodeId = input.nodeId ?? 'local';
    if (nodeId !== 'local') throw new Error('Remote capability provisioning is unsupported.');
    if (descriptor.ownership !== 'managed' || descriptor.capabilityId === 'api.http') {
      throw new Error(`${descriptor.capabilityId} is not an installable managed capability.`);
    }
    if (!descriptor.supportedPlatforms.includes(process.platform)) {
      throw new Error(`${descriptor.capabilityId} is unsupported on ${process.platform}.`);
    }
    const provider = this.providers.get(descriptor.providerId);
    if (!provider) throw new Error(`No trusted provider registered for ${descriptor.providerId}.`);
    const planId = `cap-plan-${randomUUID()}`;
    const changes = provider.plan(this.toolRoot);
    const approvalId = await this.approvalGateway.requestApproval({
      planId,
      capabilityId: descriptor.capabilityId,
      summary: `Approve provisioning ${descriptor.capabilityId}`,
      details: changes
        .map((change) => `${change.kind}: ${change.description} (${change.target})`)
        .join('\n'),
    });
    const plan: ProvisioningPlan = {
      id: planId,
      capabilityId: descriptor.capabilityId,
      providerId: descriptor.providerId,
      nodeId,
      version: provider.descriptor.provenance.version,
      changes,
      requiresApproval: true,
      approvalId,
      status: 'pending-approval',
      createdAt: new Date().toISOString(),
    };
    this.plans.set(plan.id, plan);
    await this.save();
    return plan;
  }

  public async ensureManaged(input: {
    readonly planId: string;
    readonly approvalId: string;
  }): Promise<CapabilityInspection> {
    await this.load();
    const plan = this.plans.get(input.planId);
    if (!plan) throw new Error(`Provisioning plan ${input.planId} not found.`);
    if (plan.approvalId !== input.approvalId)
      throw new Error('Approval does not belong to this plan.');
    if (!(await this.approvalGateway.isApproved(input.approvalId, input.planId))) {
      throw new Error('Provisioning approval is not resolved with an approve action.');
    }
    const provider = this.providers.get(plan.providerId);
    if (!provider) throw new Error(`Managed provider ${plan.providerId} is unavailable.`);
    const current = await provider.inspect(this.toolRoot);
    if (current.state !== 'available') await provider.install(this.toolRoot);
    const validated = await provider.inspect(this.toolRoot);
    if (validated.state !== 'available') {
      throw new Error(`Provisioned capability is not healthy: ${validated.message}`);
    }
    this.plans.set(plan.id, {
      ...plan,
      status: 'completed',
      completedAt: plan.completedAt ?? new Date().toISOString(),
    });
    await this.save();
    return validated;
  }

  public async validate(input: {
    readonly capabilityId: string;
    readonly nodeId?: string;
  }): Promise<CapabilityInspection> {
    return this.inspect(input);
  }

  public async removeManaged(capabilityId: string): Promise<CapabilityInspection> {
    const descriptor = requireDescriptor(capabilityId);
    const provider = this.providers.get(descriptor.providerId);
    if (!provider) throw new Error(`${descriptor.capabilityId} is not managed by Dark Kitchen.`);
    await provider.remove(this.toolRoot);
    return provider.inspect(this.toolRoot);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.statePath, 'utf8')) as CapabilityStateFile;
      this.plans = new Map(data.plans.map((plan) => [plan.id, plan]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ plans: [...this.plans.values()] }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, this.statePath);
  }
}

class PlaywrightProvider implements ManagedCapabilityProvider {
  public readonly descriptor =
    FIRST_PARTY_CAPABILITY_CATALOG[0] as ManagedCapabilityProvider['descriptor'];

  public plan(toolRoot: string): readonly ProvisioningChange[] {
    const root = this.root(toolRoot);
    return [
      { kind: 'filesystem', target: root, description: 'Create isolated Playwright tool storage.' },
      {
        kind: 'network',
        target: 'registry.npmjs.org',
        description: 'Download pinned playwright@1.62.1.',
      },
      {
        kind: 'network',
        target: 'playwright.azureedge.net',
        description: 'Download pinned Chromium assets.',
      },
      {
        kind: 'process',
        target: 'npm/node',
        description: 'Install package and Chromium without modifying the project.',
      },
    ];
  }

  public async inspect(toolRoot: string): Promise<CapabilityInspection> {
    const descriptor = this.descriptor;
    const modulePath = join(this.root(toolRoot), 'node_modules', 'playwright');
    try {
      await access(modulePath);
    } catch {
      return inspection(
        descriptor,
        'local',
        'provisionable',
        'Pinned Playwright can be installed into Dark Kitchen tool storage.',
      );
    }
    const script =
      "const {createRequire}=require('node:module');const r=createRequire(process.env.DK_PW_ENTRY);const {chromium}=r('playwright');chromium.launch({headless:true}).then(async b=>{await b.close();process.stdout.write('ok')})";
    const result = await runProcess(process.execPath, ['-e', script], this.root(toolRoot), {
      DK_PW_ENTRY: join(this.root(toolRoot), 'probe.cjs'),
      PLAYWRIGHT_BROWSERS_PATH: join(this.root(toolRoot), 'browsers'),
    }).catch((error: unknown) => ({ exitCode: 1, stderr: String(error), stdout: '' }));
    return result.exitCode === 0
      ? inspection(descriptor, 'local', 'available', 'Chromium launch probe passed.', '1.62.1')
      : inspection(
          descriptor,
          'local',
          'unhealthy',
          `Chromium launch probe failed: ${bounded(result.stderr)}`,
          '1.62.1',
        );
  }

  public async install(toolRoot: string): Promise<void> {
    const root = this.root(toolRoot);
    await mkdir(root, { recursive: true });
    await requireSuccess(
      await runProcess(
        'npm',
        ['install', '--prefix', root, '--no-save', '--ignore-scripts', 'playwright@1.62.1'],
        root,
      ),
    );
    await requireSuccess(
      await runProcess(
        process.execPath,
        [join(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
        root,
        { PLAYWRIGHT_BROWSERS_PATH: join(root, 'browsers') },
      ),
    );
  }

  public async remove(toolRoot: string): Promise<void> {
    await rm(this.root(toolRoot), { recursive: true, force: true });
  }

  private root(toolRoot: string): string {
    return join(toolRoot, 'playwright', '1.62.1');
  }
}

class MaestroProvider implements ManagedCapabilityProvider {
  public readonly descriptor =
    FIRST_PARTY_CAPABILITY_CATALOG[1] as ManagedCapabilityProvider['descriptor'];

  public plan(toolRoot: string): readonly ProvisioningChange[] {
    return [
      {
        kind: 'filesystem',
        target: this.root(toolRoot),
        description: 'Create isolated Maestro tool storage.',
      },
      {
        kind: 'network',
        target: 'github.com/mobile-dev-inc/Maestro',
        description: 'Download maestro.zip and published SHA-256 checksums for cli-2.8.0.',
      },
      {
        kind: 'process',
        target: 'unzip',
        description: 'Extract the verified archive without configuring devices.',
      },
    ];
  }

  public async inspect(toolRoot: string): Promise<CapabilityInspection> {
    const executable = join(this.root(toolRoot), 'maestro', 'bin', 'maestro');
    try {
      await access(executable);
    } catch {
      return inspection(
        this.descriptor,
        'local',
        'provisionable',
        'Pinned Maestro can be installed into Dark Kitchen tool storage.',
      );
    }
    const version = await runProcess(executable, ['--version'], this.root(toolRoot)).catch(
      (error: unknown) => ({ exitCode: 1, stderr: String(error), stdout: '' }),
    );
    if (version.exitCode !== 0) {
      return inspection(
        this.descriptor,
        'local',
        'unhealthy',
        `Maestro failed: ${bounded(version.stderr)}`,
        '2.8.0',
      );
    }
    const deviceAvailable = await hasCompatibleMobileDevice();
    return deviceAvailable
      ? inspection(
          this.descriptor,
          'local',
          'available',
          'Maestro and a compatible booted device are available.',
          '2.8.0',
        )
      : inspection(
          this.descriptor,
          'local',
          'missing',
          'Maestro is installed, but no compatible Android/iOS device is booted.',
          '2.8.0',
        );
  }

  public async install(toolRoot: string): Promise<void> {
    const root = this.root(toolRoot);
    await mkdir(root, { recursive: true });
    const release = 'https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.8.0';
    const [archiveResponse, checksumsResponse] = await Promise.all([
      fetch(`${release}/maestro.zip`),
      fetch(`${release}/checksums_sha256.txt`),
    ]);
    if (!archiveResponse.ok || !checksumsResponse.ok)
      throw new Error('Unable to download the pinned Maestro release.');
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const checksums = await checksumsResponse.text();
    const expected = checksums
      .split('\n')
      .find((line) => line.includes('maestro.zip'))
      ?.trim()
      .split(/\s+/)[0];
    const actual = createHash('sha256').update(archive).digest('hex');
    if (!expected || actual !== expected) throw new Error('Maestro archive checksum mismatch.');
    const archivePath = join(root, 'maestro.zip');
    await writeFile(archivePath, archive, { flag: 'w' });
    await requireSuccess(await runProcess('unzip', ['-oq', archivePath, '-d', root], root));
    await rm(archivePath, { force: true });
  }

  public async remove(toolRoot: string): Promise<void> {
    await rm(this.root(toolRoot), { recursive: true, force: true });
  }

  private root(toolRoot: string): string {
    return join(toolRoot, 'maestro', '2.8.0');
  }
}

export interface HttpVerificationInput {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectedStatus?: number;
  readonly bodyIncludes?: string;
}

export async function runHttpVerification(input: HttpVerificationInput): Promise<{
  readonly passed: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}> {
  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
  const body = bounded(await response.text(), 256 * 1024);
  const statusPassed =
    input.expectedStatus === undefined || response.status === input.expectedStatus;
  const bodyPassed = input.bodyIncludes === undefined || body.includes(input.bodyIncludes);
  return {
    passed: statusPassed && bodyPassed,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

export async function runCommandVerification(input: {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}): Promise<{
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const controller = new AbortController();
  const timer = input.timeoutMs
    ? setTimeout(
        () => controller.abort(new Error('command verification timed out')),
        input.timeoutMs,
      )
    : undefined;
  try {
    const result = await executeProcess({
      definition: defineProcess({
        executable: input.executable,
        args: (input.args ?? []).map(controlArgument),
        label: 'command-verification',
      }),
      cwd: input.cwd,
      ...(input.stdin !== undefined ? { payload: stdinPayload(input.stdin) } : {}),
      signal: controller.signal,
    });
    return {
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: bounded(Buffer.from(result.stdout).toString('utf8')),
      stderr: bounded(Buffer.from(result.stderr).toString('utf8')),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireDescriptor(id: string): CapabilityCatalogEntry {
  const descriptor = FIRST_PARTY_CAPABILITY_CATALOG.find(
    (entry) => entry.capabilityId === id || entry.providerId === id,
  );
  if (!descriptor) throw new Error(`Unknown capability or provider ${id}.`);
  return descriptor;
}

function inspection(
  descriptor: CapabilityCatalogEntry,
  nodeId: string,
  state: CapabilityState,
  message: string,
  version?: string,
): CapabilityInspection {
  return {
    capabilityId: descriptor.capabilityId,
    providerId: descriptor.providerId,
    nodeId,
    state,
    message,
    checkedAt: new Date().toISOString(),
    ...(version ? { version } : {}),
  };
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const result = await executeProcess({
    definition: defineProcess({
      executable,
      args: args.map(controlArgument),
      label: 'capability-provider',
    }),
    cwd,
    ...(environment ? { environment } : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

async function requireSuccess(result: {
  readonly exitCode: number | null;
  readonly stderr: string;
}): Promise<void> {
  if (result.exitCode !== 0)
    throw new Error(`Capability provider process failed: ${bounded(result.stderr)}`);
}

async function hasCompatibleMobileDevice(): Promise<boolean> {
  const adb = await runProcess('adb', ['devices'], process.cwd()).catch(() => undefined);
  if (adb?.exitCode === 0 && adb.stdout.split('\n').some((line) => /\tdevice$/.test(line)))
    return true;
  if (process.platform !== 'darwin') return false;
  const simctl = await runProcess(
    'xcrun',
    ['simctl', 'list', 'devices', 'booted', '-j'],
    process.cwd(),
  ).catch(() => undefined);
  if (simctl?.exitCode !== 0 || !simctl) return false;
  try {
    const parsed = JSON.parse(simctl.stdout) as { devices?: Record<string, readonly unknown[]> };
    return Object.values(parsed.devices ?? {}).some((devices) => devices.length > 0);
  } catch {
    return false;
  }
}

function bounded(value: string, maxBytes = 16 * 1024): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n…[truncated]`;
}
