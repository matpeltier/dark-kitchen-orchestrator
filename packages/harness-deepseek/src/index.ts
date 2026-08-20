/**
 * Optional DeepSeek Harness (DSH) native adapter.
 *
 * The official package is `@deepseek-ai/dsh`; its executable is `dsh`.
 * DSH's developer-preview headless profile currently accepts its job through
 * argv, which is incompatible with Dark Kitchen's payload transport invariant.
 * The default boundary therefore supplies a temporary, Dark-Kitchen-owned
 * patch that reads the job from a referenced payload file. User DSH profiles,
 * plugins, credentials, and `$DSH_HOME` configuration are never rewritten.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionId } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import type {
  HarnessCapability,
  HarnessEventHandler,
  HarnessPlugin,
  HarnessRuntime,
  HarnessSession,
  StartSessionInput,
} from '@dark-kitchen/harness';
import {
  makeCapabilitySet,
  registerHarnessPlugin,
  requireCapability,
  UnsupportedCapabilityError,
} from '@dark-kitchen/harness';
import {
  controlArgument,
  createPayloadArtifact,
  defineProcess,
  executeProcess,
  filePayload,
} from '@dark-kitchen/process-execution';

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';
export const DSH_SUPPORTED_VERSIONS = ['0.1.0-rc.7', '0.1.0-rc.8'] as const;

const DSH_RUNTIME_CAPABILITIES = [
  'sessions.cancel',
] as const satisfies readonly HarnessCapability[];

/**
 * This overlay replaces only the headless startup input edge. It neither
 * installs plugins nor writes to the selected DSH profile. The referenced
 * payload file is created and removed by Dark Kitchen for one invocation.
 */
const SAFE_PAYLOAD_PATCH = `# Dark Kitchen transient payload transport overlay
- id: headless-startup
  disabled: true
- id: headless-runner
  inject: []
  config:
    task: !!js process.getBuiltinModule('node:fs').readFileSync(process.env.DARK_KITCHEN_PAYLOAD_FILE, 'utf8')
`;

export interface DshAdapterConfig {
  readonly id: string;
  /** Official `dsh` executable or an absolute path to it. */
  readonly executable?: string;
  /** Trusted executable-prefix arguments, useful for wrapper installations. */
  readonly args?: readonly string[];
  /** Existing DSH profile. Defaults to the official `headless` profile. */
  readonly profile?: string;
  /** Existing DSH home. Omitted to preserve normal DSH_HOME/HOME discovery. */
  readonly dshHome?: string;
  /** Explicit compatibility allowlist; defaults to the pinned developer previews. */
  readonly supportedVersions?: readonly string[];
  /** Test/custom-host boundary. Runtime payload stays a typed data field. */
  readonly boundary?: DshExecutionBoundary;
  /**
   * Optional capability declaration retained for plugin compatibility. Values
   * outside the capabilities actually implemented by this adapter are rejected.
   */
  readonly capabilities?: readonly HarnessCapability[];
}

export interface DshBoundaryRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly profile: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly dshHome?: string;
  readonly signal: AbortSignal;
}

export interface DshBoundaryResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable process/programmatic boundary used by compatibility tests. */
export interface DshExecutionBoundary {
  getVersion(request: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly dshHome?: string;
  }): Promise<string>;
  run(request: DshBoundaryRequest): Promise<DshBoundaryResult>;
}

/** Shell-free official CLI boundary with file-referenced prompt transport. */
export class DshCliBoundary implements DshExecutionBoundary {
  public async getVersion(request: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly dshHome?: string;
  }): Promise<string> {
    const definition = defineProcess({
      executable: request.executable,
      args: [...request.args, '--version'].map(controlArgument),
      label: 'dsh-version-probe',
    });
    const result = await executeProcess({
      definition,
      ...(request.dshHome ? { environment: { DSH_HOME: request.dshHome } } : {}),
    });
    if (result.exitCode !== 0) {
      throw new DshOperationalError(
        decode(result.stderr) || `dsh version probe exited with code ${String(result.exitCode)}`,
        'process',
      );
    }
    return extractVersion(decode(result.stdout) || decode(result.stderr));
  }

  public async run(request: DshBoundaryRequest): Promise<DshBoundaryResult> {
    const overlayDirectory = await mkdtemp(join(tmpdir(), 'dark-kitchen-dsh-overlay-'));
    const overlayPath = join(overlayDirectory, 'safe-payload.patch.yml');
    const payload = await createPayloadArtifact(request.prompt);

    try {
      await writeFile(overlayPath, SAFE_PAYLOAD_PATCH, { encoding: 'utf8', flag: 'wx' });
      const definition = defineProcess({
        executable: request.executable,
        args: [...request.args, '--profile', request.profile, '--patch', overlayPath].map(
          controlArgument,
        ),
        label: 'dsh-headless',
      });
      const result = await executeProcess({
        definition,
        cwd: request.cwd,
        payload: filePayload(payload.path),
        signal: request.signal,
        ...(request.dshHome ? { environment: { DSH_HOME: request.dshHome } } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: decode(result.stdout),
        stderr: decode(result.stderr),
      };
    } finally {
      await payload.dispose();
      await rm(overlayDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * DSH headless is currently one-shot. It supports cancelling the active child
 * process, but not resume, live follow-ups, per-run model selection, or
 * profile/plugin mutation through this adapter.
 */
export class DshHarnessAdapter implements HarnessRuntime {
  public readonly id: string;
  public readonly kind = 'deepseek-harness';
  public readonly capabilities: ReturnType<typeof makeCapabilitySet>;

  private readonly config: DshAdapterConfig;
  private readonly boundary: DshExecutionBoundary;
  private readonly sessions = new Map<AgentSessionId, DshSession>();
  private readonly subscribers = new Map<AgentSessionId, Set<HarnessEventHandler>>();
  private readonly lastEvents = new Map<AgentSessionId, Parameters<HarnessEventHandler>[0]>();
  private versionPromise?: Promise<string>;

  public constructor(config: DshAdapterConfig) {
    this.config = config;
    this.id = config.id;
    this.boundary = config.boundary ?? new DshCliBoundary();
    const capabilities = config.capabilities ?? DSH_RUNTIME_CAPABILITIES;
    for (const capability of capabilities) {
      if (!DSH_RUNTIME_CAPABILITIES.includes(capability as 'sessions.cancel')) {
        throw new UnsupportedCapabilityError(capability, config.id);
      }
    }
    this.capabilities = makeCapabilitySet(capabilities);
  }

  public async startSession(input: StartSessionInput): Promise<HarnessSession> {
    this.validateInputCapabilities(input);
    await this.ensureCompatibleVersion();

    const sessionId = createAgentSessionId(
      `dsh-${input.runId}-${input.taskId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const controller = new AbortController();
    const session: DshSession = {
      id: sessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      state: 'running',
      controller,
    };
    this.sessions.set(sessionId, session);
    this.emit(sessionId, { sessionId, state: 'running' });

    void this.runSession(sessionId, input, session);
    return snapshot(session);
  }

  public async sendPrompt(sessionId: AgentSessionId, _prompt: string): Promise<void> {
    this.requireSession(sessionId);
    requireCapability(this.capabilities, 'sessions.live-instructions', this.id);
  }

  public async cancelSession(sessionId: AgentSessionId): Promise<void> {
    requireCapability(this.capabilities, 'sessions.cancel', this.id);
    const session = this.sessions.get(sessionId);
    if (!session || isTerminal(session.state)) return;
    session.controller.abort();
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async resumeSession(sessionId: AgentSessionId): Promise<HarnessSession> {
    this.requireSession(sessionId);
    requireCapability(this.capabilities, 'sessions.resume', this.id);
    throw new UnsupportedCapabilityError('sessions.resume', this.id);
  }

  public async stopSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || isTerminal(session.state)) return;
    session.controller.abort();
    session.state = 'cancelled';
    this.emit(sessionId, { sessionId, state: 'cancelled' });
  }

  public async getSession(sessionId: AgentSessionId): Promise<HarnessSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? snapshot(session) : undefined;
  }

  public subscribe(sessionId: AgentSessionId, handler: HarnessEventHandler): () => void {
    this.requireSession(sessionId);
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(handler);

    const lastEvent = this.lastEvents.get(sessionId);
    if (lastEvent && isTerminal(lastEvent.state)) {
      queueMicrotask(() => {
        if (this.lastEvents.get(sessionId) === lastEvent) handler(lastEvent);
      });
    }
    return () => this.subscribers.get(sessionId)?.delete(handler);
  }

  public async probe(): Promise<
    | { readonly available: true; readonly version: string }
    | { readonly available: false; readonly error: DshOperationalError }
  > {
    try {
      return { available: true, version: await this.ensureCompatibleVersion() };
    } catch (error) {
      return { available: false, error: toDshError(error) };
    }
  }

  private async ensureCompatibleVersion(): Promise<string> {
    this.versionPromise ??= this.boundary
      .getVersion({
        executable: this.config.executable ?? 'dsh',
        args: this.config.args ?? [],
        ...(this.config.dshHome ? { dshHome: this.config.dshHome } : {}),
      })
      .then((rawVersion) => {
        const version = extractVersion(rawVersion);
        const supported = this.config.supportedVersions ?? DSH_SUPPORTED_VERSIONS;
        if (!supported.includes(version)) {
          throw new DshCompatibilityError(
            `Unsupported ${DSH_PACKAGE_NAME} version ${version}; supported: ${supported.join(', ')}`,
            version,
          );
        }
        return version;
      })
      .catch((error: unknown) => {
        throw toDshError(error);
      });
    return this.versionPromise;
  }

  private validateInputCapabilities(input: StartSessionInput): void {
    if (input.model || (input.profile.managed && input.profile.model)) {
      requireCapability(this.capabilities, 'model.selection', this.id);
    }
    if (input.reasoning || (input.profile.managed && input.profile.reasoning)) {
      requireCapability(this.capabilities, 'reasoning.selection', this.id);
    }
    if (
      (input.profile.managed && (input.profile.skills?.length ?? 0) > 0) ||
      (input.resources?.skills?.length ?? 0) > 0
    ) {
      requireCapability(this.capabilities, 'skills.custom', this.id);
    }
    if (
      (input.profile.managed && (input.profile.mcpServers?.length ?? 0) > 0) ||
      (input.resources?.mcpServers?.length ?? 0) > 0
    ) {
      requireCapability(this.capabilities, 'skills.mcp', this.id);
    }
    if (input.profile.managed && (input.profile.plugins?.length ?? 0) > 0) {
      requireCapability(this.capabilities, 'skills.plugins', this.id);
    }
  }

  private async runSession(
    sessionId: AgentSessionId,
    input: StartSessionInput,
    session: DshSession,
  ): Promise<void> {
    try {
      const result = await this.boundary.run({
        executable: this.config.executable ?? 'dsh',
        args: this.config.args ?? [],
        profile: this.config.profile ?? 'headless',
        prompt: input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt,
        cwd: input.workspaceId as string,
        ...(this.config.dshHome ? { dshHome: this.config.dshHome } : {}),
        signal: session.controller.signal,
      });
      if (session.controller.signal.aborted || session.state === 'cancelled') return;
      if (result.exitCode !== 0) {
        throw classifyDshFailure(
          result.stderr || `dsh exited with code ${String(result.exitCode)}`,
        );
      }
      session.state = 'completed';
      this.emit(sessionId, { sessionId, state: 'completed', output: result.stdout.trimEnd() });
    } catch (error) {
      if (session.controller.signal.aborted || session.state === 'cancelled') return;
      session.state = 'failed';
      this.emit(sessionId, { sessionId, state: 'failed', error: toDshError(error) });
    }
  }

  private requireSession(sessionId: AgentSessionId): DshSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`DSH session ${sessionId} not found`);
    return session;
  }

  private emit(sessionId: AgentSessionId, event: Parameters<HarnessEventHandler>[0]): void {
    this.lastEvents.set(sessionId, event);
    for (const handler of this.subscribers.get(sessionId) ?? []) handler(event);
  }
}

interface DshSession extends HarnessSession {
  state: HarnessSession['state'];
  readonly controller: AbortController;
}

export type DshErrorKind = 'compatibility' | 'auth' | 'quota' | 'rate-limit' | 'tool' | 'process';

export class DshOperationalError extends Error {
  public readonly kind: DshErrorKind;
  public constructor(message: string, kind: DshErrorKind) {
    super(message);
    this.name = 'DshOperationalError';
    this.kind = kind;
  }
}

export class DshCompatibilityError extends DshOperationalError {
  public readonly installedVersion: string;
  public constructor(message: string, installedVersion: string) {
    super(message, 'compatibility');
    this.name = 'DshCompatibilityError';
    this.installedVersion = installedVersion;
  }
}

function extractVersion(output: string): string {
  const match = output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  if (!match) {
    throw new DshCompatibilityError(
      `Unable to detect ${DSH_PACKAGE_NAME} version from dsh --version output`,
      'unknown',
    );
  }
  return match[0];
}

function classifyDshFailure(message: string): DshOperationalError {
  const lower = message.toLowerCase();
  if (/auth|unauthorized|api[ -]?key|credential|token/.test(lower)) {
    return new DshOperationalError(message, 'auth');
  }
  if (/quota|credit|billing|insufficient/.test(lower)) {
    return new DshOperationalError(message, 'quota');
  }
  if (/rate.?limit|too many requests|\b429\b/.test(lower)) {
    return new DshOperationalError(message, 'rate-limit');
  }
  if (/tool|plugin|cordis|profile|config/.test(lower)) {
    return new DshOperationalError(message, 'tool');
  }
  return new DshOperationalError(message, 'process');
}

function toDshError(error: unknown): DshOperationalError {
  if (error instanceof DshOperationalError) return error;
  return classifyDshFailure(error instanceof Error ? error.message : String(error));
}

function decode(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}

function isTerminal(state: HarnessSession['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function snapshot(session: DshSession): HarnessSession {
  return {
    id: session.id,
    runId: session.runId,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    profile: session.profile,
    state: session.state,
  };
}

export const harnessPlugin = {
  id: 'dsh-plugin',
  kind: 'deepseek-harness',
  create: (config) =>
    new DshHarnessAdapter({
      id: config.id,
      ...(config.executable ? { executable: config.executable } : {}),
      ...(config.args ? { args: config.args } : {}),
    }),
} as const satisfies HarnessPlugin;

registerHarnessPlugin(harnessPlugin);

export { DshHarnessAdapter as default };
