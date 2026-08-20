/**
 * Intervention service - durable pause/notify/resume for human escalations.
 *
 * Interventions cover: product decisions, missing access, destructive approvals,
 * auth failures, quota/rate-limit errors, agent failures, stuck agents, and
 * manual escalations.
 */

import type {
  AgentSessionId,
  Intervention,
  InterventionId,
  InterventionKind,
  InterventionStatus,
  RunId,
  RuntimeStore,
  TaskId,
} from '@dark-kitchen/core';
import { createEventId, createInterventionId, createTaskId } from '@dark-kitchen/core';
import { createHash, randomUUID } from 'node:crypto';

export type InterventionScope = Intervention['scope'];
export type { InterventionKind };

export interface CreateInterventionInput {
  readonly scope: InterventionScope;
  readonly targetId: TaskId | RunId | AgentSessionId;
  readonly kind: InterventionKind;
  readonly summary: string;
  readonly details?: string;
  readonly deduplicationKey?: string;
}

export type ResolutionAction = 'retry' | 'switch-harness' | 'approve' | 'stop' | 'free-text';

export interface ResolveInterventionInput {
  readonly interventionId: InterventionId;
  readonly action: ResolutionAction;
  readonly answer?: string;
  readonly resolvedBy?: string;
}

export interface AskHumanResult {
  readonly resolved: boolean;
  readonly answer?: string;
  readonly interventionId: InterventionId;
}

export interface AskHumanOptions {
  readonly timeoutMs?: number;
  /** Stable caller request ID used to deduplicate MCP/network replay. */
  readonly requestId?: string;
  /** Primarily useful for deterministic tests; defaults to one second. */
  readonly pollIntervalMs?: number;
}

export interface InterventionEvent {
  readonly id: string;
  readonly type: 'intervention.created' | 'intervention.resolved' | 'intervention.dismissed';
  readonly occurredAt: string;
  readonly payload: {
    readonly interventionId: InterventionId;
    readonly kind: InterventionKind;
    readonly scope: InterventionScope;
  };
}

type InterventionEventHandler = (event: InterventionEvent) => void | Promise<void>;

/** Operational error kinds that should NOT pollute tracker state. */
const OPERATIONAL_KINDS: ReadonlySet<InterventionKind> = new Set([
  'auth',
  'quota',
  'rate-limit',
  'agent-failure',
  'stuck-agent',
]);

export function isOperationalIntervention(kind: InterventionKind): boolean {
  return OPERATIONAL_KINDS.has(kind);
}

/**
 * Manages the lifecycle of interventions: create, list, resolve, cancel.
 * Deduplicates repeated identical events from the same session.
 */
export class InterventionService {
  private readonly store: RuntimeStore;
  private readonly subscribers: InterventionEventHandler[] = [];
  private readonly activeByKey = new Map<string, InterventionId>();
  private readonly createsInFlight = new Map<string, Promise<Intervention>>();
  private readonly transitionsInFlight = new Map<InterventionId, Promise<Intervention>>();

  public constructor(store: RuntimeStore) {
    this.store = store;
  }

  public async create(input: CreateInterventionInput): Promise<Intervention> {
    validateCreateInput(input);
    if (!input.deduplicationKey) return this.createOnce(input);

    const current = this.createsInFlight.get(input.deduplicationKey);
    if (current) return current;
    const creation = this.createOnce(input).finally(() => {
      this.createsInFlight.delete(input.deduplicationKey!);
    });
    this.createsInFlight.set(input.deduplicationKey, creation);
    return creation;
  }

  private async createOnce(input: CreateInterventionInput): Promise<Intervention> {
    // A deterministic ID makes a deduplicated create idempotent across daemon
    // restarts, not merely while this service instance remains in memory.
    if (input.deduplicationKey) {
      const existingId =
        this.activeByKey.get(input.deduplicationKey) ??
        interventionIdForKey(input.deduplicationKey);
      const existing = await this.store.getIntervention(existingId);
      // Replays after a terminal transition return the original terminal
      // record. A new incident must use a new deduplication key.
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const id = input.deduplicationKey
      ? interventionIdForKey(input.deduplicationKey)
      : createInterventionId(`int-${randomUUID()}`);

    let intervention: Intervention;
    const base = {
      id,
      kind: input.kind,
      status: 'open' as InterventionStatus,
      summary: redactSensitive(input.summary),
      createdAt: now,
      updatedAt: now,
    };
    if (input.details) Object.assign(base, { details: redactSensitive(input.details) });

    if (input.scope === 'task') {
      intervention = { ...base, scope: 'task' as const, targetId: input.targetId as TaskId };
    } else if (input.scope === 'run') {
      intervention = { ...base, scope: 'run' as const, targetId: input.targetId as RunId };
    } else {
      intervention = {
        ...base,
        scope: 'agent' as const,
        targetId: input.targetId as AgentSessionId,
      };
    }

    await this.store.saveIntervention(intervention);

    if (input.deduplicationKey) {
      this.activeByKey.set(input.deduplicationKey, id);
    }

    await this.emit({
      id: createEventId(`evt-${randomUUID()}`),
      type: 'intervention.created',
      occurredAt: now,
      payload: { interventionId: id, kind: input.kind, scope: input.scope },
    });

    return intervention;
  }

  public async resolve(input: ResolveInterventionInput): Promise<Intervention> {
    validateResolveInput(input);
    return this.runTransition(input.interventionId, async () => {
      const intervention = await this.store.getIntervention(input.interventionId);
      if (!intervention) throw new Error(`Intervention ${input.interventionId} not found`);
      if (intervention.status === 'resolved') return intervention;
      if (intervention.status !== 'open' && intervention.status !== 'acknowledged') {
        throw new Error(`Cannot resolve intervention in status "${intervention.status}"`);
      }

      const now = new Date().toISOString();
      const safeAnswer = input.answer ? redactSensitive(input.answer) : undefined;
      const safeResolver = input.resolvedBy ? redactSensitive(input.resolvedBy) : undefined;
      const details = safeAnswer
        ? `${intervention.details ?? ''}\nResolution (${input.action}${safeResolver ? ` by ${safeResolver}` : ''}): ${safeAnswer}`.trim()
        : intervention.details;

      const resolved: Intervention = {
        ...intervention,
        status: 'resolved',
        updatedAt: now,
        resolvedAt: now,
        ...(details ? { details } : {}),
      };
      await this.store.saveIntervention(resolved);

      // Clean up deduplication key
      for (const [key, id] of this.activeByKey) {
        if (id === input.interventionId) this.activeByKey.delete(key);
      }

      await this.emit({
        id: createEventId(`evt-${randomUUID()}`),
        type: 'intervention.resolved',
        occurredAt: now,
        payload: {
          interventionId: input.interventionId,
          kind: intervention.kind,
          scope: intervention.scope,
        },
      });

      return resolved;
    });
  }

  public async dismiss(interventionId: InterventionId): Promise<Intervention> {
    return this.runTransition(interventionId, async () => {
      const intervention = await this.store.getIntervention(interventionId);
      if (!intervention) throw new Error(`Intervention ${interventionId} not found`);
      if (intervention.status === 'resolved' || intervention.status === 'dismissed') {
        return intervention;
      }
      const now = new Date().toISOString();
      const dismissed: Intervention = {
        ...intervention,
        status: 'dismissed',
        updatedAt: now,
        resolvedAt: now,
      };
      await this.store.saveIntervention(dismissed);

      await this.emit({
        id: createEventId(`evt-${randomUUID()}`),
        type: 'intervention.dismissed',
        occurredAt: now,
        payload: { interventionId, kind: intervention.kind, scope: intervention.scope },
      });

      return dismissed;
    });
  }

  public async get(interventionId: InterventionId): Promise<Intervention | undefined> {
    return this.store.getIntervention(interventionId);
  }

  /** All interventions, oldest first (open ones first for convenience). */
  public async list(): Promise<Intervention[]> {
    const all = await this.store.listInterventions();
    return all.sort((a, b) => {
      const aRank = a.status === 'open' || a.status === 'acknowledged' ? 0 : 1;
      const bRank = b.status === 'open' || b.status === 'acknowledged' ? 0 : 1;
      return aRank - bRank || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }

  /**
   * Ask the human a question and block until they reply. Creates a
   * `product-decision` intervention (which the daemon notifies over the
   * configured channels) and polls until it is resolved/dismissed or the
   * timeout elapses. Returns the extracted answer for the caller (e.g. an
   * agent invoking the `dk_ask_human` MCP tool).
   */
  public async askHuman(question: string, options?: AskHumanOptions): Promise<AskHumanResult> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Human question must not be empty');
    if (normalizedQuestion.length > 16_000) {
      throw new Error('Human question exceeds the 16000-character limit');
    }
    const timeoutMs = options?.timeoutMs ?? 30 * 60 * 1000;
    const pollIntervalMs = options?.pollIntervalMs ?? 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error('askHuman timeoutMs must be a non-negative finite number');
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error('askHuman pollIntervalMs must be a positive finite number');
    }
    const requestId = options?.requestId?.trim() || randomUUID();
    const intervention = await this.create({
      scope: 'task',
      targetId: createTaskId(`manual-ask-${stableHash(requestId)}`),
      kind: 'product-decision',
      summary: normalizedQuestion,
      deduplicationKey: `ask-human:${requestId}`,
    });

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.store.getIntervention(intervention.id);
      if (!current) break;
      if (current.status === 'resolved' || current.status === 'dismissed') {
        return {
          resolved: current.status === 'resolved',
          ...(current.details ? { answer: extractAnswer(current.details) } : {}),
          interventionId: current.id,
        };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
      );
    }
    return { resolved: false, interventionId: intervention.id };
  }

  public subscribe(handler: InterventionEventHandler): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  private async emit(event: InterventionEvent): Promise<void> {
    // Persistence is the source of truth. A transient notification subscriber
    // failure must not make a committed transition appear to have failed and
    // be replayed. Delivery reports remain available at the channel boundary.
    await Promise.allSettled(this.subscribers.map((handler) => handler(event)));
  }

  private runTransition(
    interventionId: InterventionId,
    operation: () => Promise<Intervention>,
  ): Promise<Intervention> {
    const current = this.transitionsInFlight.get(interventionId);
    if (current) return current;
    const transition = operation().finally(() => {
      this.transitionsInFlight.delete(interventionId);
    });
    this.transitionsInFlight.set(interventionId, transition);
    return transition;
  }
}

/** Strip the "Resolution (action by sender): " prefix the resolver prepends. */
function extractAnswer(details: string): string {
  const m = details.match(/Resolution\s*\([^)]*\):\s*([\s\S]*)$/);
  return m ? (m[1] ?? details).trim() : details;
}

function interventionIdForKey(key: string): InterventionId {
  return createInterventionId(`int-dedup-${stableHash(key)}`);
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function validateCreateInput(input: CreateInterventionInput): void {
  if (!String(input.targetId).trim()) throw new Error('Intervention targetId must not be empty');
  if (!input.summary.trim()) throw new Error('Intervention summary must not be empty');
  if (input.summary.length > 16_000) throw new Error('Intervention summary is too long');
  if (input.details && input.details.length > 64_000)
    throw new Error('Intervention details are too long');
  if (input.deduplicationKey && input.deduplicationKey.length > 2_000) {
    throw new Error('Intervention deduplicationKey is too long');
  }
}

function validateResolveInput(input: ResolveInterventionInput): void {
  const actions: ReadonlySet<ResolutionAction> = new Set([
    'retry',
    'switch-harness',
    'approve',
    'stop',
    'free-text',
  ]);
  if (!actions.has(input.action)) throw new Error(`Unknown intervention action "${input.action}"`);
  if (input.answer && input.answer.length > 64_000)
    throw new Error('Intervention answer is too long');
  if (input.resolvedBy && input.resolvedBy.length > 500) {
    throw new Error('Intervention resolver identity is too long');
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
}
