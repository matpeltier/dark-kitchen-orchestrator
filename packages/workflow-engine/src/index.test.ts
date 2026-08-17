import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileWorkflowJournal,
  InMemoryWorkflowJournal,
  ScriptedHarnessRunner,
  WorkflowAbortError,
  WorkflowInputError,
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

  it('keeps nested invocation identities independent per child workflow', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('first-child')}
return agent('first', { role: 'child-worker' })
`);
    registry.register(`${meta('second-child')}
return agent('second', { role: 'child-worker' })
`);
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const result = await runWorkflow(
      `${meta('independent-parent')}
const first = await workflow('first-child')
const second = await workflow('second-child')
const repeated = await workflow('first-child')
return { first, second, repeated }
`,
      { runner, resolveWorkflow: registry.resolve.bind(registry) },
    );

    expect(result.result).toEqual({
      first: 'independent-parent/first-child',
      second: 'independent-parent/second-child',
      repeated: 'independent-parent/first-child#2',
    });
    expect(new Set(runner.calls.map((call) => call.cacheKey)).size).toBe(3);
  });

  it('gives repeated nested workflow invocations distinct journal identities', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('repeated-child')}
return agent(args.prompt, { role: 'child-worker' })
`);
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('repeated-parent')}
const sequential = [
  await workflow('repeated-child', { prompt: 'same' }),
  await workflow('repeated-child', { prompt: 'same' }),
]
const parallelResults = await parallel([
  () => workflow('repeated-child', { prompt: 'same' }),
  () => workflow('repeated-child', { prompt: 'same' }),
])
return { sequential, parallel: parallelResults }
`;
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'repeated-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'repeated-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });

    expect(first.result).toEqual({
      sequential: ['repeated-parent/repeated-child', 'repeated-parent/repeated-child#2'],
      parallel: ['repeated-parent/repeated-child@2.0.0', 'repeated-parent/repeated-child@2.1.0'],
    });
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(4);
    expect(runner.calls).toHaveLength(4);
    expect(new Set(runner.calls.map((call) => call.cacheKey)).size).toBe(4);
  });

  it('assigns parallel nested identities by call order despite resolver completion order', async () => {
    const child = `${meta('canonical-child')}
return agent('same', { role: 'child-worker' })
`;
    let resolutionCount = 0;
    const resolveWorkflow = async () => {
      const invocation = resolutionCount++ % 2;
      await new Promise((resolve) => setTimeout(resolve, invocation === 0 ? 10 : 0));
      return { script: child, name: 'canonical-child' };
    };
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('ordered-parent')}
return parallel([
  () => workflow('first'),
  () => workflow('second'),
])
`;
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'ordered-nested-run',
      resolveWorkflow,
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'ordered-nested-run',
      resolveWorkflow,
    });

    expect(first.result).toEqual([
      'ordered-parent/canonical-child@0.0.0',
      'ordered-parent/canonical-child@0.1.0',
    ]);
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(2);
    expect(runner.calls).toHaveLength(2);
  });

  it('runs child workflows concurrently in parallel branches', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('concurrent-child')}
return agent(args.prompt, { role: 'child-worker' })
`);
    let active = 0;
    let maximum = 0;
    const runner = new ScriptedHarnessRunner(async (call) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return call.prompt;
    });
    const result = await runWorkflow(
      `${meta('concurrent-parent')}
return parallel([
  () => workflow('concurrent-child', { prompt: 'first' }),
  () => workflow('concurrent-child', { prompt: 'second' }),
])
`,
      {
        runner,
        concurrency: 2,
        resolveWorkflow: registry.resolve.bind(registry),
      },
    );

    expect(result.result).toEqual(['first', 'second']);
    expect(maximum).toBe(2);
  });

  it('runs child workflows concurrently across pipeline items', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('pipeline-child')}
return agent(args.prompt, { role: 'pipeline-child-worker' })
`);
    let active = 0;
    let maximum = 0;
    const runner = new ScriptedHarnessRunner(async (call) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return call.prompt;
    });
    const result = await runWorkflow(
      `${meta('pipeline-parent')}
return pipeline(['first', 'second'], (prompt) => workflow('pipeline-child', { prompt }))
`,
      {
        runner,
        concurrency: 2,
        resolveWorkflow: registry.resolve.bind(registry),
      },
    );

    expect(result.result).toEqual(['first', 'second']);
    expect(maximum).toBe(2);
  });

  it('does not deadlock a child behind an earlier branch waiting for its side effect', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('gate-child')}
log('child ran')
return 'child result'
`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    try {
      const result = await runWorkflow(
        `${meta('gate-parent')}
let releaseGate
const gate = new Promise((resolve) => { releaseGate = resolve })
return parallel([
  async () => {
    await gate
    return 'gate released'
  },
  async () => {
    const child = await workflow('gate-child')
    releaseGate()
    return child
  },
])
`,
        {
          runner: new ScriptedHarnessRunner(() => 'never'),
          resolveWorkflow: registry.resolve.bind(registry),
          signal: controller.signal,
        },
      );

      expect(result.result).toEqual(['gate released', 'child result']);
      expect(result.logs).toEqual(['child ran']);
    } finally {
      clearTimeout(timeout);
    }
  });

  it('replays nested identities after asynchronous parallel preparation', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('prepared-child')}
return agent('child', { role: 'child-worker' })
`);
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('prepared-parent')}
return parallel([
  async () => {
    await agent('slow preparation', { role: 'preparer' })
    return workflow('prepared-child')
  },
  async () => {
    await agent('fast preparation', { role: 'preparer' })
    return workflow('prepared-child')
  },
])
`;
    const runner = new ScriptedHarnessRunner(async (call) => {
      if (call.role === 'preparer') {
        await new Promise((resolve) =>
          setTimeout(resolve, call.prompt.startsWith('slow') ? 15 : 0),
        );
      }
      return call.workflowPath;
    });
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'prepared-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'prepared-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });

    expect(first.result).toEqual([
      'prepared-parent/prepared-child@0.0.1',
      'prepared-parent/prepared-child@0.1.1',
    ]);
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(4);
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls.slice(2).map((call) => call.workflowPath)).toEqual([
      'prepared-parent/prepared-child@0.1.1',
      'prepared-parent/prepared-child@0.0.1',
    ]);
  });

  it('replays nested child calls when parallel preparation arrival order changes', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('arrival-child')}
return agent('child', { role: 'child-worker' })
`);
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('arrival-parent')}
return parallel([
  async () => {
    await new Promise((resolve) => setTimeout(resolve, args.firstDelay))
    return workflow('arrival-child')
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, args.secondDelay))
    return workflow('arrival-child')
  },
])
`;
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'arrival-order-run',
      args: { firstDelay: 20, secondDelay: 0 },
      resolveWorkflow: registry.resolve.bind(registry),
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'arrival-order-run',
      args: { firstDelay: 0, secondDelay: 20 },
      resolveWorkflow: registry.resolve.bind(registry),
    });

    expect(first.result).toEqual([
      'arrival-parent/arrival-child@0.0.0',
      'arrival-parent/arrival-child@0.1.0',
    ]);
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(2);
    expect(runner.calls).toHaveLength(2);
  });

  it('shares nested invocation identities across name and script aliases', async () => {
    const child = `${meta('canonical-child')}
return agent('same', { role: 'child-worker' })
`;
    const resolveWorkflow = async () => ({ script: child, name: 'canonical-child' });
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('alias-parent')}
const sequential = [
  await workflow('child'),
  await workflow({ scriptPath: './child.ts' }),
]
const parallelResults = await parallel([
  () => workflow('child'),
  () => workflow({ scriptPath: './child.ts' }),
])
return { sequential, parallel: parallelResults }
`;
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'alias-nested-run',
      resolveWorkflow,
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'alias-nested-run',
      resolveWorkflow,
    });

    expect(first.result).toEqual({
      sequential: ['alias-parent/canonical-child', 'alias-parent/canonical-child#2'],
      parallel: ['alias-parent/canonical-child@2.0.0', 'alias-parent/canonical-child@2.1.0'],
    });
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(4);
    expect(runner.calls).toHaveLength(4);
    expect(new Set(runner.calls.map((call) => call.cacheKey)).size).toBe(4);
  });

  it('keeps delimiter-bearing nested workflow names distinct in the journal', async () => {
    const registry = new WorkflowRegistry();
    registry.register(`${meta('child')}
return agent('same', { role: 'child-worker' })
`);
    registry.register(`${meta('child#2')}
return agent('same', { role: 'child-worker' })
`);
    const journal = new InMemoryWorkflowJournal();
    const script = `${meta('delimiter-parent')}
const first = await workflow('child')
const delimiterBearing = await workflow('child#2')
const repeated = await workflow('child')
return { first, delimiterBearing, repeated }
`;
    const runner = new ScriptedHarnessRunner((call) => call.workflowPath);
    const first = await runWorkflow(script, {
      runner,
      journal,
      runId: 'delimiter-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });
    const second = await runWorkflow(script, {
      runner,
      journal,
      runId: 'delimiter-nested-run',
      resolveWorkflow: registry.resolve.bind(registry),
    });

    expect(first.result).toEqual({
      first: 'delimiter-parent/child',
      delimiterBearing: 'delimiter-parent/child%232',
      repeated: 'delimiter-parent/child#2',
    });
    expect(first.cacheHits).toBe(0);
    expect(second.result).toEqual(first.result);
    expect(second.cacheHits).toBe(3);
    expect(runner.calls).toHaveLength(3);
  });

  it('requires every agent call to provide a semantic role', async () => {
    await expect(
      runWorkflow(
        `${meta('missing-role')}
return agent('missing role')
`,
        { runner: new ScriptedHarnessRunner(() => 'never') },
      ),
    ).rejects.toBeInstanceOf(WorkflowInputError);
  });

  it('rejects an unawaited agent call that omits its semantic role', async () => {
    await expect(
      runWorkflow(
        `${meta('unawaited-missing-role')}
agent('missing role')
return { ok: true }
`,
        { runner: new ScriptedHarnessRunner(() => 'never') },
      ),
    ).rejects.toBeInstanceOf(WorkflowInputError);
  });

  it('resolves workflow imports relative to cwd', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dark-kitchen-workflow-import-'));
    try {
      await writeFile(path.join(directory, 'helper.mjs'), `export const prompt = 'from helper';\n`);
      const result = await runWorkflow(
        `${meta('local-import')}
import { prompt } from './helper.mjs'
return agent(prompt, { role: 'imported-helper' })
`,
        {
          cwd: directory,
          runner: new ScriptedHarnessRunner((call) => call.prompt),
        },
      );

      expect(result.result).toBe('from helper');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves dynamic workflow imports relative to cwd', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dark-kitchen-workflow-dynamic-import-'));
    try {
      await writeFile(
        path.join(directory, 'helper.mjs'),
        `export const prompt = 'from dynamic helper';\n`,
      );
      const result = await runWorkflow(
        `${meta('dynamic-local-import')}
const helper = await import('./helper.mjs')
return agent(helper.prompt, { role: 'dynamic-imported-helper' })
`,
        {
          cwd: directory,
          runner: new ScriptedHarnessRunner((call) => call.prompt),
        },
      );

      expect(result.result).toBe('from dynamic helper');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('executes dynamic imports in export default expressions', async () => {
    const result = await runWorkflow(
      `${meta('dynamic-export-default')}
export default await import('node:path')
return typeof __workflow_default_export.join
`,
      { runner: new ScriptedHarnessRunner(() => 'never') },
    );

    expect(result.result).toBe('function');
  });

  it('resolves a nested workflow file and its imports relative to the workflow cwd', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dark-kitchen-nested-workflow-import-'));
    try {
      await writeFile(
        path.join(directory, 'helper.mjs'),
        `export const prompt = 'nested helper';\n`,
      );
      await writeFile(
        path.join(directory, 'child.ts'),
        `${meta('file-child')}\nimport { prompt } from './helper.mjs'\nreturn agent(prompt, { role: 'nested-import' })\n`,
      );
      const registry = new WorkflowRegistry();
      const result = await runWorkflow(
        `${meta('file-parent')}\nreturn workflow({ scriptPath: './child.ts' })\n`,
        {
          cwd: directory,
          runner: new ScriptedHarnessRunner((call) => call.prompt),
          resolveWorkflow: registry.resolve.bind(registry),
        },
      );

      expect(result.result).toBe('nested helper');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels a nested workflow with a hanging resolver', async () => {
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const resolveWorkflow = async () => {
      startedResolve?.();
      return new Promise<never>(() => {});
    };
    const pending = runWorkflow(
      `${meta('hanging-resolver')}
return workflow('child')
`,
      {
        runner: new ScriptedHarnessRunner(() => 'never'),
        resolveWorkflow,
        signal: controller.signal,
      },
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
  });

  it('cancels workflow code waiting on a local promise without starting a runner', async () => {
    const controller = new AbortController();
    const runner = new ScriptedHarnessRunner(() => 'should not run');
    const pending = runWorkflow(
      `${meta('local-hang')}
return await new Promise(() => {})
`,
      { runner, signal: controller.signal },
    );

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
    expect(runner.calls).toHaveLength(0);
  });

  it('cancels a hanging pipeline stage without starting a runner', async () => {
    const controller = new AbortController();
    const runner = new ScriptedHarnessRunner(() => 'should not run');
    const pending = runWorkflow(
      `${meta('pipeline-hang')}
return pipeline([1], async () => new Promise(() => {}))
`,
      { runner, signal: controller.signal },
    );

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
    expect(runner.calls).toHaveLength(0);
  });

  it('does not start a nested workflow after cancellation releases its resolver', async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    let releaseResolver: (() => void) | undefined;
    let resolverStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    const resolveWorkflow = async () => {
      resolverStarted?.();
      await new Promise<void>((resolve) => {
        releaseResolver = resolve;
      });
      return {
        script: `${meta('released-child')}
return agent('child side effect', { role: 'child-worker' })
`,
        name: 'released-child',
      };
    };
    let childStarted = false;
    const runner = new ScriptedHarnessRunner(() => {
      childStarted = true;
      return 'should not run';
    });
    const pending = runWorkflow(
      `${meta('released-parent')}
return workflow('released-child')
`,
      {
        runner,
        resolveWorkflow,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'log') logs.push(event.message);
        },
      },
    );

    await started;
    controller.abort();
    releaseResolver?.();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
    await Promise.resolve();
    expect(childStarted).toBe(false);
    expect(logs).not.toContain('child ran');
  });

  it('normalizes optional null structured fields before validation', async () => {
    const result = await runWorkflow(
      `${meta('optional-null')}
return agent('structured', {
  role: 'structured-worker',
  schema: {
    type: 'object',
    properties: { required: { type: 'string' }, optional: { type: 'string' } },
    required: ['required'],
  },
})
`,
      {
        runner: new ScriptedHarnessRunner(() => ({ required: 'ok', optional: null })),
      },
    );

    expect(result.result).toEqual({ required: 'ok' });
    expect(result.failures).toEqual([]);
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

  it('does not wait for a runner that ignores cancellation', async () => {
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const runner = new ScriptedHarnessRunner(
      () =>
        new Promise<never>(() => {
          startedResolve?.();
        }),
    );
    const pending = runWorkflow(
      `${meta('uncancellable')}
return agent('long task', { role: 'uncancellable-worker' })
`,
      { runner, signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortError);
  });

  it('cancels fire-and-forget agents during successful teardown without unhandled rejection', async () => {
    let started = false;
    let aborted = false;
    const runner = new ScriptedHarnessRunner(
      (_call, signal) =>
        new Promise<never>((_resolve, reject) => {
          started = true;
          const onAbort = () => {
            aborted = true;
            reject(new Error('aborted'));
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );

    const result = await runWorkflow(
      `${meta('fire-and-forget')}
agent('long running', { role: 'leak' })
return { ok: true }
`,
      { runner },
    );

    expect(result.result).toEqual({ ok: true });
    expect(started).toBe(true);
    expect(aborted).toBe(true);
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
