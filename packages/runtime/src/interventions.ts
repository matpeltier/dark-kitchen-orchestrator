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
import {
  createEventId,
  createInterventionId,
} from '@dark-kitchen/core';

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

export type ResolutionAction =
  | 'retry'
  | 'switch-harness'
  | 'approve'
  | 'stop'
  | 'free-text';

export interface ResolveInterventionInput {
  readonly interventionId: InterventionId;
  readonly action: ResolutionAction;
  readonly answer?: string;
  readonly resolvedBy?: string;
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

  public constructor(store: RuntimeStore) {
    this.store = store;
  }

  public async create(input: CreateInterventionInput): Promise<Intervention> {
    // Deduplication: if a key is provided and there's already an open intervention, return it
    if (input.deduplicationKey) {
      const existingId = this.activeByKey.get(input.deduplicationKey);
      if (existingId) {
        const existing = await this.store.getIntervention(existingId);
        if (existing && existing.status === 'open') return existing;
      }
    }

    const now = new Date().toISOString();
    const id = createInterventionId(`int-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    let intervention: Intervention;
    const base = {
      id,
      kind: input.kind,
      status: 'open' as InterventionStatus,
      summary: input.summary,
      createdAt: now,
      updatedAt: now,
    };
    if (input.details) Object.assign(base, { details: input.details });

    if (input.scope === 'task') {
      intervention = { ...base, scope: 'task' as const, targetId: input.targetId as TaskId };
    } else if (input.scope === 'run') {
      intervention = { ...base, scope: 'run' as const, targetId: input.targetId as RunId };
    } else {
      intervention = { ...base, scope: 'agent' as const, targetId: input.targetId as AgentSessionId };
    }

    await this.store.saveIntervention(intervention);

    if (input.deduplicationKey) {
      this.activeByKey.set(input.deduplicationKey, id);
    }

    await this.emit({
      id: createEventId(`evt-${Date.now()}`),
      type: 'intervention.created',
      occurredAt: now,
      payload: { interventionId: id, kind: input.kind, scope: input.scope },
    });

    return intervention;
  }

  public async resolve(input: ResolveInterventionInput): Promise<Intervention> {
    const intervention = await this.store.getIntervention(input.interventionId);
    if (!intervention) throw new Error(`Intervention ${input.interventionId} not found`);
    if (intervention.status !== 'open' && intervention.status !== 'acknowledged') {
      throw new Error(`Cannot resolve intervention in status "${intervention.status}"`);
    }

    const now = new Date().toISOString();
    const details = input.answer
      ? `${intervention.details ?? ''}\nResolution (${input.action}${input.resolvedBy ? ` by ${input.resolvedBy}` : ''}): ${input.answer}`.trim()
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
      id: createEventId(`evt-${Date.now()}`),
      type: 'intervention.resolved',
      occurredAt: now,
      payload: { interventionId: input.interventionId, kind: intervention.kind, scope: intervention.scope },
    });

    return resolved;
  }

  public async dismiss(interventionId: InterventionId): Promise<Intervention> {
    const intervention = await this.store.getIntervention(interventionId);
    if (!intervention) throw new Error(`Intervention ${interventionId} not found`);
    const now = new Date().toISOString();
    const dismissed: Intervention = { ...intervention, status: 'dismissed', updatedAt: now };
    await this.store.saveIntervention(dismissed);

    await this.emit({
      id: createEventId(`evt-${Date.now()}`),
      type: 'intervention.dismissed',
      occurredAt: now,
      payload: { interventionId, kind: intervention.kind, scope: intervention.scope },
    });

    return dismissed;
  }

  public async get(interventionId: InterventionId): Promise<Intervention | undefined> {
    return this.store.getIntervention(interventionId);
  }

  public subscribe(handler: InterventionEventHandler): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  private async emit(event: InterventionEvent): Promise<void> {
    for (const handler of this.subscribers) {
      await handler(event);
    }
  }
}
