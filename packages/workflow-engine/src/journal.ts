import type { JournalStore, WorkflowStepResult } from './types.js';

/** In-memory journal for testing and single-process use. */
export class InMemoryJournal implements JournalStore {
  private readonly store = new Map<string, WorkflowStepResult>();
  private readonly inFlight = new Map<string, unknown>();

  public async get(callKey: string): Promise<WorkflowStepResult | undefined> {
    return this.store.get(callKey);
  }

  public async set(callKey: string, result: WorkflowStepResult): Promise<void> {
    this.store.set(callKey, result);
  }

  public has(callKey: string): boolean {
    return this.store.has(callKey);
  }

  public async markInFlight(callKey: string, checkpoint: unknown): Promise<void> {
    this.inFlight.set(callKey, checkpoint);
  }

  public async getInFlight(callKey: string): Promise<unknown | undefined> {
    return this.inFlight.get(callKey);
  }

  public async clearInFlight(callKey: string): Promise<void> {
    this.inFlight.delete(callKey);
  }

  public entries(): ReadonlyMap<string, WorkflowStepResult> {
    return this.store;
  }

  public clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }
}
