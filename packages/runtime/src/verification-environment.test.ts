import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VerificationEnvironmentCommandError,
  VerificationEnvironmentController,
} from './verification-environment.js';

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dark-kitchen-verification-env-'));
  roots.push(root);
  return root;
}

function appendCommand(path: string, value: string) {
  return {
    executable: process.execPath,
    args: [
      '-e',
      'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")',
      path,
      value,
    ],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('VerificationEnvironmentController', () => {
  it('runs setup then health once and teardown once through structured commands', async () => {
    const root = await testRoot();
    const log = join(root, 'phases.log');
    const controller = new VerificationEnvironmentController({
      setup: [appendCommand(log, 'setup')],
      healthcheck: [appendCommand(log, 'health')],
      teardown: [appendCommand(log, 'teardown')],
    });

    await Promise.all([controller.prepare(root), controller.prepare(root)]);
    await Promise.all([controller.teardown(root), controller.teardown(root)]);

    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'setup',
      'health',
      'teardown',
    ]);
  });

  it('fails closed on an unhealthy environment and still allows teardown', async () => {
    const root = await testRoot();
    const log = join(root, 'phases.log');
    const controller = new VerificationEnvironmentController({
      setup: [appendCommand(log, 'setup')],
      healthcheck: [{ executable: process.execPath, args: ['-e', 'process.exit(7)'] }],
      teardown: [appendCommand(log, 'teardown')],
    });

    await expect(controller.prepare(root)).rejects.toBeInstanceOf(
      VerificationEnvironmentCommandError,
    );
    await controller.teardown(root);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['setup', 'teardown']);
  });

  it('never interpolates runtime payload into command arguments', async () => {
    const root = await testRoot();
    const log = join(root, 'literal.log');
    const trackerPayload = '$(touch should-never-exist)';
    const controller = new VerificationEnvironmentController({
      setup: [appendCommand(log, trackerPayload)],
    });

    await controller.prepare(root);
    expect(await readFile(log, 'utf8')).toBe(`${trackerPayload}\n`);
    await expect(readFile(join(root, 'should-never-exist'), 'utf8')).rejects.toThrow();
  });
});
