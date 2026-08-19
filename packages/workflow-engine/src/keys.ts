/**
 * Stable call-key generation for workflow steps.
 *
 * Keys must be deterministic from the *logical position* of a call in the
 * workflow graph, not from async arrival order. This enables journal replay
 * regardless of execution timing.
 */

export interface KeyContext {
  readonly runId: string;
  readonly path: readonly string[];
}

export function buildCallKey(ctx: KeyContext, localId: string): string {
  return [...ctx.path, localId].join('/');
}

export function childKeyContext(ctx: KeyContext, segment: string): KeyContext {
  return { runId: ctx.runId, path: [...ctx.path, segment] };
}

export function rootKeyContext(runId: string): KeyContext {
  return { runId, path: [runId] };
}
