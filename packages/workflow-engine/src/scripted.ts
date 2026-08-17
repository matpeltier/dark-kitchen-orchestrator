import type { HarnessRunner, HarnessRunMetadata, WorkflowAgentCall } from './types.js';

export type ScriptedHarnessHandler = (
  call: WorkflowAgentCall,
  signal?: AbortSignal,
  onMeta?: (metadata: HarnessRunMetadata) => void,
) => unknown | Promise<unknown>;

/** Deterministic runner for integration tests and local workflow smoke tests. */
export class ScriptedHarnessRunner implements HarnessRunner {
  readonly calls: WorkflowAgentCall[] = [];

  constructor(private readonly handler: ScriptedHarnessHandler) {}

  run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (metadata: HarnessRunMetadata) => void,
  ): Promise<unknown> {
    this.calls.push(call);
    return Promise.resolve(this.handler(call, signal, onMeta));
  }
}
