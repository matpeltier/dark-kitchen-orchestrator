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
  JournalStore,
  ParallelOptions,
  ProgressEvent,
  RetryPolicy,
  RoleResolver,
  WorkflowContext,
  WorkflowStepOptions,
} from './types.js';
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
  /** Structured classification from the underlying harness error, if any. */
  public readonly failureKind?: FailureKind;
  public constructor(message: string, role: string, callKey: string, failureKind?: FailureKind) {
    super(message);
    this.name = 'WorkflowAgentError';
    this.role = role;
    this.callKey = callKey;
    if (failureKind !== undefined) this.failureKind = failureKind;
  }
}

/** Structured failure classification, mirroring @dark-kitchen/core's kind. */
export type FailureKind = 'auth' | 'quota' | 'rate-limit' | 'merge-conflict' | 'agent-failure';

/**
 * Extract a structured failure kind from an underlying error without coupling
 * the engine to concrete harness error classes: harnesses expose their
 * classification as a `kind` string property (e.g. AcpClassifiedError).
 */
export function extractFailureKind(error: unknown): FailureKind | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (
    kind === 'auth' ||
    kind === 'quota' ||
    kind === 'rate-limit' ||
    kind === 'merge-conflict' ||
    kind === 'agent-failure'
  ) {
    return kind;
  }
  return undefined;
}

export class MissingRoleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MissingRoleError';
  }
}

export class WorkflowConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkflowConfigurationError';
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
export async function runWorkflow<T>(fn: WorkflowFn<T>, options: RunWorkflowOptions): Promise<T> {
  const concurrency = options.concurrency ?? 8;
  assertPositiveInteger(concurrency, 'Workflow concurrency');

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
  const limiter = new AsyncSemaphore(concurrency);
  const builder = new WorkflowBuilder(ctx, keyCtx, concurrency, limiter);

  try {
    options.onProgress?.({ kind: 'workflow.start', callKey: options.runId });
    // Race the complete workflow body, including code outside engine
    // primitives, so cancellation is prompt even for opaque local awaits.
    const result = await raceWithSignal(
      Promise.resolve().then(() => fn(builder)),
      combinedSignal,
    );
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
  private readonly limiter: AsyncSemaphore;
  // Counter per local segment for stable sequential numbering
  private readonly callCounters = new Map<string, number>();

  public constructor(
    ctx: WorkflowContext,
    keyCtx: KeyContext,
    maxConcurrency: number,
    limiter: AsyncSemaphore = new AsyncSemaphore(maxConcurrency),
  ) {
    this.ctx = ctx;
    this.keyCtx = keyCtx;
    this.maxConcurrency = maxConcurrency;
    this.limiter = limiter;
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
    const requestedLimit = options?.concurrency ?? this.maxConcurrency;
    assertPositiveInteger(requestedLimit, 'Parallel concurrency');
    const limit = Math.min(requestedLimit, this.maxConcurrency);
    const parallelSegment = this.nextSegment('parallel');
    const results: T[] = new Array(factories.length);

    // Build child builders with stable positional keys BEFORE any async work
    const childBuilders = factories.map((_, i) => {
      const branchKey = childKeyContext(this.keyCtx, `${parallelSegment}/branch:${i}`);
      return new WorkflowBuilder(this.ctx, branchKey, this.maxConcurrency, this.limiter);
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
    const pipelineSegment = this.nextSegment('pipeline');
    let current = initial;
    for (let i = 0; i < steps.length; i++) {
      if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
      const step = steps[i];
      if (!step) continue;
      const childKey = childKeyContext(this.keyCtx, `${pipelineSegment}/step:${i}`);
      const childBuilder = new WorkflowBuilder(
        this.ctx,
        childKey,
        this.maxConcurrency,
        this.limiter,
      );
      current = await step(current, childBuilder);
    }
    return current;
  }

  /**
   * Execute a nested workflow with a stable invocation identity.
   * Repeated calls to the same child workflow (e.g. in a loop) get distinct
   * stable keys based on their logical call position.
   */
  public async workflow<T>(
    name: string,
    fn: WorkflowFn<T>,
    options?: WorkflowStepOptions,
  ): Promise<T> {
    if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
    const invocationSegment = this.nextSegment(`workflow:${name}`);
    const callKey = buildCallKey(this.keyCtx, invocationSegment);
    const childKeyCtx = childKeyContext(this.keyCtx, invocationSegment);
    const childBuilder = new WorkflowBuilder(
      this.ctx,
      childKeyCtx,
      this.maxConcurrency,
      this.limiter,
    );

    // Check cancellation again after any async readiness boundary
    if (this.ctx.signal.aborted) throw new WorkflowCancelledError();

    return this.withRetry(callKey, () => fn(childBuilder), options?.retryPolicy);
  }

  /**
   * Returns a child builder for a named phase (logging/scoping only).
   * Does not affect execution semantics.
   */
  public phase(name: string): WorkflowBuilder {
    const childKey = childKeyContext(this.keyCtx, this.nextSegment(`phase:${name}`));
    return new WorkflowBuilder(this.ctx, childKey, this.maxConcurrency, this.limiter);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private nextKey(localId: string): string {
    return buildCallKey(this.keyCtx, this.nextSegment(localId));
  }

  private nextSegment(localId: string): string {
    const count = this.callCounters.get(localId) ?? 0;
    this.callCounters.set(localId, count + 1);
    return count === 0 ? localId : `${localId}[${count}]`;
  }

  private async runAgentStep(options: AgentStepOptions, callKey: string): Promise<AgentCallOutput> {
    // Replay from journal if available
    const cached = await raceWithSignal(this.ctx.journal.get(callKey), this.ctx.signal);
    const cachedEntryExists =
      cached !== undefined ||
      (this.ctx.journal.has !== undefined &&
        (await raceWithSignal(Promise.resolve(this.ctx.journal.has(callKey)), this.ctx.signal)));
    if (cachedEntryExists) {
      return { role: options.role, result: cached, callKey };
    }

    // An interrupted previous attempt may have persisted a session checkpoint.
    // Offer it to the resolver so a persistent runtime can reattach instead of
    // starting a brand-new session. It is read once per run and consumed by
    // the first attempt only, so retries never replay the same prompt into an
    // already-restored session.
    const storedCheckpoint =
      this.ctx.journal.getInFlight !== undefined
        ? await raceWithSignal(this.ctx.journal.getInFlight(callKey), this.ctx.signal)
        : undefined;
    let checkpointConsumed = false;

    try {
      return await this.withRetry(
        callKey,
        async () => {
          if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
          let result: unknown;
          const release = await this.limiter.acquire(this.ctx.signal);
          try {
            this.ctx.onProgress?.({ kind: 'step.start', callKey, role: options.role });
            const runner = await raceWithSignal(
              Promise.resolve(this.ctx.resolver(options.role)),
              this.ctx.signal,
            );
            // A lazy resolver may settle after cancellation. Never invoke the
            // returned runner unless the workflow is still active.
            if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
            const resumeCheckpoint = checkpointConsumed ? undefined : storedCheckpoint;
            checkpointConsumed = true;
            if (resumeCheckpoint !== undefined && this.ctx.journal.clearInFlight !== undefined) {
              await raceWithSignal(this.ctx.journal.clearInFlight(callKey), this.ctx.signal);
            }
            const callInput = {
              role: options.role,
              prompt: options.prompt,
              ...(options.context !== undefined ? { context: options.context } : {}),
              callKey,
              ...(resumeCheckpoint !== undefined ? { resumeCheckpoint } : {}),
              onCheckpoint: (checkpoint: unknown) =>
                this.ctx.journal.markInFlight?.(callKey, checkpoint),
            };
            result = await raceWithSignal(runner(callInput, this.ctx.signal), this.ctx.signal);
          } catch (err) {
            if (this.ctx.signal.aborted || err instanceof WorkflowCancelledError) {
              throw new WorkflowCancelledError();
            }
            throw new WorkflowAgentError(
              `Agent role "${options.role}" failed: ${String(err)}`,
              options.role,
              callKey,
              extractFailureKind(err),
            );
          } finally {
            release();
          }

          await raceWithSignal(this.ctx.journal.set(callKey, result), this.ctx.signal);
          if (this.ctx.journal.clearInFlight !== undefined) {
            await raceWithSignal(this.ctx.journal.clearInFlight(callKey), this.ctx.signal);
          }
          this.ctx.onProgress?.({ kind: 'step.complete', callKey, role: options.role });
          return { role: options.role, result, callKey } as AgentCallOutput;
        },
        options.retryPolicy,
        options.role,
      );
    } catch (err) {
      // A definitive failure or cancellation ends this run; drop any in-flight
      // checkpoint so a future resume of the same callKey starts fresh instead
      // of restoring a session that contains the failure. Best-effort: never
      // mask the original error.
      if (this.ctx.journal.clearInFlight !== undefined) {
        await Promise.resolve(this.ctx.journal.clearInFlight(callKey)).catch(() => undefined);
      }
      throw err;
    }
  }

  private async withRetry<T>(
    callKey: string,
    fn: () => Promise<T>,
    retryPolicy?: RetryPolicy,
    role?: string,
  ): Promise<T> {
    const maxAttempts = retryPolicy?.maxAttempts ?? 1;
    const delayMs = retryPolicy?.delayMs ?? 0;
    assertPositiveInteger(maxAttempts, 'Retry maxAttempts');
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new WorkflowConfigurationError('Retry delayMs must be a finite non-negative number.');
    }
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof WorkflowCancelledError) throw err;
        if (this.ctx.signal.aborted) throw new WorkflowCancelledError();
        lastErr = err;
        if (attempt < maxAttempts) {
          this.ctx.onProgress?.({
            kind: 'step.retry',
            callKey,
            attempt,
            error: err,
            ...(role !== undefined ? { role } : {}),
          });
          if (delayMs > 0) {
            await delay(delayMs, this.ctx.signal);
          }
        } else {
          this.ctx.onProgress?.({
            kind: 'step.error',
            callKey,
            attempt,
            error: err,
            ...(role !== undefined ? { role } : {}),
          });
        }
      }
    }
    throw lastErr;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkflowConfigurationError(`${label} must be a positive integer.`);
  }
}

class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: WorkflowCancelledError) => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }> = [];

  public constructor(limit: number) {
    assertPositiveInteger(limit, 'Workflow concurrency');
    this.available = limit;
  }

  public acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new WorkflowCancelledError());
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.findIndex((waiter) => waiter.onAbort === onAbort);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new WorkflowCancelledError());
      };
      const waiter = { resolve, reject, signal, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (!waiter) break;
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        if (waiter.signal.aborted) {
          waiter.reject(new WorkflowCancelledError());
          continue;
        }
        waiter.resolve(this.createRelease());
        return;
      }
      this.available++;
    };
  }
}

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
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as unknown);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WorkflowCancelledError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new WorkflowCancelledError());
      },
      { once: true },
    );
  });
}
