import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  WorkflowAbortError,
  WorkflowAgentCapError,
  WorkflowBudgetExceededError,
  WorkflowInputError,
} from './errors.js';
import { cloneJournalResult, journalEntryFromCall, workflowAgentCacheKey } from './journal.js';
import { parseWorkflowScript } from './parser.js';
import type {
  AgentFailure,
  AgentOptions,
  HarnessRunMetadata,
  HarnessRunner,
  HarnessRunnerResolver,
  JsonSchema,
  WorkflowAgentCall,
  WorkflowBudget,
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowRef,
  WorkflowRunOptions,
  WorkflowRunResult,
} from './types.js';

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_AGENTS = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10;
const MAX_ITEMS_PER_CALL = 4096;

interface RuntimeState {
  readonly logs: string[];
  readonly phases: string[];
  readonly failures: AgentFailure[];
  agentCount: number;
  nextAgentIndex: number;
  cacheHits: number;
  spent: number;
}

interface RuntimeContext {
  readonly state: RuntimeState;
  readonly options: WorkflowRunOptions;
  readonly runId: string;
  readonly runnerResolver: HarnessRunnerResolver;
  readonly limiter: <T>(task: () => Promise<T>) => Promise<T>;
  readonly maxAgents: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly tokenBudget: number | null | undefined;
  readonly signal: AbortSignal;
  readonly internalAbort: AbortController;
  readonly inFlight: Set<Promise<unknown>>;
  runAgent(
    prompt: unknown,
    rawOptions: unknown,
    workflowPath: string,
    occurrences: Map<string, number>,
  ): Promise<unknown>;
  runNested(
    ref: unknown,
    args: unknown,
    parentPath: string,
    depth: number,
    invocation: number,
  ): Promise<unknown>;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const startedAt = Date.now();
  const parsed = parseWorkflowScript(script);
  const runId = options.runId ?? `workflow_${randomUUID()}`;
  const context = createContext(options, runId);

  try {
    throwIfAborted(options.signal, context.signal);
    const result = await executeWorkflow(
      parsed.body,
      parsed.meta,
      context,
      options.args,
      parsed.meta.name,
      0,
      options.cwd ?? process.cwd(),
    );
    assertSerializable(result);
    return {
      meta: parsed.meta,
      result: result as T,
      logs: context.state.logs,
      phases: context.state.phases,
      agentCount: context.state.agentCount,
      durationMs: Date.now() - startedAt,
      runId,
      cacheHits: context.state.cacheHits,
      failures: context.state.failures,
    };
  } finally {
    context.internalAbort.abort();
  }
}

function createContext(options: WorkflowRunOptions, runId: string): RuntimeContext {
  const internalAbort = new AbortController();
  const signal = options.signal
    ? combineSignals(options.signal, internalAbort.signal)
    : internalAbort.signal;
  const state: RuntimeState = {
    logs: [],
    phases: [],
    failures: [],
    agentCount: 0,
    nextAgentIndex: 0,
    cacheHits: 0,
    spent: 0,
  };
  const runnerResolver: HarnessRunnerResolver =
    typeof options.runner === 'function' ? options.runner : () => options.runner as HarnessRunner;
  const context: RuntimeContext = {
    state,
    options,
    runId,
    runnerResolver,
    limiter: createLimiter(Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY))),
    maxAgents: Math.max(1, Math.trunc(options.maxAgents ?? DEFAULT_MAX_AGENTS)),
    maxAttempts: Math.max(1, Math.trunc(options.agentMaxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    retryDelayMs: Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
    tokenBudget: options.tokenBudget,
    signal,
    internalAbort,
    inFlight: new Set(),
    runAgent: async () => {
      throw new Error('runAgent was not initialized');
    },
    runNested: async () => {
      throw new Error('runNested was not initialized');
    },
  };

  context.runAgent = async (prompt, rawOptions, workflowPath, occurrences) => {
    throwIfAborted(options.signal, signal);
    const taskPrompt = requireString(prompt, 'agent prompt');
    const parsedOptions = normalizeOptions(rawOptions);
    const role = requireString(parsedOptions.role, 'agent role');
    const roleKey = `${workflowPath}\u0000${role}`;
    const occurrence = (occurrences.get(roleKey) ?? 0) + 1;
    occurrences.set(roleKey, occurrence);
    if (state.agentCount >= context.maxAgents) throw new WorkflowAgentCapError();
    if (
      context.tokenBudget !== null &&
      context.tokenBudget !== undefined &&
      remainingBudget(context.tokenBudget, state) <= 0
    ) {
      throw new WorkflowBudgetExceededError();
    }

    state.agentCount += 1;
    const index = ++state.nextAgentIndex;
    const label = parsedOptions.label?.trim() || role;
    const callOptions: AgentOptions = { ...parsedOptions, role };
    // Labels are presentation-only; semantic role, prompt, occurrence, and work options define replay identity.
    const keyOptions = { ...callOptions, label: undefined };
    const cacheKey = workflowAgentCacheKey({
      workflowPath,
      role,
      occurrence,
      prompt: taskPrompt,
      options: keyOptions,
    });
    const call: WorkflowAgentCall = {
      prompt: taskPrompt,
      role,
      options: callOptions,
      label,
      index,
      occurrence,
      workflowPath,
      runId,
      cacheKey,
    };

    return abortable(
      context.limiter(async () => {
        throwIfAborted(options.signal, signal);
        notify(options, {
          type: 'agent',
          role,
          label,
          workflowPath,
          state: 'started',
          prompt: taskPrompt,
          options: callOptions,
          index,
          key: cacheKey,
          ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
        });

        const cached = await options.journal?.get(runId, cacheKey);
        if (cached) {
          throwIfAborted(options.signal, signal);
          state.cacheHits += 1;
          const result = cloneJournalResult(cached);
          notify(options, {
            type: 'agent',
            role,
            label,
            workflowPath,
            state: 'cached',
            result,
            index,
            key: cacheKey,
            ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
            ...(cached.harness === undefined ? {} : { harness: cached.harness }),
            ...(cached.sessionId === undefined ? {} : { sessionId: cached.sessionId }),
          });
          return result;
        }

        const runner = context.runnerResolver(call);
        let lastError = 'agent failed';
        for (let attempt = 1; attempt <= context.maxAttempts; attempt += 1) {
          throwIfAborted(options.signal, signal);
          let metadata: HarnessRunMetadata = {};
          const onMeta = (next: HarnessRunMetadata) => {
            metadata = { ...metadata, ...next };
            if (next.harness !== undefined || next.sessionId !== undefined) {
              notify(options, {
                type: 'agent',
                role,
                label,
                workflowPath,
                state: 'started',
                index,
                key: cacheKey,
                ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
                ...(metadata.harness === undefined ? {} : { harness: metadata.harness }),
                ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
              });
            }
          };
          const runnerPromise = Promise.resolve().then(() => runner.run(call, signal, onMeta));
          context.inFlight.add(runnerPromise);
          runnerPromise
            .finally(() => context.inFlight.delete(runnerPromise))
            .catch(() => undefined);
          try {
            const rawResult = await abortable(runnerPromise, signal);
            throwIfAborted(options.signal, signal);
            const result = normalizeAgentResult(rawResult, callOptions.schema);
            state.spent += metadata.outputTokens ?? estimateTokens(result);
            try {
              await options.journal?.put(journalEntryFromCall(call, result, metadata));
            } catch (error) {
              appendLog(
                options,
                state,
                `agent ${label} journal write failed: ${errorMessage(error)}`,
              );
            }
            notify(options, {
              type: 'agent',
              role,
              label,
              workflowPath,
              state: 'completed',
              result,
              index,
              key: cacheKey,
              ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
              ...(metadata.harness === undefined ? {} : { harness: metadata.harness }),
              ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
            });
            return result;
          } catch (error) {
            if (error instanceof WorkflowAbortError || signal.aborted)
              throw new WorkflowAbortError();
            if (metadata.outputTokens !== undefined) state.spent += metadata.outputTokens;
            lastError = errorMessage(error);
            if (attempt < context.maxAttempts) {
              appendLog(
                options,
                state,
                `agent ${label} attempt ${attempt}/${context.maxAttempts} failed: ${lastError}; retrying`,
              );
              await delay(context.retryDelayMs * attempt, signal);
            }
          }
        }

        appendLog(
          options,
          state,
          `agent ${label} failed after ${context.maxAttempts} attempt(s): ${lastError}`,
        );
        const failure: AgentFailure = {
          role,
          label,
          index,
          key: cacheKey,
          attempts: context.maxAttempts,
          error: lastError,
          ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
        };
        state.failures.push(failure);
        notify(options, {
          type: 'agent',
          role,
          label,
          workflowPath,
          state: 'failed',
          error: lastError,
          index,
          key: cacheKey,
          ...(callOptions.phase === undefined ? {} : { phase: callOptions.phase }),
        });
        return null;
      }),
      signal,
    );
  };

  context.runNested = (ref, args, parentPath, depth, invocation) => {
    const promise = (async () => {
      throwIfAborted(options.signal, signal);
      const maxDepth = Math.max(0, Math.trunc(options.maxWorkflowDepth ?? 8));
      if (depth >= maxDepth)
        throw new WorkflowInputError(`workflow() nesting exceeds the maximum depth of ${maxDepth}`);
      if (!options.resolveWorkflow)
        throw new WorkflowInputError('workflow() requires a resolveWorkflow function');
      const resolved = await options.resolveWorkflow(toWorkflowRef(ref));
      const parsed = parseWorkflowScript(resolved.script);
      const childName = resolved.name ?? parsed.meta.name;
      return executeWorkflow(
        parsed.body,
        parsed.meta,
        context,
        args,
        `${parentPath}/${childName}${invocation === 1 ? '' : `#${invocation}`}`,
        depth + 1,
        resolved.basePath ?? context.options.cwd ?? process.cwd(),
      );
    })();
    context.inFlight.add(promise);
    promise.finally(() => context.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  };
  return context;
}

async function executeWorkflow(
  body: string,
  meta: WorkflowMeta,
  context: RuntimeContext,
  args: unknown,
  workflowPath: string,
  depth: number,
  basePath: string,
): Promise<unknown> {
  const occurrences = new Map<string, number>();
  let nextNestedInvocation = 0;
  const phases = {
    current: undefined as string | undefined,
    phase(title: unknown): void {
      const value = requireString(title, 'phase title');
      phases.current = value;
      if (!context.state.phases.includes(value)) context.state.phases.push(value);
      notify(context.options, { type: 'phase', title: value });
    },
  };
  const log = (message: unknown): void =>
    appendLog(context.options, context.state, String(message));
  const agent = (prompt: unknown, options: unknown = {}): Promise<unknown> => {
    const raw = normalizeOptions(options);
    const withPhase: ParsedAgentOptions =
      raw.phase === undefined && phases.current !== undefined
        ? { ...raw, phase: phases.current }
        : raw;
    return context.runAgent(prompt, withPhase, workflowPath, occurrences);
  };
  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (
      !Array.isArray(thunks) ||
      thunks.length > MAX_ITEMS_PER_CALL ||
      thunks.some((item) => typeof item !== 'function')
    ) {
      throw new WorkflowInputError(
        `parallel() expects an array of functions (maximum ${MAX_ITEMS_PER_CALL})`,
      );
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await (thunk as () => unknown)();
        } catch (error) {
          if (isFatal(error)) throw error;
          log(`parallel item failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
  };
  const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (
      !Array.isArray(items) ||
      items.length > MAX_ITEMS_PER_CALL ||
      stages.some((stage) => typeof stage !== 'function')
    ) {
      throw new WorkflowInputError(
        `pipeline() expects an array and function stages (maximum ${MAX_ITEMS_PER_CALL} items)`,
      );
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            value = await (
              stage as (previous: unknown, original: unknown, itemIndex: number) => unknown
            )(value, item, index);
          } catch (error) {
            if (isFatal(error)) throw error;
            log(`pipeline item ${index} failed: ${errorMessage(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };
  const workflow = (ref: unknown, nestedArgs?: unknown): Promise<unknown> => {
    const normalizedRef = toWorkflowRef(ref);
    const invocation = ++nextNestedInvocation;
    return context.runNested(normalizedRef, nestedArgs, workflowPath, depth, invocation);
  };
  const budget: WorkflowBudget = Object.freeze({
    total: context.tokenBudget ?? null,
    spent: () => context.state.spent,
    remaining: () =>
      context.tokenBudget === null || context.tokenBudget === undefined
        ? Infinity
        : remainingBudget(context.tokenBudget, context.state),
  });

  const transpiled = ts.transpileModule(body, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: false,
    },
    fileName: `${meta.name}.ts`,
  }).outputText;
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* workflow body */
  }).constructor as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>;
  const execute = new AsyncFunction(
    'agent',
    'parallel',
    'pipeline',
    'workflow',
    'phase',
    'log',
    'args',
    'budget',
    'cwd',
    '__workflow_import',
    transpiled,
  );
  return execute(
    agent,
    parallel,
    pipeline,
    workflow,
    phases.phase.bind(phases),
    log,
    args,
    budget,
    basePath,
    (specifier: string) => import(resolveWorkflowImport(specifier, basePath)),
  );
}

type ParsedAgentOptions = Omit<AgentOptions, 'role'> & { readonly role?: string };

function normalizeOptions(raw: unknown): ParsedAgentOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new WorkflowInputError('agent options must be an object');
  const value = raw as Record<string, unknown>;
  const result: {
    role?: string;
    label?: string;
    phase?: string;
    schema?: JsonSchema;
    isolation?: string;
  } = {};
  if (value.role !== undefined) result.role = requireString(value.role, 'agent role');
  if (value.label !== undefined) result.label = requireString(value.label, 'agent label');
  if (value.phase !== undefined) result.phase = requireString(value.phase, 'agent phase');
  if (value.isolation !== undefined)
    result.isolation = requireString(value.isolation, 'agent isolation');
  if (value.schema !== undefined) {
    if (!value.schema || typeof value.schema !== 'object' || Array.isArray(value.schema))
      throw new WorkflowInputError('agent schema must be an object');
    result.schema = value.schema as JsonSchema;
  }
  return result;
}

function normalizeAgentResult(result: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return result;
  const normalized = stripOptionalNulls(result, schema);
  validateSchema(normalized, schema, '$');
  return normalized;
}

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.const !== undefined && !deepEqual(value, schema.const))
    throw new Error(`${path} must equal const`);
  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value)))
    throw new Error(`${path} must match enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type)))
      throw new Error(`${path} must be ${types.join(' or ')}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (schema.items)
      value.forEach((item, index) =>
        validateSchema(item, schema.items as JsonSchema, `${path}[${index}]`),
      );
    return;
  }
  if (schema.required) {
    for (const key of schema.required)
      if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (key in value)
        validateSchema((value as Record<string, unknown>)[key], child, `${path}.${key}`);
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(value))
      if (!(key in schema.properties)) throw new Error(`${path}.${key} is not allowed`);
  }
}

function stripOptionalNulls(value: unknown, schema: JsonSchema): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return schema.items
      ? value.map((item) => stripOptionalNulls(item, schema.items as JsonSchema))
      : value;
  if (!schema.properties) return value;
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, child] of Object.entries(schema.properties)) {
    if (result[key] === null && !schema.required?.includes(key)) delete result[key];
    else if (key in result) result[key] = stripOptionalNulls(result[key], child);
  }
  return result;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<{
    readonly task: () => Promise<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  const drain = (): void => {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      active += 1;
      item
        .task()
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        })
        .catch(() => undefined);
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      drain();
    });
}

function throwIfAborted(userSignal: AbortSignal | undefined, signal: AbortSignal): void {
  if (userSignal?.aborted || signal.aborted) throw new WorkflowAbortError();
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WorkflowAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WorkflowAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
      .catch(() => undefined);
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WorkflowAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', onAbort), milliseconds + 1);
  });
}

function toWorkflowRef(value: unknown): WorkflowRef {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = value as { name?: unknown; scriptPath?: unknown };
    if (
      (ref.name === undefined || typeof ref.name === 'string') &&
      (ref.scriptPath === undefined || typeof ref.scriptPath === 'string') &&
      (ref.name !== undefined || ref.scriptPath !== undefined)
    ) {
      return {
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(ref.scriptPath === undefined ? {} : { scriptPath: ref.scriptPath }),
      };
    }
  }
  throw new WorkflowInputError('workflow() expects a workflow name or reference object');
}

function resolveWorkflowImport(specifier: string, basePath: string): string {
  if (
    specifier.startsWith('file:') ||
    (!specifier.startsWith('.') && !path.isAbsolute(specifier))
  ) {
    return specifier;
  }
  return pathToFileURL(path.resolve(basePath, specifier)).href;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new WorkflowInputError(`${description} must be a non-empty string`);
  return value;
}

function notify(options: WorkflowRunOptions, event: WorkflowProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Progress observers are diagnostic and cannot change workflow correctness.
  }
}

function appendLog(options: WorkflowRunOptions, state: RuntimeState, message: string): void {
  state.logs.push(message);
  notify(options, { type: 'log', message });
}

function remainingBudget(total: number, state: RuntimeState): number {
  return Math.max(0, total - state.spent);
}

function estimateTokens(value: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
  } catch {
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof WorkflowAbortError ||
    error instanceof WorkflowInputError ||
    error instanceof WorkflowAgentCapError ||
    error instanceof WorkflowBudgetExceededError
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function assertSerializable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (typeof (value as PromiseLike<unknown>).then === 'function') {
    throw new WorkflowInputError(
      'workflow result contains an unresolved promise; await agent(), parallel(), pipeline(), and workflow() calls',
    );
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSerializable(item, seen);
  } else {
    for (const item of Object.values(value)) assertSerializable(item, seen);
  }
}
