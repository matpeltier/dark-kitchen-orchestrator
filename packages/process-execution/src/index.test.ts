import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  PAYLOAD_FILE_ENVIRONMENT_VARIABLE,
  MAX_CONTROL_ARGUMENT_BYTES,
  createAcpxInvocation,
  createNativeJsonInvocation,
  createPayloadArtifact,
  defineAcpxLaunchProfile,
  defineNativeProcessLaunchProfile,
  defineProcess,
  executeProcess,
  filePayload,
  jsonPayload,
  streamPayload,
  stdinPayload,
} from './index.js';

const echoStdin = defineProcess({
  executable: process.execPath,
  args: ['-e', 'process.stdin.pipe(process.stdout)'],
});

const echoJsonStdin = defineProcess({
  executable: process.execPath,
  args: ['-e', 'process.stdin.pipe(process.stdout)'],
});

async function runEcho(payload: ReturnType<typeof stdinPayload>) {
  return executeProcess({ definition: echoStdin, payload });
}

describe('safe process execution', () => {
  it('transports a payload of at least one megabyte byte-for-byte over stdin', async () => {
    const payload = Buffer.alloc(1024 * 1024 + 17);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }

    const result = await runEcho(stdinPayload(payload));

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(payload);
  });

  it('transports a stream-backed payload without buffering it into argv', async () => {
    const payload = Buffer.from('stream payload\n$HOME `not-a-command`\n雪');
    const result = await executeProcess({
      definition: echoStdin,
      payload: streamPayload(
        Readable.from([payload.subarray(0, 8), payload.subarray(8)]),
        payload.length,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(payload);
    expect(echoStdin.args.join(' ')).not.toContain(payload.toString('utf8'));
  });

  it('round-trips shell-looking, unicode, newline, null, and JSON edge bytes as opaque data', async () => {
    const payload = Buffer.from(
      'single \' double " newline\nUnicode: café 🥣\n$HOME `whoami` $(touch nope) ; && || > < | \\0 null-like {"value":null}',
      'utf8',
    );
    const bytes = Buffer.concat([payload, Buffer.from([0, 255, 1, 2])]);

    const result = await runEcho(stdinPayload(bytes));

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(bytes);
  });

  it('does not place runtime payload contents in the process definition or diagnostics', async () => {
    const secret = 'payload-marker-$(touch should-not-run)-雪';
    const diagnostics: unknown[] = [];
    const definition = defineProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      label: 'opaque-payload-regression',
    });

    const result = await executeProcess({
      definition,
      payload: stdinPayload(secret),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.exitCode).toBe(0);
    expect(definition.args.join('\u0000')).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(definition)).not.toContain(secret);
  });

  it('treats a malicious shell-looking task body as data and never executes it', async () => {
    const marker = join(tmpdir(), `dark-kitchen-shell-marker-${process.pid}`);
    const payload = `$(touch ${marker}); echo pwned; "; rm -rf /`;

    const result = await runEcho(stdinPayload(payload));

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString('utf8')).toBe(payload);
    await expect(access(marker)).rejects.toThrow();
  });

  it('rejects oversized or line-broken control metadata', () => {
    expect(() =>
      defineProcess({
        executable: process.execPath,
        args: ['x'.repeat(MAX_CONTROL_ARGUMENT_BYTES + 1)],
      }),
    ).toThrow(/control metadata limit/);
    expect(() => defineProcess({ executable: process.execPath, args: ['safe\nvalue'] })).toThrow(
      /line break/,
    );
  });

  it('uses a file artifact reference without putting file contents in argv', async () => {
    const payload = Buffer.from('file-backed payload with $ and `quotes`\n雪');
    const artifact = await createPayloadArtifact(payload);
    const readArtifact = defineProcess({
      executable: process.execPath,
      args: [
        '-e',
        `require('node:fs').createReadStream(process.env.${PAYLOAD_FILE_ENVIRONMENT_VARIABLE}).pipe(process.stdout)`,
      ],
    });

    try {
      const result = await executeProcess({
        definition: readArtifact,
        payload: filePayload(artifact.path),
      });

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(payload);
      expect(readArtifact.args.join(' ')).not.toContain(payload.toString('utf8'));
    } finally {
      await artifact.dispose();
    }

    await expect(access(artifact.path)).rejects.toThrow();
  });
});

describe('ACP/acpx and native launch profiles', () => {
  it.each([
    [
      'acpx',
      (body: string) =>
        createAcpxInvocation(defineAcpxLaunchProfile(echoJsonStdin), { prompt: body }),
    ],
    [
      'native',
      (body: string) =>
        createNativeJsonInvocation(defineNativeProcessLaunchProfile(echoJsonStdin), {
          prompt: body,
        }),
    ],
  ])(
    'keeps %s prompt payloads out of argv and round-trips them through stdin',
    async (_name, makeInvocation) => {
      const prompt = 'rich prompt: "quotes"\n$HOME `echo no` && Unicode 雪';
      const invocation = makeInvocation(prompt);
      const result = await executeProcess(invocation);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({ prompt });
      expect(invocation.definition.args.join(' ')).not.toContain(prompt);
    },
  );

  it('supports native stream payloads through the same process boundary', async () => {
    const input = jsonPayload({ prompt: 'streamed', context: { body: 'large enough to be data' } });
    const profile = defineNativeProcessLaunchProfile(echoJsonStdin);
    const result = await executeProcess({
      ...createNativeJsonInvocation(profile, {
        prompt: 'streamed',
        context: { body: 'large enough to be data' },
      }),
      payload: input,
    });

    expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({
      prompt: 'streamed',
      context: { body: 'large enough to be data' },
    });
  });
});
