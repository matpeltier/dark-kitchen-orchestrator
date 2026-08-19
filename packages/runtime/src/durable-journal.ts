/**
 * SQLite-backed workflow journal for durable execution.
 *
 * Stable call keys are persisted with their results so completed agent calls
 * are replayed from the store on restart, not re-executed.
 */

import type { JournalStore, WorkflowStepResult } from '@dark-kitchen/workflow-engine';

export interface DurableJournalEntry {
  callKey: string;
  workflowRunId: string;
  role?: string;
  result: WorkflowStepResult;
  status: 'completed' | 'failed' | 'cancelled';
  attempts: number;
  startedAt: string;
  completedAt: string;
  errorMessage?: string;
}

/** Simple in-memory implementation of DurableJournal (used when SQLite is unavailable). */
export class InProcessDurableJournal implements JournalStore {
  private readonly entries = new Map<string, DurableJournalEntry>();

  public async get(callKey: string): Promise<WorkflowStepResult | undefined> {
    const entry = this.entries.get(callKey);
    if (!entry || entry.status !== 'completed') return undefined;
    return entry.result;
  }

  public async set(callKey: string, result: WorkflowStepResult): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.entries.get(callKey);
    this.entries.set(callKey, {
      callKey,
      workflowRunId: 'unknown',
      result,
      status: 'completed',
      attempts: (existing?.attempts ?? 0) + 1,
      startedAt: existing?.startedAt ?? now,
      completedAt: now,
    });
  }

  public async setFailed(callKey: string, error: unknown, attempts: number): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.entries.get(callKey);
    this.entries.set(callKey, {
      callKey,
      workflowRunId: 'unknown',
      result: undefined,
      status: 'failed',
      attempts,
      startedAt: existing?.startedAt ?? now,
      completedAt: now,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  public getEntry(callKey: string): DurableJournalEntry | undefined {
    return this.entries.get(callKey);
  }

  public entries_(): ReadonlyMap<string, DurableJournalEntry> {
    return this.entries;
  }
}

/**
 * SQLite-backed durable journal.
 * Uses createRequire to avoid Vite transform issues with node:sqlite.
 */
export class SqliteDurableJournal implements JournalStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private initialized = false;
  private readonly databasePath: string;
  private readonly workflowRunId: string;

  public constructor(databasePath: string, workflowRunId: string) {
    this.databasePath = databasePath;
    this.workflowRunId = workflowRunId;
  }

  private async ensureDb(): Promise<void> {
    if (this.initialized) return;
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createRequire } = (await import('node:module')) as any;

    if (this.databasePath !== ':memory:') {
      await mkdir(dirname(this.databasePath), { recursive: true });
    }

    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (path: string) => any };
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_journal (
        call_key TEXT PRIMARY KEY NOT NULL,
        workflow_run_id TEXT NOT NULL,
        role TEXT,
        result TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error_message TEXT
      )
    `);
    this.initialized = true;
  }

  public async get(callKey: string): Promise<WorkflowStepResult | undefined> {
    await this.ensureDb();
    const row = this.db
      .prepare('SELECT result, status FROM workflow_journal WHERE call_key = ?')
      .get(callKey) as { result: string | null; status: string } | undefined;
    if (!row || row.status !== 'completed') return undefined;
    return row.result !== null ? JSON.parse(row.result) : undefined;
  }

  public async set(callKey: string, result: WorkflowStepResult): Promise<void> {
    await this.ensureDb();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO workflow_journal (call_key, workflow_run_id, result, status, attempts, started_at, completed_at)
      VALUES (?, ?, ?, 'completed', 1, ?, ?)
      ON CONFLICT(call_key) DO UPDATE SET
        result = excluded.result,
        status = 'completed',
        attempts = attempts + 1,
        completed_at = excluded.completed_at
    `,
      )
      .run(callKey, this.workflowRunId, JSON.stringify(result), now, now);
  }

  public close(): void {
    if (this.initialized && this.db) {
      this.db.close();
    }
  }
}
