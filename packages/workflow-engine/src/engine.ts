/**
 * Dark Kitchen Workflow Engine
 *
 * Adapted from concepts in six-ddc/codex-dynamic-workflows (MIT License).
 * Original: https://github.com/six-ddc/codex-dynamic-workflows
 * Changes: removed provider enums (codex|gemini|pi) and OpenAI/Codex SDK;
 * replaced with generic HarnessRunner/RoleResolver contract; added stable
 * deterministic call keys, structured cancellation, and typed journal replay.
 *
 * MIT License — see NOTICE.md for full attribution.
 */

import type {
  AgentCallOutput,
  AgentStepOptions,
  HarnessRunner,
  JournalStore,
  ParallelOptions,
  ProgressEvent,
  RetryPolicy,
  RoleResolver,
  WorkflowContext,
  WorkflowStepOptions,
  WorkflowStepResult,
} from './types.js';
import { CANCELLED } from './types.js';
import { buildCallKey, childKeyContext, rootKeyContext, type KeyContext } from './keys.js';

export class WorkflowCancelledError extends Error {
  public constructor(message = 'Workflow cancelled') {
    super(message);
    this.name = 'WorkflowCancelledError';
  }
}

export class WorkflowAgentError extends Error {
  public readonly role: string;
  public readonly callKey: string;
  public constructor(message: string, role: string, callKey: string) {
    super(message);
    this.name = 'WorkflowAgentError';
    this.role = role;
    this.callKey = callKey;
  }
}

export class MissingRoleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MissingRoleError';
  }
}

// ─── Runner API ───────────────────────────────────────────────────────────────

/** A workflow definition function receives a builder and returns a result. */
export type WorkflowFn<T> = (builder: WorkflowBuilder) => Promise<T>;

export interface RunWorkflowOptions {
  readonly runId: string;
  readonly resolver: RoleResolver;
  readonly journal: JournalStore;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly concurrency?: number;
}

/**
 * Execute a workflow function. Returns the workflow's return value.
 * Throws `WorkflowCancelledError` if the signal fires.
 */
export async function runWorkflow<T>(
  fn: WorkflowFn<T>,
  options: RunWorkflowOptions,
): Promise<T> {
  const controller = new AbortController();
  const combinedSignal = options.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const ctx: WorkflowContext = {
    runId: options.runId,
    signal: combinedSignal,
    journal: options.journal,
    resolver: options.resolver,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  };

  const keyCtx = rootKeyContext(options.runId);
  const builder = new WorkflowBuilder(ctx, keyCtx, options.concurrency ?? 8);

  // Race the entire workflow fn against the signal so the run is cancelled
  // promptly even when workflow code is awaiting opaque local promises.
  const signalPromise = new Promise<never>((_, reject) => {
    if (combinedSignal.aborted) {
      reject(new WorkflowCancelledError());
      return;
    }
    combinedSignal.addEventListener(
      'abort',
      () => reject(new WorkflowCancelledError()),
      { once: true },
    );
  });

  try {
    const result = await Promise.race([fn(builder), signalPromise]);
    options.onProgress?.({ kind: 'workflow.complete', callKey: options.runId });
    return result;
  } catch (err) {
    if (combinedSignal.aborted || err instanceof WorkflowCancelledError) {
      options.onProgress?.({ kind: 'workflow.cancel', callKey: options.runId });
      throw new WorkflowCancelledError();
    }
    throw err;
  } finally {
    controller.abort();
  }
}

// ─── WorkflowBuilder ─────────────────────────────────────────────────────────

export class WorkflowBuilder {
  private readonly ctx: WorkflowContext;
  private readonly keyCtx: KeyContext;
  private readonly maxConcurrency: number;
  // Counter per local segment for stable sequential numbering
  private readonly callCounters = new Map<string, number>();

  public constructor(ctx: WorkflowContext, keyCtx: KeyContext, maxConcurrency: number) {
    this.ctx = ctx;
    this.keyCtx = keyCtx;
    this.maxConcurrency = maxConcurrency;
  }

  /** Call a semantic agent role. Requires an explicit `role`; no fallback. */
  public async agent(options: AgentStepOptions): Promise<AgentCallOutput> {
    if (!options.role || options.role.trim().length === 0) {
      throw new MissingRoleError('agent() requires an explicit non-empty role.');
    }
    const callKey = this.nextKey(`agent:${options.role}`);
    return this.runAgentStep(options, callKey);
  }

  /**
   * Run multiple steps in parallel with optional concurrency limit.
   * Results are returned in the same order as the input factories.
   * Each factory receives a child builder with a stable positional key.
   */
  public async parallel<T>(
    factories: ReadonlyArray<(builder: WorkflowBuilder) => Promise<T>>,
    options?: ParallelOptions,
  ): Promise<T[]> {
    const limit = options?.concurrency ?? this.maxConcurrency;
    const parallelKey = this.nextKey('parallel');
    const results: T[] = new Array(factories.length);

    // Build child builders with stable positional keys BEFORE any async work
    const childBuilders = factories.map((_, i) => {
      const branchKey = childKeyContext(this.keyCtx, `${parallelKey}/branch:${i}`);
      return new WorkflowBuilder(this.ctx, branchKey, this.maxConcurrency);
    });

    let index = 0;
    const run = async (): Promise<void> => {
      while (index < factories.length) {
        if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
        const i = index++;
        const factory = factories[i];
        const builder = childBuilders[i];
        if (!factory || !builder) continue;
        results[i] = await factory(builder);
      }
    };

    const workers = Array.from({ length: Math.min(limit, factories.length) }, () => run());
    await Promise.all(workers);
    return results;
  }

  /**
   * Run steps sequentially in a pipeline.
   * Each step receives the result of the previous step.
   */
  public async pipeline<T>(
    initial: T,
    steps: ReadonlyArray<(value: T, builder: WorkflowBuilder) => Promise<T>>,
  ): Promise<T> {
    const pipelineKey = this.nextKey('pipeline');
    let current = initial;
    for (let i = 0; i < steps.length; i++) {
      if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
      const step = steps[i];
      if (!step) continue;
      const childKey = childKeyContext(this.keyCtx, `${pipelineKey}/step:${i}`);
      const childBuilder = new WorkflowBuilder(this.ctx, childKey, this.maxConcurrency);
      current = await step(current, childBuilder);
    }
    return current;
  }

  /**
   * Execute a nested workflow with a stable invocation identity.
   * Repeated calls to the same child workflow (e.g. in a loop) get distinct
   * stable keys based on their logical call position.
   */
  public async workflow<T>(name: string, fn: WorkflowFn<T>, options?: WorkflowStepOptions): Promise<T> {
    if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
    const callKey = this.nextKey(`workflow:${name}`);
    const childKeyCtx = childKeyContext(this.keyCtx, callKey);
    const childBuilder = new WorkflowBuilder(this.ctx, childKeyCtx, this.maxConcurrency);

    // Check cancellation again after any async readiness boundary
    if (this.ctx.signal.aborted) throw new WorkflowCancelledError();

    return this.withRetry(
      callKey,
      () => fn(childBuilder),
      options?.retryPolicy,
    );
  }

  /**
   * Returns a child builder for a named phase (logging/scoping only).
   * Does not affect execution semantics.
   */
  public phase(name: string): WorkflowBuilder {
    const childKey = childKeyContext(this.keyCtx, `phase:${name}`);
    return new WorkflowBuilder(this.ctx, childKey, this.maxConcurrency);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private nextKey(localId: string): string {
    const count = this.callCounters.get(localId) ?? 0;
    this.callCounters.set(localId, count + 1);
    const uniqueLocal = count === 0 ? localId : `${localId}[${count}]`;
    return buildCallKey(this.keyCtx, uniqueLocal);
  }

  private async runAgentStep(
    options: AgentStepOptions,
    callKey: string,
  ): Promise<AgentCallOutput> {
    // Replay from journal if available
    const cached = await this.ctx.journal.get(callKey);
    if (cached !== undefined) {
      return { role: options.role, result: cached, callKey };
    }

    const runner = this.ctx.resolver(options.role);

    return this.withRetry(
      callKey,
      async () => {
        if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
        this.ctx.onProgress?.({ kind: 'step.start', callKey, role: options.role });

        let result: unknown;
        try {
          const callInput = options.context !== undefined
            ? { role: options.role, prompt: options.prompt, context: options.context }
            : { role: options.role, prompt: options.prompt };
          result = await raceWithSignal(
            runner(callInput, this.ctx.signal),
            this.ctx.signal,
          );
        } catch (err) {
          if (this.ctx.signal.aborted || err instanceof WorkflowCancelledError) {
            throw new WorkflowCancelledError();
          }
          throw new WorkflowAgentError(
            `Agent role "${options.role}" failed: ${String(err)}`,
            options.role,
            callKey,
          );
        }

        await this.ctx.journal.set(callKey, result);
        this.ctx.onProgress?.({ kind: 'step.complete', callKey, role: options.role });
        return { role: options.role, result, callKey } as AgentCallOutput;
      },
      options.retryPolicy,
    );
  }

  private async withRetry<T>(
    callKey: string,
    fn: () => Promise<T>,
    retryPolicy?: RetryPolicy,
  ): Promise<T> {
    const maxAttempts = retryPolicy?.maxAttempts ?? 1;
    const delayMs = retryPolicy?.delayMs ?? 0;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof WorkflowCancelledError) throw err;
        if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
        lastErr = err;
        this.ctx.onProgress?.({ kind: 'step.retry', callKey, attempt, error: err });
        if (attempt < maxAttempts && delayMs > 0) {
          await delay(delayMs, this.ctx.signal);
        }
      }
    }
    throw lastErr;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/** Race a promise against an AbortSignal. Throws WorkflowCancelledError on abort. */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new WorkflowCancelledError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WorkflowCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e as unknown); },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new WorkflowCancelledError()); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new WorkflowCancelledError()); }, { once: true });
  });
}
