import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileWorkflowJournal,
  InMemoryWorkflowJournal,
  ScriptedHarnessRunner,
  WorkflowAbortError,
  WorkflowRegistry,
  parseWorkflowScript,
  runWorkflow,
} from './index.js';

const meta = (name: string): string =>
  `export const meta = { name: '${name}', description: 'test workflow' }`;

describe('workflow engine', () => {
  it('executes sequential, parallel, pipeline, phases, logs, and semantic roles', async () => {
    const progress: string[] = [];
    const runner = new ScriptedHarnessRunner((call) => `${call.role}:${call.prompt}`);
    const result = await runWorkflow(
      `${meta('composition')}
phase('Plan')
log('started')
const one = await agent('outline', { role: 'planner', phase: 'Plan' })
const many = await parallel(['a', 'b'].map((item) => () => agent(item, { role: 'worker', label: item })))
const piped = await pipeline([1, 2], (value) => value + 1, (value) => value * 2)
return { one, many, piped }
`,
      {
        runner,
        onProgress: (event) =>
          progress.push(event.type === 'agent' ? `${event.state}:${event.role}` : event.type),
      },
    );

    expect(result.result).toEqual({
      one: 'planner:outline',
      many: ['worker:a', 'worker:b'],
      piped: [4, 6],
    });
    expect(result.phases).toEqual(['Plan']);
    expect(result.logs).toEqual(['started']);
    expect(runner.calls.map((call) => call.role)).toEqual(['planner', 'worker', 'worker']);
    expect(progress).toContain('phase');
    expect(progress.filter((event) => event.startsWith('completed:'))).toHaveLength(3);
  });

  it('caps concurrent harness calls', async () => {
    let active = 0;
    let maximum = 0;
    const runner = new ScriptedHarnessRunner(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'ok';
    });
    const result = await runWorkflow(
      `${meta('concurrency')}
return parallel([1, 2, 3, 4, 5].map((item) => () => agent(String(item), { role: 'worker' })))
`,
      { runner, concurrency: 2 },
    );

    expect(result.result).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(maximum).toBe(2);
  });

  it('retries transient failures and records exhausted calls', async () => {
    let attempts = 0;
    const runner = new ScriptedHarnessRunner(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'recovered';
    });
    const recovered = await runWorkflow(
      `${meta('retry')}
return agent('retry me', { role: 'recover' })
`,
      { runner, agentMaxAttempts: 3, retryDelayMs: 0 },
    );
    expect(recovered.result).toBe('recovered');
    expect(attempts).toBe(3);

    const exhausted = await runWorkflow(
      `${meta('exhausted')}
const value = await agent('always fails', { role: 'doomed' })
return { value }
`,
      {
        runner: new ScriptedHarnessRunner(() => {
          throw new Error('permanent');
        }),
        agentMaxAttempts: 2,
        retryDelayMs: 0,
      },
    );
    expect(exhausted.result).toEqual({ value: null });
    expect(exhausted.failures[0]).toMatchObject({
      role: 'doomed',
      attempts: 2,
      error: 'permanent',
    });
  });

  it('replays durable journal entries and runs only missing calls', async () => {
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('replay')}
const first = await agent('first', { role: 'first' })
const second = await agent('second', { role: 'second' })
return { first, second }
`;
    let failSecond = true;
    const runner = new ScriptedHarnessRunner((call) => {
      if (call.role === 'second' && failSecond) throw new Error('missing');
      return `fresh:${call.role}`;
    });
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'replay-run',
      agentMaxAttempts: 1,
    });
    failSecond = false;
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'replay-run',
      agentMaxAttempts: 1,
    });

    expect(first.result).toEqual({ first: 'fresh:first', second: null });
    expect(second.result).toEqual({ first: 'fresh:first', second: 'fresh:second' });
    expect(second.cacheHits).toBe(1);
    expect(runner.calls.map((call) => call.role)).toEqual(['first', 'second', 'second']);
    expect(runner.calls[1]?.cacheKey).toBe(runner.calls[2]?.cacheKey);
  });

  it('persists journal entries for a fresh process-level journal instance', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dark-kitchen-workflow-journal-'));
    try {
      const script = `${meta('file-replay')}
return agent('persist me', { role: 'persistent-worker' })
`;
      await runWorkflow(script, {
        runner: new ScriptedHarnessRunner(() => 'from first run'),
        journal: new FileWorkflowJournal(directory),
        runId: 'file-replay-run',
      });
      const calls: string[] = [];
      const result = await runWorkflow(script, {
        runner: new ScriptedHarnessRunner((call) => {
          calls.push(call.role);
          return 'should not execute';
        }),
        journal: new FileWorkflowJournal(directory),
        runId: 'file-replay-run',
      });

      expect(result.result).toBe('from first run');
      expect(result.cacheHits).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports nested workflows sharing the runner and journal', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('child')}
return agent(args.prompt, { role: 'child-worker' })
`);
    const runner = new ScriptedHarnessRunner((call) => `done:${call.prompt}`);
    const result = await runWorkflow(
      `${meta('parent')}
const child = await workflow('child', { prompt: 'nested' })
return { child }
`,
      { runner, resolveWorkflow: registry.resolve.bind(registry) },
    );

    expect(result.result).toEqual({ child: 'done:nested' });
    expect(runner.calls[0]?.workflowPath).toBe('parent/child');
  });

  it('cancels an in-flight runner', async () => {
    const controller = new AbortController();
    const runner = new ScriptedHarnessRunner(
      (_call, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('runner stopped')), {
            once: true,
          });
        }),
    );
    const pending = runWorkflow(
      `${meta('cancel')}
return agent('long task', { role: 'slow-worker' })
`,
      { runner, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
  });

  it('parses literal metadata and rejects executable metadata', () => {
    const parsed = parseWorkflowScript(`${meta('parser')}
return 1
`);
    expect(parsed.meta.name).toBe('parser');
    expect(parsed.body).toContain('return 1');
    expect(() =>
      parseWorkflowScript(`export const meta = { name: makeName(), description: 'bad' }`),
    ).toThrow(/pure literal/);
  });
});
