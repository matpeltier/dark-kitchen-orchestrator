import { describe, it, expect } from 'vitest';
import {
  runWorkflow,
  WorkflowCancelledError,
  WorkflowAgentError,
  MissingRoleError,
  WorkflowConfigurationError,
  InMemoryJournal,
  type RoleResolver,
  type HarnessRunner,
  type WorkflowFn,
} from './index.js';

function makeResolver(runners: Record<string, HarnessRunner>): RoleResolver {
  return (role) => {
    const runner = runners[role];
    if (!runner) throw new Error(`No runner for role "${role}"`);
    return runner;
  };
}

function echoRunner(role: string): HarnessRunner {
  return async (input) => `${role}:${input.prompt}`;
}

function failingRunner(message: string): HarnessRunner {
  return async () => {
    throw new Error(message);
  };
}

function _hangingRunner(): HarnessRunner {
  return async (_input, signal) =>
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

const defaultOptions = () => ({
  runId: 'run-1',
  journal: new InMemoryJournal(),
  resolver: makeResolver({ impl: echoRunner('impl') }),
});

// ─── Basic agent calls ────────────────────────────────────────────────────────

describe('agent()', () => {
  it('calls the runner and returns the result', async () => {
    const result = await runWorkflow(async (b) => {
      return b.agent({ role: 'impl', prompt: 'hello' });
    }, defaultOptions());
    expect(result.result).toBe('impl:hello');
    expect(result.role).toBe('impl');
  });

  it('throws MissingRoleError when role is omitted', async () => {
    await expect(
      runWorkflow(async (b) => {
        return b.agent({ role: '' as string, prompt: 'x' });
      }, defaultOptions()),
    ).rejects.toBeInstanceOf(MissingRoleError);
  });

  it('replays from journal on second run', async () => {
    const journal = new InMemoryJournal();
    const callCount = { n: 0 };
    const resolver = makeResolver({
      impl: async () => {
        callCount.n++;
        return 'first-result';
      },
    });

    await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'p' }), {
      runId: 'run-1',
      journal,
      resolver,
    });
    await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'p' }), {
      runId: 'run-1',
      journal,
      resolver,
    });

    expect(callCount.n).toBe(1); // only called once; second run replayed
  });

  it('replays a cached undefined result when the journal supports presence probes', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const resolver = makeResolver({
      impl: async () => {
        calls++;
        return undefined;
      },
    });
    const workflow = async (b: import('./engine.js').WorkflowBuilder) =>
      b.agent({ role: 'impl', prompt: 'undefined is still a result' });

    await runWorkflow(workflow, { runId: 'undefined-cache', journal, resolver });
    await runWorkflow(workflow, { runId: 'undefined-cache', journal, resolver });

    expect(calls).toBe(1);
  });
});

// ─── parallel() ───────────────────────────────────────────────────────────────

describe('parallel()', () => {
  it('runs tasks in parallel and returns in-order results', async () => {
    const results = await runWorkflow(async (b) => {
      return b.parallel([
        async (cb) => cb.agent({ role: 'impl', prompt: 'a' }),
        async (cb) => cb.agent({ role: 'impl', prompt: 'b' }),
        async (cb) => cb.agent({ role: 'impl', prompt: 'c' }),
      ]);
    }, defaultOptions());
    expect(results[0]?.result).toBe('impl:a');
    expect(results[1]?.result).toBe('impl:b');
    expect(results[2]?.result).toBe('impl:c');
  });

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const resolver = makeResolver({
      impl: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return 'ok';
      },
    });
    await runWorkflow(
      async (b) => {
        return b.parallel(
          Array.from(
            { length: 6 },
            (_, i) => async (cb: typeof b) => cb.agent({ role: 'impl', prompt: String(i) }),
          ),
          { concurrency: 2 },
        );
      },
      { runId: 'r', journal: new InMemoryJournal(), resolver },
    );
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('parallel branches get stable positional keys for replay', async () => {
    const journal = new InMemoryJournal();
    const callLog: string[] = [];
    const resolver = makeResolver({
      impl: async (input) => {
        callLog.push(input.prompt);
        return `result:${input.prompt}`;
      },
    });
    const opts = { runId: 'run-keys', journal, resolver };

    await runWorkflow(async (b) => {
      return b.parallel([
        async (cb) => cb.agent({ role: 'impl', prompt: 'x' }),
        async (cb) => cb.agent({ role: 'impl', prompt: 'y' }),
      ]);
    }, opts);

    const firstCallLog = [...callLog];
    callLog.length = 0;

    // Second run: journal should replay everything
    await runWorkflow(async (b) => {
      return b.parallel([
        async (cb) => cb.agent({ role: 'impl', prompt: 'x' }),
        async (cb) => cb.agent({ role: 'impl', prompt: 'y' }),
      ]);
    }, opts);

    expect(callLog).toHaveLength(0); // all replayed
    expect(firstCallLog).toHaveLength(2);
  });
});

// ─── pipeline() ───────────────────────────────────────────────────────────────

describe('pipeline()', () => {
  it('passes result of each step to the next', async () => {
    const result = await runWorkflow(async (b) => {
      return b.pipeline(1, [async (v) => v + 1, async (v) => v * 3, async (v) => v - 1]);
    }, defaultOptions());
    expect(result).toBe(5); // ((1+1)*3)-1
  });
});

// ─── workflow() nesting ───────────────────────────────────────────────────────

describe('nested workflow()', () => {
  it('runs a child workflow', async () => {
    const child: WorkflowFn<string> = async (b) => {
      const out = await b.agent({ role: 'impl', prompt: 'child' });
      return String(out.result);
    };
    const result = await runWorkflow(async (b) => {
      return b.workflow('child', child);
    }, defaultOptions());
    expect(result).toBe('impl:child');
  });

  it('repeated nested calls have distinct stable keys', async () => {
    const journal = new InMemoryJournal();
    const calls: string[] = [];
    const resolver = makeResolver({
      impl: async (input) => {
        calls.push(input.prompt);
        return input.prompt;
      },
    });

    const child: WorkflowFn<string> = async (b) => {
      const out = await b.agent({ role: 'impl', prompt: 'step' });
      return String(out.result);
    };

    await runWorkflow(
      async (b) => {
        // Two sequential calls of the same child workflow
        const r1 = await b.workflow('child', child);
        const r2 = await b.workflow('child', child);
        return [r1, r2];
      },
      { runId: 'nested-keys', journal, resolver },
    );

    // Replay
    calls.length = 0;
    await runWorkflow(
      async (b) => {
        const r1 = await b.workflow('child', child);
        const r2 = await b.workflow('child', child);
        return [r1, r2];
      },
      { runId: 'nested-keys', journal, resolver },
    );

    expect(calls).toHaveLength(0); // all replayed
  });

  it('parallel branches with async readiness get stable child keys', async () => {
    const journal = new InMemoryJournal();
    const callOrder: string[] = [];
    const resolver = makeResolver({
      impl: async (input) => {
        callOrder.push(input.prompt);
        return input.prompt;
      },
    });

    const child: WorkflowFn<string> = async (b) => {
      const out = await b.agent({ role: 'impl', prompt: 'step' });
      return String(out.result);
    };

    const makeFactory =
      (delayMs: number, name: string) => async (b: import('./engine.js').WorkflowBuilder) => {
        // Simulate async preparation before child workflow invocation
        await new Promise((r) => setTimeout(r, delayMs));
        return b.workflow(name, child);
      };

    await runWorkflow(
      async (b) => {
        return b.parallel([makeFactory(20, 'child'), makeFactory(0, 'child')]);
      },
      { runId: 'parallel-stable', journal, resolver },
    );

    callOrder.length = 0;
    await runWorkflow(
      async (b) => {
        return b.parallel([makeFactory(20, 'child'), makeFactory(0, 'child')]);
      },
      { runId: 'parallel-stable', journal, resolver },
    );

    expect(callOrder).toHaveLength(0); // all from journal
  });
});

// ─── Retry ────────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('retries on failure', async () => {
    let attempts = 0;
    const resolver = makeResolver({
      impl: async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
    });
    const result = await runWorkflow(
      async (b) => {
        return b.agent({ role: 'impl', prompt: 'x', retryPolicy: { maxAttempts: 3 } });
      },
      { runId: 'r', journal: new InMemoryJournal(), resolver },
    );
    expect(result.result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting retries', async () => {
    const resolver = makeResolver({ impl: failingRunner('always fails') });
    await expect(
      runWorkflow(
        async (b) => {
          return b.agent({ role: 'impl', prompt: 'x', retryPolicy: { maxAttempts: 2 } });
        },
        { runId: 'r', journal: new InMemoryJournal(), resolver },
      ),
    ).rejects.toBeInstanceOf(WorkflowAgentError);
  });
});

// ─── In-flight checkpoints ────────────────────────────────────────────────────

describe('in-flight checkpoints', () => {
  it('clears the in-flight entry after a successful step', async () => {
    const journal = new InMemoryJournal();
    let checkpointDuringRun: unknown = 'unset';
    const resolver = makeResolver({
      impl: async (input) => {
        await input.onCheckpoint?.({ sessionKey: 's-1' });
        checkpointDuringRun = await journal.getInFlight('run-ckpt/agent:impl');
        return 'ok';
      },
    });

    const result = await runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
      runId: 'run-ckpt',
      journal,
      resolver,
    });

    expect(result.result).toBe('ok');
    expect(checkpointDuringRun).toEqual({ sessionKey: 's-1' });
    expect(await journal.getInFlight('run-ckpt/agent:impl')).toBeUndefined();
  });

  it('offers a stored checkpoint to the first attempt only and purges it once consumed', async () => {
    const journal = new InMemoryJournal();
    await journal.markInFlight('run-resume/agent:impl', { sessionKey: 'interrupted' });
    const seenCheckpoints: unknown[] = [];
    let attempts = 0;
    const resolver = makeResolver({
      impl: async (input) => {
        attempts++;
        seenCheckpoints.push(input.resumeCheckpoint);
        if (attempts < 2) throw new Error('transient');
        return 'ok';
      },
    });

    const result = await runWorkflow(
      async (b) => b.agent({ role: 'impl', prompt: 'x', retryPolicy: { maxAttempts: 2 } }),
      { runId: 'run-resume', journal, resolver },
    );

    expect(result.result).toBe('ok');
    expect(seenCheckpoints).toEqual([{ sessionKey: 'interrupted' }, undefined]);
    expect(await journal.getInFlight('run-resume/agent:impl')).toBeUndefined();
  });

  it('purges the in-flight entry on definitive failure', async () => {
    const journal = new InMemoryJournal();
    const resolver = makeResolver({
      impl: async (input) => {
        await input.onCheckpoint?.({ sessionKey: 'doomed' });
        throw new Error('fatal');
      },
    });

    await expect(
      runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
        runId: 'run-fail',
        journal,
        resolver,
      }),
    ).rejects.toBeInstanceOf(WorkflowAgentError);

    expect(await journal.getInFlight('run-fail/agent:impl')).toBeUndefined();
  });

  it('purges the in-flight entry on cancellation', async () => {
    const controller = new AbortController();
    const journal = new InMemoryJournal();
    const resolver = makeResolver({
      impl: async (input, signal) => {
        await input.onCheckpoint?.({ sessionKey: 'cancelled-session' });
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    const promise = runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
      runId: 'run-cancel-ckpt',
      journal,
      resolver,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(await journal.getInFlight('run-cancel-ckpt/agent:impl')).toBeUndefined();
  });
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

describe('cancellation', () => {
  it('cancels promptly even when runner ignores the signal', async () => {
    const controller = new AbortController();
    const slowRunner: HarnessRunner = async () => {
      // Does not cooperate with signal — just hangs for 2 seconds
      await new Promise((r) => setTimeout(r, 2000));
      return 'too late';
    };
    const resolver = makeResolver({ impl: slowRunner });

    const start = Date.now();
    const promise = runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
      runId: 'r',
      journal: new InMemoryJournal(),
      resolver,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('cancels a run-level signal covering all workflow code', async () => {
    const controller = new AbortController();
    let _sideEffect = false;

    const promise = runWorkflow(
      async (_b) => {
        // Workflow code awaiting a local promise with no runner call
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        });
        _sideEffect = true;
        return 'should not reach';
      },
      {
        runId: 'r',
        journal: new InMemoryJournal(),
        resolver: makeResolver({}),
        signal: controller.signal,
      },
    );

    // The workflow awaits a plain local promise — signal should still cancel it
    setTimeout(() => controller.abort(), 30);

    // The workflow has no runner calls; it just awaits a timer.
    // The cancel may not fire instantly since the workflow code awaits an opaque promise.
    // What matters: after signal fires the workflow eventually rejects as cancelled.
    await expect(promise).rejects.toBeInstanceOf(WorkflowCancelledError);
  });

  it('never invokes a runner returned by a resolver that settles after cancellation', async () => {
    const controller = new AbortController();
    let runnerCalls = 0;
    let resolveRunner!: (runner: HarnessRunner) => void;
    const resolver: RoleResolver = () =>
      new Promise<HarnessRunner>((resolve) => {
        resolveRunner = resolve;
      });
    const promise = runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
      runId: 'cancel-resolver',
      journal: new InMemoryJournal(),
      resolver,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(WorkflowCancelledError);
    resolveRunner(async () => {
      runnerCalls++;
      return 'late';
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(runnerCalls).toBe(0);
  });

  it('does not execute child workflow after cancellation', async () => {
    const controller = new AbortController();
    const childLog: string[] = [];

    const child: WorkflowFn<void> = async (b) => {
      await b.agent({ role: 'impl', prompt: 'child-step' });
      childLog.push('child-ran');
    };

    const resolver = makeResolver({
      impl: async (_input, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new WorkflowCancelledError()), {
            once: true,
          }),
        ),
    });

    const promise = runWorkflow(
      async (b) => {
        // Enter a sub-workflow; runner will hang until abort
        await b.workflow('child', child);
        // This should not be reached after cancellation
        await b.workflow('child', child);
      },
      {
        runId: 'r',
        journal: new InMemoryJournal(),
        resolver,
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(childLog).toHaveLength(0);
  });
});

// ─── Concurrency cap ──────────────────────────────────────────────────────────

describe('concurrency cap', () => {
  it('respects global concurrency limit from runWorkflow options', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const resolver = makeResolver({
      impl: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return 'done';
      },
    });
    await runWorkflow(
      async (b) => {
        return b.parallel(
          Array.from(
            { length: 10 },
            (_, i) => async (cb: typeof b) => cb.agent({ role: 'impl', prompt: String(i) }),
          ),
        );
      },
      { runId: 'r', journal: new InMemoryJournal(), resolver, concurrency: 3 },
    );
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('shares the global cap across nested parallel groups', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const resolver = makeResolver({
      impl: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return 'done';
      },
    });

    await runWorkflow(
      async (b) =>
        b.parallel(
          Array.from(
            { length: 3 },
            () => async (outer) =>
              outer.parallel(
                Array.from(
                  { length: 3 },
                  () => async (inner) => inner.agent({ role: 'impl', prompt: 'nested' }),
                ),
              ),
          ),
        ),
      { runId: 'nested-cap', journal: new InMemoryJournal(), resolver, concurrency: 2 },
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('rejects zero or non-integer concurrency instead of returning partial results', async () => {
    await expect(
      runWorkflow(async () => 'never', { ...defaultOptions(), concurrency: 0 }),
    ).rejects.toBeInstanceOf(WorkflowConfigurationError);
    await expect(
      runWorkflow(async (b) => b.parallel([async () => 'never'], { concurrency: 1.5 }), {
        ...defaultOptions(),
      }),
    ).rejects.toBeInstanceOf(WorkflowConfigurationError);
  });
});

// ─── Stable call keys ─────────────────────────────────────────────────────────

describe('stable call keys', () => {
  it('sequential calls of the same agent get different keys', async () => {
    const keys: string[] = [];
    const resolver = makeResolver({
      impl: async (_input, _signal) => {
        return 'r';
      },
    });
    const journal = new InMemoryJournal();
    await runWorkflow(
      async (b) => {
        const r1 = await b.agent({ role: 'impl', prompt: '1' });
        const r2 = await b.agent({ role: 'impl', prompt: '2' });
        keys.push(r1.callKey, r2.callKey);
        return null;
      },
      { runId: 'keys', journal, resolver },
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('repeated phases with the same name receive distinct stable scopes', async () => {
    const journal = new InMemoryJournal();
    const keys: string[] = [];
    await runWorkflow(
      async (b) => {
        keys.push((await b.phase('review').agent({ role: 'impl', prompt: 'first' })).callKey);
        keys.push((await b.phase('review').agent({ role: 'impl', prompt: 'second' })).callKey);
      },
      { runId: 'phase-keys', journal, resolver: defaultOptions().resolver },
    );

    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe('phase-keys/phase:review/agent:impl');
    expect(keys[1]).toBe('phase-keys/phase:review[1]/agent:impl');
  });

  it('emits a complete progress protocol including terminal step errors', async () => {
    const events: string[] = [];
    await expect(
      runWorkflow(async (b) => b.agent({ role: 'impl', prompt: 'x' }), {
        runId: 'progress',
        journal: new InMemoryJournal(),
        resolver: makeResolver({ impl: failingRunner('failure') }),
        onProgress: (event) => events.push(event.kind),
      }),
    ).rejects.toBeInstanceOf(WorkflowAgentError);

    expect(events).toEqual(['workflow.start', 'step.start', 'step.error']);
  });
});
