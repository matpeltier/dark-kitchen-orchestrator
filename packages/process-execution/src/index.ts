import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** The only environment value added for a file-backed payload. Its value is a path, not data. */
export const PAYLOAD_FILE_ENVIRONMENT_VARIABLE = 'DARK_KITCHEN_PAYLOAD_FILE';

/** A deliberately small limit for values that are allowed to cross in argv. */
export const MAX_CONTROL_ARGUMENT_BYTES = 4_096;

/** Keep the complete control argument vector bounded as well as each individual value. */
export const MAX_CONTROL_ARGUMENT_COUNT = 128;
export const MAX_CONTROL_ARGUMENT_TOTAL_BYTES = 64 * 1_024;

/** A process definition is configuration, never a place to put runtime payload data. */
export interface ProcessDefinition {
  readonly executable: string;
  readonly args: readonly ControlArgument[];
  readonly label?: string;
}

declare const controlArgumentBrand: unique symbol;

/**
 * A bounded command-line value. Use stdinPayload, streamPayload, or filePayload for data.
 * The brand makes the control/payload distinction visible to TypeScript callers, while the
 * runtime validation in defineProcess protects JavaScript callers as well.
 */
export type ControlArgument = string & { readonly [controlArgumentBrand]: true };

export interface ProcessDefinitionInput {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly label?: string;
}

function assertControlValue(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }

  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain a null byte`);
  }

  if (value.includes('\r') || value.includes('\n')) {
    throw new TypeError(`${name} must not contain a line break`);
  }

  if (Buffer.byteLength(value, 'utf8') > MAX_CONTROL_ARGUMENT_BYTES) {
    throw new RangeError(
      `${name} exceeds the ${MAX_CONTROL_ARGUMENT_BYTES}-byte control metadata limit`,
    );
  }
}

/** Converts bounded control metadata into the branded type accepted by process definitions. */
export function controlArgument(value: string): ControlArgument {
  assertControlValue(value, 'Control argument');
  return value as ControlArgument;
}

/** Alias that makes the control-metadata intent explicit at call sites. */
export const controlMetadata = controlArgument;

/**
 * Creates a shell-free process definition. `args` is an array by construction; there is no
 * command-string form of this API.
 */
export function defineProcess(input: ProcessDefinitionInput): ProcessDefinition {
  assertControlValue(input.executable, 'Executable');
  if (input.args !== undefined && !Array.isArray(input.args)) {
    throw new TypeError('Process arguments must be an array');
  }
  const args = (input.args ?? []).map((arg, index) => {
    if (typeof arg !== 'string') {
      throw new TypeError(`Process argument ${index} must be a string`);
    }
    return controlArgument(arg);
  });
  validateArgumentVector(args);

  if (input.label === undefined) {
    return Object.freeze({ executable: input.executable, args: Object.freeze(args) });
  }

  assertControlValue(input.label, 'Process label');
  return Object.freeze({
    executable: input.executable,
    args: Object.freeze(args),
    label: input.label,
  });
}

function toBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }

  return data.slice();
}

export interface StdinPayload {
  readonly kind: 'stdin';
  readonly bytes: Uint8Array;
}

export interface StreamPayload {
  readonly kind: 'stream';
  readonly stream: Readable;
  /** Optional size used only for bounded diagnostics. The stream itself is never logged. */
  readonly byteLength?: number;
}

export interface FilePayload {
  readonly kind: 'file';
  readonly path: string;
}

/** Runtime payloads are always data channels, never command-line arguments. */
export type PayloadTransport = StdinPayload | StreamPayload | FilePayload;

export function stdinPayload(data: string | Uint8Array): StdinPayload {
  return Object.freeze({ kind: 'stdin', bytes: toBytes(data) });
}

export function streamPayload(stream: Readable, byteLength?: number): StreamPayload {
  if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) {
    throw new RangeError('Stream payload byteLength must be a non-negative safe integer');
  }

  if (byteLength === undefined) {
    return Object.freeze({ kind: 'stream', stream });
  }

  return Object.freeze({ kind: 'stream', stream, byteLength });
}

/** Creates a reference to an existing artifact. Only this path reference may enter process metadata. */
export function filePayload(path: string): FilePayload {
  assertControlValue(path, 'Payload artifact path');
  return Object.freeze({ kind: 'file', path });
}

export function jsonPayload(value: unknown): StdinPayload {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('JSON payload must be serializable');
  }
  return stdinPayload(serialized);
}

export interface PayloadArtifact {
  readonly path: string;
  readonly byteLength: number;
  dispose(): Promise<void>;
}

export interface CreatePayloadArtifactOptions {
  /** An optional trusted artifact directory. The payload is still written as file data. */
  readonly directory?: string;
}

/**
 * Materializes arbitrary data as a disposable file artifact. The artifact path is the only
 * process-visible metadata; the payload bytes never enter an argv array or shell string.
 */
export async function createPayloadArtifact(
  data: string | Uint8Array,
  options: CreatePayloadArtifactOptions = {},
): Promise<PayloadArtifact> {
  const bytes = toBytes(data);
  const directory = await mkdtemp(join(options.directory ?? tmpdir(), 'dark-kitchen-payload-'));
  const path = join(directory, 'payload.bin');

  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    path,
    byteLength: bytes.byteLength,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function withPayloadArtifact<T>(
  data: string | Uint8Array,
  callback: (payload: FilePayload, artifact: PayloadArtifact) => Promise<T>,
  options: CreatePayloadArtifactOptions = {},
): Promise<T> {
  const artifact = await createPayloadArtifact(data, options);
  try {
    return await callback(filePayload(artifact.path), artifact);
  } finally {
    await artifact.dispose();
  }
}

export interface ProcessInvocation {
  readonly definition: ProcessDefinition;
  readonly payload?: PayloadTransport;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly onDiagnostic?: (diagnostic: ProcessDiagnostic) => void;
}

export interface ProcessDiagnostic {
  readonly event: 'started' | 'finished';
  readonly executable: string;
  readonly label?: string;
  readonly argumentCount: number;
  readonly payloadKind: 'none' | PayloadTransport['kind'];
  readonly payloadByteLength?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export class ProcessExecutionError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.cause = cause;
  }
}

function validateDefinition(definition: ProcessDefinition): void {
  assertControlValue(definition.executable, 'Executable');
  if (!Array.isArray(definition.args)) {
    throw new TypeError('Process definition args must be an array');
  }
  validateArgumentVector(definition.args);
}

function validateArgumentVector(args: readonly string[]): void {
  if (args.length > MAX_CONTROL_ARGUMENT_COUNT) {
    throw new RangeError(
      `Process argument vector exceeds the ${MAX_CONTROL_ARGUMENT_COUNT}-argument control metadata limit`,
    );
  }

  let totalBytes = 0;
  args.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      throw new TypeError(`Process argument ${index} must be a string`);
    }
    assertControlValue(arg, `Process argument ${index}`);
    totalBytes += Buffer.byteLength(arg, 'utf8');
    if (totalBytes > MAX_CONTROL_ARGUMENT_TOTAL_BYTES) {
      throw new RangeError(
        `Process argument vector exceeds the ${MAX_CONTROL_ARGUMENT_TOTAL_BYTES}-byte control metadata limit`,
      );
    }
  });
}

function payloadKind(payload: PayloadTransport | undefined): ProcessDiagnostic['payloadKind'] {
  return payload?.kind ?? 'none';
}

function payloadByteLength(payload: PayloadTransport | undefined): number | undefined {
  if (payload?.kind === 'stdin') {
    return payload.bytes.byteLength;
  }
  if (payload?.kind === 'stream') {
    return payload.byteLength;
  }
  return undefined;
}

function emitDiagnostic(invocation: ProcessInvocation, diagnostic: ProcessDiagnostic): void {
  invocation.onDiagnostic?.(diagnostic);
}

function finishStdin(payload: PayloadTransport | undefined, stdin: Writable): void {
  if (payload?.kind === 'stdin') {
    stdin.end(Buffer.from(payload.bytes));
    return;
  }

  if (payload?.kind === 'stream') {
    payload.stream.on('error', (error) => stdin.destroy(error));
    payload.stream.pipe(stdin);
    return;
  }

  // A file payload is referenced through an environment path. It has no stdin data.
  stdin.end();
}

/**
 * Runs a configured executable with shell execution disabled. Payloads are sent through stdin,
 * streams, or the file-artifact environment reference; they are never added to argv.
 */
export function executeProcess(invocation: ProcessInvocation): Promise<ProcessResult> {
  validateDefinition(invocation.definition);
  if (invocation.cwd !== undefined) {
    assertControlValue(invocation.cwd, 'Working directory');
  }

  const payload = invocation.payload;
  if (payload?.kind === 'file') {
    assertControlValue(payload.path, 'Payload artifact path');
  }

  const spawnOptions: Parameters<typeof spawn>[2] = {
    cwd: invocation.cwd,
    env:
      payload?.kind === 'file'
        ? { ...process.env, [PAYLOAD_FILE_ENVIRONMENT_VARIABLE]: payload.path }
        : process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal: invocation.signal,
  };

  const args = invocation.definition.args.map((arg) => String(arg));
  const child = spawn(invocation.definition.executable, args, spawnOptions);
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    child.kill();
    throw new ProcessExecutionError('Process was not created with piped standard streams');
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const diagnosticBase: {
    executable: string;
    argumentCount: number;
    payloadKind: ProcessDiagnostic['payloadKind'];
    label?: string;
    payloadByteLength?: number;
  } = {
    executable: invocation.definition.executable,
    argumentCount: args.length,
    payloadKind: payloadKind(payload),
  };
  const payloadLength = payloadByteLength(payload);
  if (invocation.definition.label !== undefined) {
    diagnosticBase.label = invocation.definition.label;
  }
  if (payloadLength !== undefined) {
    diagnosticBase.payloadByteLength = payloadLength;
  }

  emitDiagnostic(invocation, { event: 'started', ...diagnosticBase });

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        error instanceof ProcessExecutionError
          ? error
          : new ProcessExecutionError(
              `Unable to launch process ${invocation.definition.executable}`,
              error,
            ),
      );
    };

    child.once('error', fail);
    childStdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    childStderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    childStdout.once('error', fail);
    childStderr.once('error', fail);

    try {
      finishStdin(payload, childStdin);
    } catch (error) {
      fail(error);
      return;
    }

    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      emitDiagnostic(invocation, {
        event: 'finished',
        ...diagnosticBase,
        exitCode,
        signal,
      });
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export const runProcess = executeProcess;

export interface ExceptionalShellPolicy {
  readonly kind: 'exceptional-shell-execution';
  readonly reason: string;
}

/** Creates the explicit policy required by the exceptional shell API. */
export function allowExceptionalShell(reason: string): ExceptionalShellPolicy {
  assertControlValue(reason, 'Shell policy reason');
  return Object.freeze({ kind: 'exceptional-shell-execution', reason });
}

export interface ExceptionalShellInvocation {
  readonly command: string;
  readonly policy: ExceptionalShellPolicy;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

/**
 * Exceptional escape hatch for a trusted, preconfigured shell command. There is intentionally no
 * payload field or argv data parameter, so callers cannot pass runtime payloads to this API.
 */
export function executeExceptionalShell(
  invocation: ExceptionalShellInvocation,
): Promise<ProcessResult> {
  if (invocation.policy.kind !== 'exceptional-shell-execution') {
    throw new TypeError('An explicit exceptional shell-execution policy is required');
  }
  if (typeof invocation.command !== 'string' || invocation.command.length === 0) {
    throw new TypeError('Shell command must be a non-empty trusted configuration string');
  }
  if (invocation.cwd !== undefined) {
    assertControlValue(invocation.cwd, 'Working directory');
  }

  const child = spawn(invocation.command, {
    cwd: invocation.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    signal: invocation.signal,
  });
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdout === null || childStderr === null) {
    child.kill();
    throw new ProcessExecutionError('Exceptional shell was not created with piped output');
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new ProcessExecutionError('Unable to launch exceptional shell command', error));
    };

    child.once('error', fail);
    childStdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    childStderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    childStdout.once('error', fail);
    childStderr.once('error', fail);
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export const runExceptionalShell = executeExceptionalShell;

export interface AcpxLaunchProfile {
  readonly process: ProcessDefinition;
}

export interface AcpxPromptRequest {
  readonly prompt: string;
  readonly context?: unknown;
}

export function defineAcpxLaunchProfile(process: ProcessDefinition): AcpxLaunchProfile {
  return Object.freeze({ process });
}

/** ACP/acpx prompt and context are one structured stdin payload, never command arguments. */
export function createAcpxInvocation(
  profile: AcpxLaunchProfile,
  request: AcpxPromptRequest,
): ProcessInvocation {
  const input =
    request.context === undefined
      ? { prompt: request.prompt }
      : { prompt: request.prompt, context: request.context };
  return { definition: profile.process, payload: jsonPayload(input) };
}

export const createAcpInvocation = createAcpxInvocation;

export interface NativeProcessLaunchProfile {
  readonly process: ProcessDefinition;
}

export function defineNativeProcessLaunchProfile(
  process: ProcessDefinition,
): NativeProcessLaunchProfile {
  return Object.freeze({ process });
}

/** Native/custom harness input also uses the shared payload transport, never argv interpolation. */
export function createNativeProcessInvocation(
  profile: NativeProcessLaunchProfile,
  payload: PayloadTransport,
): ProcessInvocation {
  return { definition: profile.process, payload };
}

/** Convenience form for native adapters whose protocol input is structured JSON. */
export function createNativeJsonInvocation(
  profile: NativeProcessLaunchProfile,
  input: unknown,
): ProcessInvocation {
  return { definition: profile.process, payload: jsonPayload(input) };
}
