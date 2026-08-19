/**
 * Jira tracker adapter.
 *
 * Normalizes Jira issues and issue links into Dark Kitchen Task/TaskDependency types.
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

export interface JiraAdapterConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly email: string;
  readonly projectKey: string;
  /**
   * The Jira issue link type used for "blocks" relationships.
   * Defaults to "Blocks".
   */
  readonly blocksLinkType?: string;
  /**
   * Transition names for Dark Kitchen statuses.
   */
  readonly transitionMap?: Readonly<Partial<Record<Task['status'], string>>>;
}

const PROVIDER = 'jira';

const DEFAULT_TRANSITION_MAP: Readonly<Record<Task['status'], string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  active: 'In Progress',
  blocked: 'In Review',
  completed: 'Done',
  cancelled: "Won't Do",
};

export class JiraTrackerAdapter implements FullTrackerAdapter {
  public readonly provider = PROVIDER;
  private readonly config: JiraAdapterConfig;
  private readonly transitionMap: Readonly<Record<Task['status'], string>>;
  private readonly blocksLinkType: string;
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly depsByTask = new Map<TaskId, Set<string>>();

  public constructor(config: JiraAdapterConfig) {
    this.config = config;
    this.transitionMap = { ...DEFAULT_TRANSITION_MAP, ...(config.transitionMap ?? {}) };
    this.blocksLinkType = config.blocksLinkType ?? 'Blocks';
  }

  public async getProject(reference: TrackerReference): Promise<Project> {
    const data = await this.jiraGet<{ id: string; key: string; name: string }>(
      `/rest/api/3/project/${reference.id}`,
    );
    const projectId = createProjectId(`${PROVIDER}:${reference.id}`);
    const now = new Date().toISOString();
    return {
      id: projectId,
      name: data.name,
      trackerReference: { provider: PROVIDER, id: reference.id },
      createdAt: now,
      updatedAt: now,
    };
  }

  public async getTask(reference: TrackerReference): Promise<Task> {
    const data = await this.jiraGet<JiraIssue>(`/rest/api/3/issue/${reference.id}`);
    return this.normalizeIssue(data);
  }

  public async getTaskById(taskId: TaskId): Promise<Task | undefined> {
    const key = extractJiraKey(taskId);
    if (!key) return undefined;
    try {
      const data = await this.jiraGet<JiraIssue>(`/rest/api/3/issue/${key}`);
      return this.normalizeIssue(data);
    } catch {
      return undefined;
    }
  }

  public async listTasks(_projectId: ProjectId): Promise<readonly Task[]> {
    const data = await this.jiraGet<{ issues: JiraIssue[] }>(
      `/rest/api/3/search?jql=project=${this.config.projectKey}&maxResults=100`,
    );
    return (data.issues ?? []).map((i) => this.normalizeIssue(i));
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: input.title,
        description: input.description ?? undefined,
        issuetype: { name: 'Task' },
      },
    };
    const data = await this.jiraPost<{ id: string; key: string }>('/rest/api/3/issue', body);
    return this.getTask({ provider: PROVIDER, id: data.key });
  }

  public async updateTask(taskId: TaskId, update: TrackerTaskUpdate): Promise<Task> {
    const key = requireJiraKey(taskId);
    const fields: Record<string, unknown> = {};
    if (update.title !== undefined) fields['summary'] = update.title;
    if (update.description !== undefined) fields['description'] = update.description;
    if (Object.keys(fields).length > 0) {
      await this.jiraPut(`/rest/api/3/issue/${key}`, { fields });
    }
    if (update.status !== undefined) {
      await this.transitionIssue(key, update.status);
    }
    return this.getTask({ provider: PROVIDER, id: key });
  }

  public async closeTask(taskId: TaskId): Promise<Task> {
    return this.updateTask(taskId, { status: 'completed' });
  }

  public async reopenTask(taskId: TaskId): Promise<Task> {
    return this.updateTask(taskId, { status: 'backlog' });
  }

  public async addComment(input: CommentInput): Promise<void> {
    const key = requireJiraKey(input.taskId);
    await this.jiraPost(`/rest/api/3/issue/${key}/comment`, { body: input.body });
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    const graph = this.buildDependencyGraph();
    if (wouldCreateCycle(graph, input.taskId, input.dependsOnTaskId)) {
      throw new CyclicDependencyError(input.taskId, input.dependsOnTaskId);
    }

    const fromKey = requireJiraKey(input.taskId);
    const toKey = requireJiraKey(input.dependsOnTaskId);

    await this.jiraPost('/rest/api/3/issueLink', {
      type: { name: this.blocksLinkType },
      inwardIssue: { key: fromKey },
      outwardIssue: { key: toKey },
    });

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

  private normalizeIssue(issue: JiraIssue): Task {
    const taskId = createTaskId(`${PROVIDER}:${issue.key}`);
    const projectId = createProjectId(`${PROVIDER}:${this.config.projectKey}`);
    const status = this.jiraStatusToStatus(issue.fields?.status?.name ?? '');
    const base: Task = {
      id: taskId,
      projectId,
      title: issue.fields?.summary ?? issue.key,
      status,
      trackerReference: {
        provider: PROVIDER,
        id: issue.key,
        url: `${this.config.baseUrl}/browse/${issue.key}`,
      },
      createdAt: issue.fields?.created ?? new Date().toISOString(),
      updatedAt: issue.fields?.updated ?? new Date().toISOString(),
    };
    if (issue.fields?.description)
      Object.assign(base, { description: String(issue.fields.description) });
    return base;
  }

  private jiraStatusToStatus(statusName: string): Task['status'] {
    const lower = statusName.toLowerCase();
    if (lower.includes('done') || lower.includes('completed') || lower.includes('resolved'))
      return 'completed';
    if (lower.includes('cancel') || lower.includes("won't")) return 'cancelled';
    if (lower.includes('in progress') || lower.includes('active')) return 'active';
    if (lower.includes('review') || lower.includes('block')) return 'blocked';
    if (lower.includes('ready') || lower.includes('todo')) return 'ready';
    return 'backlog';
  }

  private async transitionIssue(key: string, status: Task['status']): Promise<void> {
    const transitionName = this.transitionMap[status];
    const { transitions } = await this.jiraGet<{
      transitions: Array<{ id: string; name: string }>;
    }>(`/rest/api/3/issue/${key}/transitions`);
    const transition = transitions.find((t) => t.name === transitionName);
    if (!transition) return; // Transition may not be available; fail silently
    await this.jiraPost(`/rest/api/3/issue/${key}/transitions`, {
      transition: { id: transition.id },
    });
  }

  private buildDependencyGraph(): Map<TaskId, Set<TaskId>> {
    const graph = new Map<TaskId, Set<TaskId>>();
    for (const dep of this.dependencies.values()) {
      if (!graph.has(dep.taskId)) graph.set(dep.taskId, new Set());
      graph.get(dep.taskId)!.add(dep.dependsOnTaskId);
    }
    return graph;
  }

  private get baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64')}`,
    };
  }

  private async jiraGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, { headers: this.baseHeaders });
    if (!res.ok) throw new TrackerError(`Jira API error: ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  private async jiraPost<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new TrackerError(`Jira API error: ${res.status} ${res.statusText}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async jiraPut<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new TrackerError(`Jira API error: ${res.status} ${res.statusText}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name: string };
    created?: string;
    updated?: string;
  };
}

function extractJiraKey(taskId: TaskId): string | null {
  const match = /^jira:(.+)$/.exec(taskId);
  return match?.[1] ?? null;
}

function requireJiraKey(taskId: TaskId): string {
  const key = extractJiraKey(taskId);
  if (!key) throw new TrackerError(`Cannot extract Jira key from task ID: ${taskId}`);
  return key;
}
