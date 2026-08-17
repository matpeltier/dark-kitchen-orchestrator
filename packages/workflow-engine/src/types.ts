export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: JsonValue[];
  const?: JsonValue;
  description?: string;
}

export interface WorkflowMetaPhase {
  readonly title: string;
  readonly detail?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly title?: string;
  readonly whenToUse?: string;
  readonly phases?: readonly WorkflowMetaPhase[];
}

/** Options that describe the work, not the harness that will execute it. */
export interface AgentOptions {
  /** Stable, semantic responsibility for this call, for example `review` or `summarize`. */
  readonly role: string;
  /** Human-facing label; it is not used to select a model or harness. */
  readonly label?: string;
  readonly phase?: string;
  readonly schema?: JsonSchema;
  readonly isolation?: string;
}

export interface WorkflowAgentCall {
  readonly prompt: string;
  readonly role: string;
  readonly options: AgentOptions;
  readonly label: string;
  readonly index: number;
  readonly occurrence: number;
  readonly workflowPath: string;
  readonly runId: string;
  readonly cacheKey: string;
}

export interface HarnessRunMetadata {
  readonly harness?: string;
  readonly sessionId?: string;
  readonly outputTokens?: number;
}

/** A runner is deliberately generic: harness/model routing is owned by the caller. */
export interface HarnessRunner {
  run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (metadata: HarnessRunMetadata) => void,
  ): Promise<unknown>;
}

/** Resolve a runner from semantic call information in the application/router layer. */
export type HarnessRunnerResolver = (call: WorkflowAgentCall) => HarnessRunner;
export type HarnessRunnerOrResolver = HarnessRunner | HarnessRunnerResolver;
/** Short aliases for applications that already use the term runner. */
export type RunnerResolver = HarnessRunnerResolver;
export type WorkflowAgentRunner = HarnessRunner;
export type WorkflowRunnerResolver = HarnessRunnerResolver;

export type WorkflowRef = string | { readonly name?: string; readonly scriptPath?: string };

export interface WorkflowResolver {
  (ref: WorkflowRef): Promise<{
    readonly script: string;
    readonly name?: string;
    readonly basePath?: string;
  }>;
}

export interface WorkflowBudget {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export interface AgentFailure {
  readonly role: string;
  readonly label: string;
  readonly phase?: string;
  readonly index: number;
  readonly key: string;
  readonly attempts: number;
  readonly error: string;
}

export interface WorkflowProgressAgent {
  readonly type: 'agent';
  readonly role: string;
  readonly label: string;
  readonly phase?: string;
  readonly workflowPath?: string;
  readonly state: 'started' | 'completed' | 'cached' | 'failed';
  readonly prompt?: string;
  readonly options?: AgentOptions;
  readonly result?: unknown;
  readonly error?: string;
  readonly index?: number;
  readonly key?: string;
  readonly harness?: string;
  readonly sessionId?: string;
}

export interface WorkflowProgressPhase {
  readonly type: 'phase';
  readonly title: string;
}

export interface WorkflowProgressLog {
  readonly type: 'log';
  readonly message: string;
}

export type WorkflowProgressEvent =
  | WorkflowProgressAgent
  | WorkflowProgressPhase
  | WorkflowProgressLog;

export interface WorkflowJournalEntry {
  readonly key: string;
  readonly runId: string;
  readonly role: string;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly result: unknown;
  readonly createdAt: number;
  readonly harness?: string;
  readonly sessionId?: string;
}

export interface WorkflowJournal {
  get(
    runId: string,
    key: string,
  ): Promise<WorkflowJournalEntry | undefined> | WorkflowJournalEntry | undefined;
  put(entry: WorkflowJournalEntry): Promise<void> | void;
}

export interface WorkflowRunOptions {
  readonly runner: HarnessRunnerOrResolver;
  readonly args?: unknown;
  readonly cwd?: string;
  readonly runId?: string;
  readonly concurrency?: number;
  readonly maxAgents?: number;
  /** Total attempts per call, including the initial attempt. */
  readonly agentMaxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly tokenBudget?: number | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: WorkflowProgressEvent) => void;
  readonly journal?: WorkflowJournal;
  readonly resolveWorkflow?: WorkflowResolver;
  readonly maxWorkflowDepth?: number;
}

export interface ParsedWorkflow {
  readonly meta: WorkflowMeta;
  readonly body: string;
}

export interface WorkflowRunResult<T = unknown> {
  readonly meta: WorkflowMeta;
  readonly result: T;
  readonly logs: readonly string[];
  readonly phases: readonly string[];
  readonly agentCount: number;
  readonly durationMs: number;
  readonly runId: string;
  readonly cacheHits: number;
  readonly failures: readonly AgentFailure[];
}
