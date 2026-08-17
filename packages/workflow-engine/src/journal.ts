import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { WorkflowAgentCall, WorkflowJournal, WorkflowJournalEntry } from './types.js';

export class InMemoryWorkflowJournal implements WorkflowJournal {
  private readonly entries = new Map<string, WorkflowJournalEntry>();

  get(runId: string, key: string): WorkflowJournalEntry | undefined {
    const entry = this.entries.get(storageKey(runId, key));
    return entry ? structuredClone(entry) : undefined;
  }

  put(entry: WorkflowJournalEntry): void {
    this.entries.set(storageKey(entry.runId, entry.key), structuredClone(entry));
  }

  clear(runId?: string): void {
    if (runId === undefined) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${runId}:`)) this.entries.delete(key);
    }
  }
}

/** A simple one-file-per-step journal suitable for local durable replay. */
export class FileWorkflowJournal implements WorkflowJournal {
  constructor(private readonly directory: string) {}

  async get(runId: string, key: string): Promise<WorkflowJournalEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.entryPath(runId, key), 'utf8')) as WorkflowJournalEntry;
    } catch {
      return undefined;
    }
  }

  async put(entry: WorkflowJournalEntry): Promise<void> {
    const target = this.entryPath(entry.runId, entry.key);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify(entry, null, 2), 'utf8');
    await rename(temporary, target);
  }

  private entryPath(runId: string, key: string): string {
    const safeRunId = createHash('sha256').update(runId).digest('hex');
    return path.join(this.directory, safeRunId, `${key}.json`);
  }
}

export function workflowAgentCacheKey(input: {
  readonly workflowPath: string;
  readonly role: string;
  readonly occurrence: number;
  readonly prompt: string;
  readonly options: unknown;
}): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function journalEntryFromCall(
  call: WorkflowAgentCall,
  result: unknown,
  metadata?: { readonly harness?: string; readonly sessionId?: string },
): WorkflowJournalEntry {
  return {
    key: call.cacheKey,
    runId: call.runId,
    role: call.role,
    prompt: call.prompt,
    options: structuredClone(call.options),
    result: structuredClone(result),
    createdAt: Date.now(),
    ...(metadata?.harness === undefined ? {} : { harness: metadata.harness }),
    ...(metadata?.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
  };
}

export function cloneJournalResult(entry: WorkflowJournalEntry): unknown {
  return structuredClone(entry.result);
}

function storageKey(runId: string, key: string): string {
  return `${runId}:${key}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
