/** Minimal normalized task shape used for deterministic workflow assignment. */
export interface WorkflowSelectionTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status?:
    | 'backlog'
    | 'ready'
    | 'active'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly verificationProfileIds?: readonly string[] | undefined;
}

export interface WorkflowTaskSelector {
  readonly taskIds?: readonly string[] | undefined;
  readonly statuses?: readonly NonNullable<WorkflowSelectionTask['status']>[] | undefined;
  readonly labelsAny?: readonly string[] | undefined;
  readonly labelsAll?: readonly string[] | undefined;
  readonly titleIncludes?: readonly string[] | undefined;
  readonly descriptionIncludes?: readonly string[] | undefined;
  readonly verificationProfilesAny?: readonly string[] | undefined;
}

export interface SelectableWorkflowConfig {
  readonly id: string;
  readonly default?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly taskSelector?: WorkflowTaskSelector | undefined;
}

/**
 * Select a configured workflow for a normalized task.
 *
 * Every predicate group in a selector must match. `*Any`/text groups require
 * one value from that group; `labelsAll` requires every configured label.
 * Highest priority wins and declaration order is the stable tie-breaker.
 * With no match, the explicit default wins, then the first workflow preserves
 * compatibility with pre-selector configuration.
 */
export function selectWorkflowForTask<T extends SelectableWorkflowConfig>(
  workflows: readonly T[],
  task: WorkflowSelectionTask,
): T | undefined {
  const matches = workflows
    .map((workflow, index) => ({ workflow, index }))
    .filter(({ workflow }) =>
      workflow.taskSelector ? matchesTaskSelector(workflow.taskSelector, task) : false,
    )
    .sort(
      (left, right) =>
        (right.workflow.priority ?? 0) - (left.workflow.priority ?? 0) || left.index - right.index,
    );

  return (
    matches[0]?.workflow ?? workflows.find((workflow) => workflow.default === true) ?? workflows[0]
  );
}

export function matchesTaskSelector(
  selector: WorkflowTaskSelector,
  task: WorkflowSelectionTask,
): boolean {
  const labels = new Set((task.labels ?? []).map(normalize));
  const verificationProfiles = new Set((task.verificationProfileIds ?? []).map(normalize));
  const title = normalize(task.title);
  const description = normalize(task.description ?? '');

  if (selector.taskIds && !selector.taskIds.includes(task.id)) return false;
  if (selector.statuses && (!task.status || !selector.statuses.includes(task.status))) return false;
  if (selector.labelsAny && !selector.labelsAny.some((label) => labels.has(normalize(label)))) {
    return false;
  }
  if (selector.labelsAll && !selector.labelsAll.every((label) => labels.has(normalize(label)))) {
    return false;
  }
  if (
    selector.titleIncludes &&
    !selector.titleIncludes.some((fragment) => title.includes(normalize(fragment)))
  ) {
    return false;
  }
  if (
    selector.descriptionIncludes &&
    !selector.descriptionIncludes.some((fragment) => description.includes(normalize(fragment)))
  ) {
    return false;
  }
  if (
    selector.verificationProfilesAny &&
    !selector.verificationProfilesAny.some((profile) =>
      verificationProfiles.has(normalize(profile)),
    )
  ) {
    return false;
  }
  return true;
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
