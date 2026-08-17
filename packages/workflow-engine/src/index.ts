import { readFile } from 'node:fs/promises';

import { parseWorkflowScript } from './parser.js';
export {
  WorkflowAbortError,
  WorkflowAgentCapError,
  WorkflowBudgetExceededError,
  WorkflowInputError,
} from './errors.js';
export {
  cloneJournalResult,
  FileWorkflowJournal,
  InMemoryWorkflowJournal,
  journalEntryFromCall,
  workflowAgentCacheKey,
} from './journal.js';
export { parseWorkflowScript };
export { runWorkflow } from './runtime.js';
export { ScriptedHarnessRunner, ScriptedHarnessRunner as ScriptedAgentRunner } from './scripted.js';
export type { ScriptedHarnessHandler } from './scripted.js';
export type * from './types.js';

/** A small in-process name resolver useful for nested workflows and tests. */
export class WorkflowRegistry {
  private readonly workflows = new Map<
    string,
    { readonly script: string; readonly name: string }
  >();

  register(script: string): string {
    const meta = parseWorkflowScript(script).meta;
    this.workflows.set(meta.name, { script, name: meta.name });
    return meta.name;
  }

  async resolve(
    ref: import('./types.js').WorkflowRef,
  ): Promise<{ readonly script: string; readonly name: string }> {
    const name = typeof ref === 'string' ? ref : ref.name;
    const scriptPath = typeof ref === 'string' ? undefined : ref.scriptPath;
    const workflow = name === undefined ? undefined : this.workflows.get(name);
    if (workflow) return workflow;
    if (scriptPath !== undefined) {
      const script = await readFile(scriptPath, 'utf8');
      const parsed = parseWorkflowScript(script);
      return { script, name: parsed.meta.name };
    }
    throw new Error(`Workflow "${name ?? 'unknown'}" not found`);
  }
}
