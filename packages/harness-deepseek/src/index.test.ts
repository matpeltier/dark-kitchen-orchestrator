import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunId, createTaskId, createWorkspaceId } from '@dark-kitchen/core';
import { UnsupportedCapabilityError } from '@dark-kitchen/harness';
import {
  DshCliBoundary,
  DshCompatibilityError,
  DshHarnessAdapter,
  DshOperationalError,
  harnessPlugin,
  type DshBoundaryRequest,
  type DshBoundaryResult,
  type DshExecutionBoundary,
} from './index.js';

class FakeDshBoundary implements DshExecutionBoundary {
  public readonly requests: DshBoundaryRequest[] = [];
  public version = '0.1.0-rc.7';
  public result: DshBoundaryResult = { exitCode: 0, stdout: 'done\n', stderr: '' };
  public runImpl?: (request: DshBoundaryRequest) => Promise<DshBoundaryResult>;

  public async getVersion(): Promise<string> {
    return this.version;
  }

  public async run(request: DshBoundaryRequest): Promise<DshBoundaryResult> {
    this.requests.push(request);
    return this.runImpl ? this.runImpl(request) : this.result;
  }
}

const profile = { managed: false, id: 'my-dsh', kind: 'deepseek-harness' } as const;

function startInput(prompt = 'implement safely') {
  return {
    runId: createRunId('run-dsh'),
    taskId: createTaskId('task-dsh'),
    workspaceId: createWorkspaceId(process.cwd()),
    profile,
    prompt,
  };
}

async function terminalEvent(
  adapter: DshHarnessAdapter,
  sessionId: Awaited<ReturnType<DshHarnessAdapter['startSession']>>['id'],
) {
  return new Promise<Parameters<Parameters<DshHarnessAdapter['subscribe']>[1]>[0]>((resolve) => {
    const unsubscribe = adapter.subscribe(sessionId, (event) => {
      if (['completed', 'failed', 'cancelled'].includes(event.state)) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe('DshHarnessAdapter', () => {
  it('exports the allowlist-loadable native plugin contract', () => {
    const runtime = harnessPlugin.create({
      id: 'dsh-from-plugin',
      executable: 'dsh',
    });

    expect(harnessPlugin.kind).toBe('deepseek-harness');
    expect(runtime).toBeInstanceOf(DshHarnessAdapter);
    expect(runtime.kind).toBe('deepseek-harness');
    expect(runtime.capabilities.supported).toEqual(new Set(['sessions.cancel']));
  });

  it('runs the official compatible profile through an injectable payload boundary', async () => {
    const boundary = new FakeDshBoundary();
    const adapter = new DshHarnessAdapter({
      id: 'dsh-native',
      profile: 'headless',
      dshHome: '/existing/user/dsh-home',
      boundary,
    });
    const prompt = 'large-ish prompt\n$HOME `touch nope` 雪';

    const session = await adapter.startSession(startInput(prompt));
    const event = await terminalEvent(adapter, session.id);

    expect(event).toMatchObject({ state: 'completed', output: 'done' });
    expect(boundary.requests).toHaveLength(1);
    expect(boundary.requests[0]).toMatchObject({
      profile: 'headless',
      prompt,
      dshHome: '/existing/user/dsh-home',
    });
    expect(adapter.capabilities.supported).toEqual(new Set(['sessions.cancel']));
  });

  it('rejects an unsupported installed version before execution', async () => {
    const boundary = new FakeDshBoundary();
    boundary.version = '0.2.0';
    const adapter = new DshHarnessAdapter({ id: 'dsh-native', boundary });

    await expect(adapter.startSession(startInput())).rejects.toBeInstanceOf(DshCompatibilityError);
    expect(boundary.requests).toHaveLength(0);
  });

  it.each(['0.1.0-rc.7', '0.1.0-rc.8'])('accepts supported DSH preview %s', async (version) => {
    const boundary = new FakeDshBoundary();
    boundary.version = version;
    const adapter = new DshHarnessAdapter({ id: `dsh-${version}`, boundary });

    await expect(adapter.probe()).resolves.toEqual({ available: true, version });
  });

  it('rejects model overrides because the official headless CLI does not expose them', async () => {
    const boundary = new FakeDshBoundary();
    const adapter = new DshHarnessAdapter({ id: 'dsh-native', boundary });

    await expect(
      adapter.startSession({ ...startInput(), model: 'deepseek/deepseek-v3.2' }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(boundary.requests).toHaveLength(0);
  });

  it('preserves user-managed skills and MCP by rejecting per-session injection', async () => {
    const boundary = new FakeDshBoundary();
    const adapter = new DshHarnessAdapter({ id: 'dsh-native', boundary });

    await expect(
      adapter.startSession({
        ...startInput(),
        resources: { skills: ['browser-testing'], mcpServers: ['privileged-mcp'] },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(boundary.requests).toHaveLength(0);
  });

  it('cancels an active one-shot process without a later completion event', async () => {
    const boundary = new FakeDshBoundary();
    boundary.runImpl = async (request) =>
      new Promise<DshBoundaryResult>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    const adapter = new DshHarnessAdapter({ id: 'dsh-native', boundary });
    const session = await adapter.startSession(startInput());
    const states: string[] = [];
    adapter.subscribe(session.id, (event) => states.push(event.state));

    await adapter.cancelSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toEqual(['cancelled']);
    expect((await adapter.getSession(session.id))?.state).toBe('cancelled');
  });

  it('maps authentication failures to a typed operational error', async () => {
    const boundary = new FakeDshBoundary();
    boundary.result = { exitCode: 1, stdout: '', stderr: 'Unauthorized API key' };
    const adapter = new DshHarnessAdapter({ id: 'dsh-native', boundary });
    const session = await adapter.startSession(startInput());

    const event = await terminalEvent(adapter, session.id);

    expect(event.state).toBe('failed');
    expect(event.error).toBeInstanceOf(DshOperationalError);
    expect(event.error).toMatchObject({ kind: 'auth' });
  });
});

describe('DshCliBoundary safe transport', () => {
  it('keeps shell-looking prompt data out of argv and preserves DSH_HOME', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dark-kitchen-dsh-fixture-'));
    const executable = join(directory, 'fake-dsh.mjs');
    const marker = join(directory, 'must-not-exist');
    const prompt = `do work $(touch ${marker}); "quotes"\nUnicode 雪`;
    const script = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('dsh 0.1.0-rc.7\\n');
} else {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    prompt: readFileSync(process.env.DARK_KITCHEN_PAYLOAD_FILE, 'utf8'),
    dshHome: process.env.DSH_HOME
  }));
}
`;

    try {
      await writeFile(executable, script, { encoding: 'utf8', flag: 'wx' });
      await chmod(executable, 0o755);
      const boundary = new DshCliBoundary();

      await expect(
        boundary.getVersion({ executable, args: [], dshHome: '/existing/dsh-home' }),
      ).resolves.toBe('0.1.0-rc.7');
      const result = await boundary.run({
        executable,
        args: [],
        profile: 'headless',
        prompt,
        cwd: process.cwd(),
        dshHome: '/existing/dsh-home',
        signal: new AbortController().signal,
      });
      const observed = JSON.parse(result.stdout) as {
        args: string[];
        prompt: string;
        dshHome: string;
      };

      expect(result.exitCode).toBe(0);
      expect(observed.prompt).toBe(prompt);
      expect(observed.args.join('\u0000')).not.toContain(prompt);
      expect(observed.args).toContain('--patch');
      expect(observed.dshHome).toBe('/existing/dsh-home');
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
