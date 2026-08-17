import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  PAYLOAD_FILE_ENVIRONMENT_VARIABLE,
  MAX_CONTROL_ARGUMENT_BYTES,
  ProcessExecutionError,
  allowExceptionalShell,
  createAcpxInvocation,
  createNativeProcessInvocation,
  createNativeJsonInvocation,
  createPayloadArtifact,
  controlArgument,
  defineAcpxLaunchProfile,
  defineExceptionalShell,
  defineNativeProcessLaunchProfile,
  defineProcess,
  executeExceptionalShell,
  executeProcess,
  filePayload,
  jsonPayload,
  streamPayload,
  stdinPayload,
  trustedShellCommand,
} from './index.js';
import type {
  ControlArgument,
  ExceptionalShellInvocation,
  PayloadTransport,
  ProcessDefinition,
  ProcessInvocation,
} from './index.js';

const controlArgs = (...args: string[]) => args.map(controlArgument);

const echoStdin = defineProcess({
  executable: process.execPath,
  args: controlArgs('-e', 'process.stdin.pipe(process.stdout)'),
});

const echoJsonStdin = defineProcess({
  executable: process.execPath,
  args: controlArgs('-e', 'process.stdin.pipe(process.stdout)'),
});

describe('safe process execution', () => {
  it('round-trips shell-looking, unicode, newline, null, and JSON edge bytes as opaque data', async () => {
    const payload = Buffer.from(
      'single \' double " newline\nUnicode: café 🥣\n$HOME `whoami` $(touch nope) ; && || > < | \\0 null-like {"value":null}',
      'utf8',
    );
    const bytes = Buffer.concat([payload, Buffer.from([0, 255, 1, 2])]);

    const result = await executeProcess({ definition: echoStdin, payload: stdinPayload(bytes) });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(bytes);
  });

  it('rejects oversized or line-broken control metadata', () => {
    expect(() =>
      defineProcess({
        executable: process.execPath,
        args: [controlArgument('x'.repeat(MAX_CONTROL_ARGUMENT_BYTES + 1))],
      }),
    ).toThrow(/control metadata limit/);
    expect(() =>
      defineProcess({ executable: process.execPath, args: [controlArgument('safe\nvalue')] }),
    ).toThrow(/line break/);
  });

  it('rejects a child that closes stdin before a large payload is written', async () => {
    const definition = defineProcess({
      executable: process.execPath,
      args: controlArgs('-e', 'process.exit(0)'),
    });

    await expect(
      executeProcess({
        definition,
        payload: stdinPayload(Buffer.alloc(16 * 1024 * 1024)),
      }),
    ).rejects.toBeInstanceOf(ProcessExecutionError);
  });

  it('rejects and cleans up when a stream payload fails', async () => {
    const sourceError = new Error('payload source failed');
    const source = new Readable({
      read(): void {
        this.destroy(sourceError);
      },
    });
    const definition = defineProcess({
      executable: process.execPath,
      args: controlArgs('-e', 'process.stdin.resume()'),
    });

    await expect(
      executeProcess({ definition, payload: streamPayload(source) }),
    ).rejects.toMatchObject({
      name: 'ProcessExecutionError',
      cause: sourceError,
    });
    expect(source.destroyed).toBe(true);
  });

  it('rejects when a stream closes before emitting end', async () => {
    const source = new Readable({
      read(): void {
        this.push(Buffer.from('partial payload'));
        this.destroy();
      },
    });
    const definition = defineProcess({
      executable: process.execPath,
      args: controlArgs('-e', 'process.stdin.resume()'),
    });

    await expect(
      executeProcess({ definition, payload: streamPayload(source) }),
    ).rejects.toBeInstanceOf(ProcessExecutionError);
    expect(source.destroyed).toBe(true);
  });

  it('rejects and terminates the child when the started diagnostic fails', async () => {
    const callbackError = new Error('started diagnostic failed');
    const marker = join(tmpdir(), `dark-kitchen-started-callback-${process.pid}-${Date.now()}`);
    const definition = defineProcess({
      executable: process.execPath,
      args: controlArgs(
        '-e',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 100); process.stdin.resume()`,
      ),
    });

    try {
      await expect(
        executeProcess({
          definition,
          onDiagnostic: () => {
            throw callbackError;
          },
        }),
      ).rejects.toMatchObject({ name: 'ProcessExecutionError', cause: callbackError });

      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(marker, { force: true });
    }
  });

  it('rejects when the finished diagnostic fails', async () => {
    const callbackError = new Error('finished diagnostic failed');
    const events: string[] = [];

    await expect(
      executeProcess({
        definition: echoStdin,
        onDiagnostic: (diagnostic) => {
          events.push(diagnostic.event);
          if (diagnostic.event === 'finished') {
            throw callbackError;
          }
        },
      }),
    ).rejects.toMatchObject({ name: 'ProcessExecutionError', cause: callbackError });
    expect(events).toEqual(['started', 'finished']);
  });

  it('removes inherited payload artifact variables from non-file transports', async () => {
    const previousValue = process.env[PAYLOAD_FILE_ENVIRONMENT_VARIABLE];
    process.env[PAYLOAD_FILE_ENVIRONMENT_VARIABLE] = '/tmp/stale-dark-kitchen-payload.bin';
    const printPayloadEnvironment = defineProcess({
      executable: process.execPath,
      args: controlArgs(
        '-e',
        `process.stdout.write(process.env.${PAYLOAD_FILE_ENVIRONMENT_VARIABLE} ?? 'missing')`,
      ),
    });
    const shellDefinition = defineExceptionalShell({
      command: trustedShellCommand(
        `printenv ${PAYLOAD_FILE_ENVIRONMENT_VARIABLE} || printf missing`,
      ),
      policy: allowExceptionalShell('environment isolation test'),
    });

    try {
      const processResult = await executeProcess({ definition: printPayloadEnvironment });
      const shellResult = await executeExceptionalShell({ definition: shellDefinition });

      expect(Buffer.from(processResult.stdout).toString('utf8')).toBe('missing');
      expect(Buffer.from(shellResult.stdout).toString('utf8')).toBe('missing');
    } finally {
      if (previousValue === undefined) {
        delete process.env[PAYLOAD_FILE_ENVIRONMENT_VARIABLE];
      } else {
        process.env[PAYLOAD_FILE_ENVIRONMENT_VARIABLE] = previousValue;
      }
    }
  });
});

interface AdapterContractCase {
  readonly name: string;
  readonly definition: ProcessDefinition;
  createInvocation(payload: PayloadTransport, definition?: ProcessDefinition): ProcessInvocation;
  createPromptInvocation(prompt: string): ProcessInvocation;
}

const acpxProfile = defineAcpxLaunchProfile(echoJsonStdin);
const nativeProfile = defineNativeProcessLaunchProfile(echoJsonStdin);

function createAcpxPayloadInvocation(
  payload: PayloadTransport,
  definition: ProcessDefinition = acpxProfile.process,
): ProcessInvocation {
  return {
    ...createAcpxInvocation(defineAcpxLaunchProfile(definition), {
      prompt: 'shared payload regression',
    }),
    payload,
  };
}

function createNativePayloadInvocation(
  payload: PayloadTransport,
  definition: ProcessDefinition = nativeProfile.process,
): ProcessInvocation {
  return createNativeProcessInvocation(defineNativeProcessLaunchProfile(definition), payload);
}

const adapterContractCases: readonly AdapterContractCase[] = [
  {
    name: 'acpx',
    definition: acpxProfile.process,
    createInvocation: createAcpxPayloadInvocation,
    createPromptInvocation: (prompt) => createAcpxInvocation(acpxProfile, { prompt }),
  },
  {
    name: 'native',
    definition: nativeProfile.process,
    createInvocation: createNativePayloadInvocation,
    createPromptInvocation: (prompt) => createNativeJsonInvocation(nativeProfile, { prompt }),
  },
];

describe('ACP/acpx invocation path', () => {
  it('transports large and hostile prompt/context data through the factory', async () => {
    const marker = join(tmpdir(), `dark-kitchen-acpx-shell-marker-${process.pid}-${Date.now()}`);
    const prompt = `${'p'.repeat(512 * 1024)} $(touch ${marker}); echo pwned; "quotes"\n雪\0`;
    const context = {
      body: 'c'.repeat(512 * 1024),
      nullValue: null,
      shellLooking: `$(touch ${marker}) && rm -rf /`,
      unicode: 'café 🥣',
    };
    const invocation = createAcpxInvocation(acpxProfile, { prompt, context });

    const result = await executeProcess(invocation);
    const parsed = JSON.parse(Buffer.from(result.stdout).toString('utf8')) as {
      prompt: string;
      context: typeof context;
    };

    expect(result.exitCode).toBe(0);
    expect(parsed).toEqual({ prompt, context });
    expect(invocation.definition.args.join(' ')).not.toContain(prompt);
    await expect(access(marker)).rejects.toThrow();
  });
});

for (const adapter of adapterContractCases) {
  describe(`${adapter.name} shared payload contract`, () => {
    it('transports payloads of at least one megabyte byte-for-byte', async () => {
      const payload = Buffer.alloc(1024 * 1024 + 17);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = index % 251;
      }

      const result = await executeProcess(adapter.createInvocation(stdinPayload(payload)));

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(payload);
    });

    it('treats malicious shell-looking task text as opaque data', async () => {
      const marker = join(tmpdir(), `dark-kitchen-${adapter.name}-shell-marker-${process.pid}`);
      const payload = `$(touch ${marker}); echo pwned; "; rm -rf /`;

      const result = await executeProcess(adapter.createInvocation(stdinPayload(payload)));

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString('utf8')).toBe(payload);
      await expect(access(marker)).rejects.toThrow();
    });

    it('round-trips binary, null, and JSON-edge bytes without reinterpretation', async () => {
      const payload = Buffer.concat([
        Buffer.from([0, 255, 1, 2]),
        Buffer.from(JSON.stringify({ nullValue: null, empty: '', numbers: [0, -1, 1.5] })),
        Buffer.from([0, 128, 254]),
      ]);
      const jsonValue = { nullValue: null, empty: '', numbers: [0, -1, 1.5] };

      const result = await executeProcess(adapter.createInvocation(stdinPayload(payload)));
      const jsonResult = await executeProcess(adapter.createInvocation(jsonPayload(jsonValue)));

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(payload);
      expect(jsonResult.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(jsonResult.stdout).toString('utf8'))).toEqual(jsonValue);
    });

    it('supports a native stream payload without placing it in argv', async () => {
      const payload = Buffer.from('stream payload\n$HOME `not-a-command`\n雪');
      const result = await executeProcess(
        adapter.createInvocation(
          streamPayload(
            Readable.from([payload.subarray(0, 8), payload.subarray(8)]),
            payload.length,
          ),
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(payload);
      expect(adapter.definition.args.join(' ')).not.toContain(payload.toString('utf8'));
    });

    it('supports a file payload without placing its contents in argv', async () => {
      const payload = Buffer.from('file-backed payload with $ and `quotes`\n雪');
      const artifact = await createPayloadArtifact(payload);
      const readArtifact = defineProcess({
        executable: process.execPath,
        args: controlArgs(
          '-e',
          `require('node:fs').createReadStream(process.env.${PAYLOAD_FILE_ENVIRONMENT_VARIABLE}).pipe(process.stdout)`,
        ),
      });

      try {
        const result = await executeProcess(
          adapter.createInvocation(filePayload(artifact.path), readArtifact),
        );

        expect(result.exitCode).toBe(0);
        expect(Buffer.from(result.stdout)).toEqual(payload);
        expect(readArtifact.args.join(' ')).not.toContain(payload.toString('utf8'));
      } finally {
        await artifact.dispose();
      }

      await expect(access(artifact.path)).rejects.toThrow();
    });

    it('does not leak payload contents through process metadata or diagnostics', async () => {
      const secret = `payload-marker-${adapter.name}-$(touch should-not-run)-雪`;
      const diagnostics: unknown[] = [];
      const result = await executeProcess({
        ...adapter.createInvocation(stdinPayload(secret)),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(result.exitCode).toBe(0);
      expect(adapter.definition.args.join('\u0000')).not.toContain(secret);
      expect(JSON.stringify(diagnostics)).not.toContain(secret);
      expect(JSON.stringify(adapter.definition)).not.toContain(secret);
    });

    it('keeps structured prompt text out of argv', async () => {
      const prompt = `rich prompt ${adapter.name}: "quotes"\n$HOME \`echo no\` && Unicode 雪`;
      const invocation = adapter.createPromptInvocation(prompt);
      const result = await executeProcess(invocation);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({ prompt });
      expect(invocation.definition.args.join(' ')).not.toContain(prompt);
    });
  });
}

describe('trusted configuration boundaries', () => {
  it('does not type-check ordinary task text as process control metadata', () => {
    const taskDescription = 'task body must remain payload data';
    // @ts-expect-error Runtime task text is not a trusted control argument.
    const unsafeArgs: ControlArgument[] = [taskDescription];
    expect(unsafeArgs).toHaveLength(1);
  });

  it('requires shell commands to be defined separately from runtime invocations', () => {
    const policy = allowExceptionalShell('compatibility test');
    const definition = defineExceptionalShell({
      command: trustedShellCommand('printf trusted-shell'),
      policy,
    });
    const taskDescription = '$(touch should-not-run)';
    const unsafeInvocation: ExceptionalShellInvocation = {
      // @ts-expect-error Runtime invocations cannot supply a command string.
      command: taskDescription,
      policy,
    };

    expect(definition.command).not.toContain(taskDescription);
    expect(unsafeInvocation).toBeDefined();
    expect(() => executeExceptionalShell(unsafeInvocation)).toThrow(/shell definition/);
    expect(executeExceptionalShell).toBeTypeOf('function');
  });

  it('uses an explicitly trusted shell definition when the escape hatch is needed', async () => {
    const definition = defineExceptionalShell({
      command: trustedShellCommand('printf trusted-shell'),
      policy: allowExceptionalShell('compatibility test'),
    });
    const result = await executeExceptionalShell({ definition });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString('utf8')).toBe('trusted-shell');
  });
});
