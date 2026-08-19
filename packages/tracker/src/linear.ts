/**
 * Linear tracker adapter.
 *
 * Normalizes Linear issues into Dark Kitchen Task/TaskDependency types.
 * Uses the Linear GraphQL API (SDK or direct HTTP).
 */

import type {
  Project,
  ProjectId,
  Task,
  TaskId,
  TaskDependency,
  TaskDependencyId,
  TrackerReference,
} from '@dark-kitchen/core';
import { createProjectId, createTaskId, createTaskDependencyId } from '@dark-kitchen/core';
import type {
  AddDependencyInput,
  CommentInput,
  CreateTaskInput,
  FullTrackerAdapter,
  TrackerTaskUpdate,
} from './contracts.js';
import { CyclicDependencyError, TrackerError, wouldCreateCycle } from './contracts.js';

export interface LinearAdapterConfig {
  /** Linear API key. */
  readonly apiKey: string;
  /** Linear team key (e.g. "ENG"). */
  readonly teamKey?: string;
  /**
   * Mapping of Dark Kitchen status → Linear state name.
   * Defaults to common Linear state names.
   */
  readonly statusMap?: Readonly<Partial<Record<Task['status'], string>>>;
}

const PROVIDER = 'linear';
const LINEAR_API_URL = 'https://api.linear.app/graphql';

const DEFAULT_STATUS_MAP: Readonly<Record<Task['status'], string>> = {
  backlog: 'Backlog',
  ready: 'Todo',
  active: 'In Progress',
  blocked: 'In Review',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export class LinearTrackerAdapter implements FullTrackerAdapter {
  public readonly provider = PROVIDER;
  private readonly config: LinearAdapterConfig;
  private readonly statusMap: Readonly<Record<Task['status'], string>>;
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly depsByTask = new Map<TaskId, Set<string>>();

  public constructor(config: LinearAdapterConfig) {
    this.config = config;
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...(config.statusMap ?? {}) };
  }

  public async getProject(reference: TrackerReference): Promise<Project> {
    // Linear "project" maps to a team or project
    const result = await this.graphql<{ team: { id: string; name: string } }>(
      `
      query GetTeam($key: String!) {
        team(key: $key) { id name }
      }
    `,
      { key: reference.id },
    );
    const team = result.team;
    if (!team) throw new TrackerError(`Linear team "${reference.id}" not found`);
    const projectId = createProjectId(`${PROVIDER}:${reference.id}`);
    const now = new Date().toISOString();
    return {
      id: projectId,
      name: team.name,
      trackerReference: { provider: PROVIDER, id: reference.id },
      createdAt: now,
      updatedAt: now,
    };
  }

  public async getTask(reference: TrackerReference): Promise<Task> {
    const result = await this.graphql<{ issue: LinearIssue }>(
      `
      query GetIssue($id: String!) {
        issue(id: $id) { id identifier title description state { name } labels { nodes { name } } createdAt updatedAt url }
      }
    `,
      { id: reference.id },
    );
    if (!result.issue) throw new TrackerError(`Linear issue "${reference.id}" not found`);
    return this.normalizeIssue(result.issue);
  }

  public async getTaskById(taskId: TaskId): Promise<Task | undefined> {
    const linearId = extractLinearId(taskId);
    if (!linearId) return undefined;
    try {
      const result = await this.graphql<{ issue: LinearIssue }>(
        `
        query GetIssue($id: String!) {
          issue(id: $id) { id identifier title description state { name } labels { nodes { name } } createdAt updatedAt url }
        }
      `,
        { id: linearId },
      );
      if (!result.issue) return undefined;
      return this.normalizeIssue(result.issue);
    } catch {
      return undefined;
    }
  }

  public async listTasks(projectId: ProjectId): Promise<readonly Task[]> {
    const teamKey = extractTeamKey(projectId) ?? this.config.teamKey;
    if (!teamKey) throw new TrackerError('Linear: teamKey required for listTasks');
    const result = await this.graphql<{ team: { issues: { nodes: LinearIssue[] } } }>(
      `
      query ListIssues($teamKey: String!) {
        team(key: $teamKey) { issues { nodes { id identifier title description state { name } labels { nodes { name } } createdAt updatedAt url } } }
      }
    `,
      { teamKey },
    );
    return (result.team?.issues?.nodes ?? []).map((i) => this.normalizeIssue(i));
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const teamId = await this.resolveTeamId();
    const result = await this.graphql<{ issueCreate: { issue: LinearIssue } }>(
      `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
          issue { id identifier title description state { name } createdAt updatedAt url }
        }
      }
    `,
      { teamId, title: input.title, description: input.description ?? null },
    );
    return this.normalizeIssue(result.issueCreate.issue);
  }

  public async updateTask(taskId: TaskId, update: TrackerTaskUpdate): Promise<Task> {
    const linearId = requireLinearId(taskId);
    const stateId = update.status ? await this.resolveStateId(update.status) : undefined;
    const result = await this.graphql<{ issueUpdate: { issue: LinearIssue } }>(
      `
      mutation UpdateIssue($id: String!, $title: String, $description: String, $stateId: String) {
        issueUpdate(id: $id, input: { title: $title, description: $description, stateId: $stateId }) {
          issue { id identifier title description state { name } createdAt updatedAt url }
        }
      }
    `,
      {
        id: linearId,
        title: update.title ?? null,
        description: update.description ?? null,
        stateId: stateId ?? null,
      },
    );
    return this.normalizeIssue(result.issueUpdate.issue);
  }

  public async closeTask(taskId: TaskId): Promise<Task> {
    return this.updateTask(taskId, { status: 'completed' });
  }

  public async reopenTask(taskId: TaskId): Promise<Task> {
    return this.updateTask(taskId, { status: 'backlog' });
  }

  public async addComment(input: CommentInput): Promise<void> {
    const linearId = requireLinearId(input.taskId);
    await this.graphql(
      `
      mutation AddComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }
    `,
      { issueId: linearId, body: input.body },
    );
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    const graph = this.buildDependencyGraph();
    if (wouldCreateCycle(graph, input.taskId, input.dependsOnTaskId)) {
      throw new CyclicDependencyError(input.taskId, input.dependsOnTaskId);
    }

    const fromId = requireLinearId(input.taskId);
    const toId = requireLinearId(input.dependsOnTaskId);

    await this.graphql(
      `
      mutation AddRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) { success }
      }
    `,
      { issueId: fromId, relatedIssueId: toId, type: 'blocked' },
    );

    const depId = createTaskDependencyId(`${PROVIDER}:${input.taskId}->${input.dependsOnTaskId}`);
    const dep: TaskDependency = {
      id: depId,
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      kind: input.kind ?? 'blocks',
    };
    this.dependencies.set(depId, dep);
    if (!this.depsByTask.has(input.taskId)) this.depsByTask.set(input.taskId, new Set());
    this.depsByTask.get(input.taskId)!.add(depId);
    return dep;
  }

  public async removeDependency(dependencyId: TaskDependencyId): Promise<void> {
    const dep = this.dependencies.get(dependencyId);
    if (!dep) return;
    // Linear relation removal requires the relation ID (not stored here; best-effort)
    this.depsByTask.get(dep.taskId)?.delete(dependencyId);
    this.dependencies.delete(dependencyId);
  }

  public async listDependencies(taskId: TaskId): Promise<readonly TaskDependency[]> {
    const depIds = this.depsByTask.get(taskId) ?? new Set<string>();
    return [...depIds]
      .map((id) => this.dependencies.get(id))
      .filter((d): d is TaskDependency => d !== undefined);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private normalizeIssue(issue: LinearIssue): Task {
    const taskId = createTaskId(`${PROVIDER}:${issue.identifier ?? issue.id}`);
    const projectId = createProjectId(`${PROVIDER}:team`);
    const status = this.linearStateToStatus(issue.state?.name ?? '');
    const base: Task = {
      id: taskId,
      projectId,
      title: issue.title,
      status,
      trackerReference: issue.url
        ? { provider: PROVIDER, id: issue.id, url: issue.url }
        : { provider: PROVIDER, id: issue.id },
      createdAt: issue.createdAt ?? new Date().toISOString(),
      updatedAt: issue.updatedAt ?? new Date().toISOString(),
    };
    if (issue.description) Object.assign(base, { description: issue.description });
    return base;
  }

  private linearStateToStatus(stateName: string): Task['status'] {
    const lower = stateName.toLowerCase();
    if (lower.includes('done') || lower.includes('completed')) return 'completed';
    if (lower.includes('cancel')) return 'cancelled';
    if (lower.includes('in progress') || lower.includes('active')) return 'active';
    if (lower.includes('review') || lower.includes('block')) return 'blocked';
    if (lower.includes('todo') || lower.includes('ready')) return 'ready';
    return 'backlog';
  }

  private buildDependencyGraph(): Map<TaskId, Set<TaskId>> {
    const graph = new Map<TaskId, Set<TaskId>>();
    for (const dep of this.dependencies.values()) {
      if (!graph.has(dep.taskId)) graph.set(dep.taskId, new Set());
      graph.get(dep.taskId)!.add(dep.dependsOnTaskId);
    }
    return graph;
  }

  private async resolveTeamId(): Promise<string> {
    if (!this.config.teamKey) throw new TrackerError('Linear: teamKey required');
    const result = await this.graphql<{ team: { id: string } }>(
      `
      query GetTeamId($key: String!) { team(key: $key) { id } }
    `,
      { key: this.config.teamKey },
    );
    if (!result.team?.id) throw new TrackerError(`Linear team "${this.config.teamKey}" not found`);
    return result.team.id;
  }

  private async resolveStateId(_status: Task['status']): Promise<string | undefined> {
    // In a real impl, fetch workflow states and find the matching one.
    return undefined;
  }

  private async graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new TrackerError(`Linear API error: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new TrackerError(
        `Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`,
      );
    }
    return json.data as T;
  }
}

interface LinearIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  state?: { name: string };
  labels?: { nodes: Array<{ name: string }> };
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function extractLinearId(taskId: TaskId): string | null {
  const match = /^linear:(.+)$/.exec(taskId);
  return match?.[1] ?? null;
}

function requireLinearId(taskId: TaskId): string {
  const id = extractLinearId(taskId);
  if (!id) throw new TrackerError(`Cannot extract Linear ID from task ID: ${taskId}`);
  return id;
}

function extractTeamKey(projectId: ProjectId): string | null {
  const match = /^linear:(.+)$/.exec(projectId);
  return match?.[1] ?? null;
}
