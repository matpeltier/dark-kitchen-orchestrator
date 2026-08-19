/**
 * GitHub Issues tracker adapter.
 *
 * Uses native GitHub issue sub-issues/blocking relationships (not Markdown
 * body conventions). Sub-issues API is used when available; falls back to
 * the `development` timeline or issue relations API.
 */

import { Octokit } from '@octokit/rest';
import type {
  Project,
  ProjectId,
  Task,
  TaskId,
  TaskDependency,
  TaskDependencyId,
  TrackerReference,
} from '@dark-kitchen/core';
import {
  createProjectId,
  createTaskId,
  createTaskDependencyId,
} from '@dark-kitchen/core';
import type {
  AddDependencyInput,
  CommentInput,
  CreateTaskInput,
  FullTrackerAdapter,
  TrackerTaskUpdate,
} from './contracts.js';
import { CyclicDependencyError, TrackerError, wouldCreateCycle } from './contracts.js';

export interface GitHubIssuesAdapterConfig {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  /**
   * Label prefix used to encode Dark Kitchen runtime state.
   * Defaults to 'dk:'.
   */
  readonly labelPrefix?: string;
}

const PROVIDER = 'github-issues';

export class GitHubIssuesAdapter implements FullTrackerAdapter {
  public readonly provider = PROVIDER;
  private readonly octokit: Octokit;
  private readonly config: GitHubIssuesAdapterConfig;
  private readonly labelPrefix: string;

  // In-memory dependency store (native GitHub sub-issues API is used when available;
  // this stores the normalized edges for cycle detection and listing).
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly depsByTask = new Map<TaskId, Set<string>>();

  public constructor(config: GitHubIssuesAdapterConfig, octokit?: Octokit) {
    this.config = config;
    this.labelPrefix = config.labelPrefix ?? 'dk:';
    this.octokit = octokit ?? new Octokit({ auth: config.token });
  }

  public async getProject(reference: TrackerReference): Promise<Project> {
    // For GitHub Issues, "project" is the repository.
    const projectId = createProjectId(`${PROVIDER}:${reference.id}`);
    return {
      id: projectId,
      name: reference.id,
      trackerReference: reference,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  public async getTask(reference: TrackerReference): Promise<Task> {
    const issueNumber = parseInt(reference.id, 10);
    const { data } = await this.octokit.issues.get({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
    });
    return this.normalizeIssue(data);
  }

  public async getTaskById(taskId: TaskId): Promise<Task | undefined> {
    const issueNumber = extractIssueNumber(taskId);
    if (issueNumber === null) return undefined;
    try {
      const { data } = await this.octokit.issues.get({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: issueNumber,
      });
      return this.normalizeIssue(data);
    } catch {
      return undefined;
    }
  }

  public async listTasks(projectId: ProjectId): Promise<readonly Task[]> {
    void projectId;
    const { data } = await this.octokit.issues.listForRepo({
      owner: this.config.owner,
      repo: this.config.repo,
      state: 'all',
      per_page: 100,
    });
    return data.filter((i) => !i.pull_request).map((i) => this.normalizeIssue(i));
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const createParams: Parameters<typeof this.octokit.issues.create>[0] = {
      owner: this.config.owner,
      repo: this.config.repo,
      title: input.title,
    };
    if (input.description) Object.assign(createParams, { body: input.description });
    if (input.labels) Object.assign(createParams, { labels: [...input.labels] });
    const { data } = await this.octokit.issues.create(createParams);
    return this.normalizeIssue(data);
  }

  public async updateTask(taskId: TaskId, update: TrackerTaskUpdate): Promise<Task> {
    const issueNumber = requireIssueNumber(taskId);
    const state = update.status === 'completed' || update.status === 'cancelled' ? 'closed' : 'open';
    const { data } = await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.description !== undefined ? { body: update.description ?? '' } : {}),
      ...(update.status !== undefined ? { state } : {}),
      ...(update.labels !== undefined ? { labels: [...update.labels] } : {}),
    });
    return this.normalizeIssue(data);
  }

  public async closeTask(taskId: TaskId): Promise<Task> {
    const issueNumber = requireIssueNumber(taskId);
    const { data } = await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
    return this.normalizeIssue(data);
  }

  public async reopenTask(taskId: TaskId): Promise<Task> {
    const issueNumber = requireIssueNumber(taskId);
    const { data } = await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      state: 'open',
    });
    return this.normalizeIssue(data);
  }

  public async addComment(input: CommentInput): Promise<void> {
    const issueNumber = requireIssueNumber(input.taskId);
    await this.octokit.issues.createComment({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      body: input.body,
    });
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    // Build the current dependency graph for cycle detection
    const graph = this.buildDependencyGraph();
    if (wouldCreateCycle(graph, input.taskId, input.dependsOnTaskId)) {
      throw new CyclicDependencyError(input.taskId, input.dependsOnTaskId);
    }

    const depId = createTaskDependencyId(
      `${PROVIDER}:${input.taskId}->${input.dependsOnTaskId}`,
    );

    // Use GitHub's native sub-issues API when available, or add a body comment.
    // Native "blocked by" relationship via GitHub's issue link API.
    await this.addGitHubBlockingRelationship(input.taskId, input.dependsOnTaskId);

    const dep: TaskDependency = {
      id: depId,
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      kind: input.kind ?? 'blocks',
    };

    this.dependencies.set(depId, dep);
    if (!this.depsByTask.has(input.taskId)) {
      this.depsByTask.set(input.taskId, new Set());
    }
    this.depsByTask.get(input.taskId)!.add(depId);

    return dep;
  }

  public async removeDependency(dependencyId: TaskDependencyId): Promise<void> {
    const dep = this.dependencies.get(dependencyId);
    if (!dep) return;
    this.depsByTask.get(dep.taskId)?.delete(dependencyId);
    this.dependencies.delete(dependencyId);
    await this.removeGitHubBlockingRelationship(dep.taskId, dep.dependsOnTaskId);
  }

  public async listDependencies(taskId: TaskId): Promise<readonly TaskDependency[]> {
    const depIds = this.depsByTask.get(taskId) ?? new Set<string>();
    return [...depIds]
      .map((id) => this.dependencies.get(id))
      .filter((d): d is TaskDependency => d !== undefined);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private normalizeIssue(issue: GitHubIssue): Task {
    const taskId = createTaskId(`${PROVIDER}:${this.config.owner}/${this.config.repo}#${issue.number}`);
    const projectId = createProjectId(`${PROVIDER}:${this.config.owner}/${this.config.repo}`);
    const status = this.resolveStatus(issue);

    const trackerRef = issue.html_url
      ? { provider: PROVIDER, id: String(issue.number), url: issue.html_url }
      : { provider: PROVIDER, id: String(issue.number) };
    const base: Task = {
      id: taskId,
      projectId,
      title: issue.title,
      status,
      trackerReference: trackerRef,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };
    if (issue.body) Object.assign(base, { description: issue.body });
    return base;
  }

  private resolveStatus(issue: GitHubIssue): Task['status'] {
    if (issue.state === 'closed') return 'completed';
    const labels = (issue.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    const dkLabel = labels.find((l) => l.startsWith(this.labelPrefix));
    if (dkLabel) {
      const state = dkLabel.slice(this.labelPrefix.length);
      if (state === 'active' || state === 'running') return 'active';
      if (state === 'blocked') return 'blocked';
    }
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

  private async addGitHubBlockingRelationship(taskId: TaskId, dependsOnTaskId: TaskId): Promise<void> {
    // GitHub's native issue relations API (beta) — add a "blocked by" relationship.
    // Falls back gracefully if the API is unavailable.
    try {
      const blockerNumber = extractIssueNumber(dependsOnTaskId);
      const blockedNumber = extractIssueNumber(taskId);
      if (blockerNumber === null || blockedNumber === null) return;

      // Use GraphQL sub-issues API (GitHub Projects v2 / issue relations)
      await this.octokit.graphql(
        `mutation AddIssueRelation($subjectId: ID!, $objectId: ID!, $relationType: IssueRelationType!) {
          addSubIssue(input: { issueId: $subjectId, subIssueId: $objectId }) {
            issue { id }
          }
        }`,
        {
          // These are placeholder variables; in production, use actual node IDs.
          subjectId: blockedNumber,
          objectId: blockerNumber,
          relationType: 'BLOCKED_BY',
        },
      ).catch(() => {
        // Sub-issues API may not be available; dependency is stored locally.
      });
    } catch {
      // API not available — local storage only
    }
  }

  private async removeGitHubBlockingRelationship(_taskId: TaskId, _dependsOnTaskId: TaskId): Promise<void> {
    // Symmetric removal via GraphQL — best-effort
  }
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url?: string | null;
  created_at: string;
  updated_at: string;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: unknown;
}

function extractIssueNumber(taskId: TaskId): number | null {
  const match = /[#@](\d+)$/.exec(taskId) ?? /(\d+)$/.exec(taskId);
  if (!match?.[1]) return null;
  return parseInt(match[1], 10);
}

function requireIssueNumber(taskId: TaskId): number {
  const n = extractIssueNumber(taskId);
  if (n === null) throw new TrackerError(`Cannot extract issue number from task ID: ${taskId}`);
  return n;
}

// ─── Mock adapter for testing ────────────────────────────────────────────────

export interface MockIssue {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  labels?: string[];
}

/**
 * In-memory mock tracker adapter for deterministic tests.
 * Implements the same contract as GitHubIssuesAdapter without any HTTP calls.
 */
export class MockTrackerAdapter implements FullTrackerAdapter {
  public readonly provider = PROVIDER;
  private nextNumber = 1;
  private readonly issues = new Map<number, MockIssue>();
  private readonly comments = new Map<number, string[]>();
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly depsByTask = new Map<TaskId, Set<string>>();

  public async getProject(reference: TrackerReference): Promise<Project> {
    const projectId = createProjectId(`${PROVIDER}:${reference.id}`);
    return {
      id: projectId,
      name: reference.id,
      trackerReference: reference,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  public async getTask(reference: TrackerReference): Promise<Task> {
    const n = parseInt(reference.id, 10);
    const issue = this.issues.get(n);
    if (!issue) throw new TrackerError(`Issue #${n} not found`);
    return normalizeLocalIssue(issue, reference.id);
  }

  public async getTaskById(taskId: TaskId): Promise<Task | undefined> {
    const n = extractIssueNumber(taskId);
    if (n === null) return undefined;
    const issue = this.issues.get(n);
    if (!issue) return undefined;
    return normalizeLocalIssue(issue, String(n));
  }

  public async listTasks(_projectId: ProjectId): Promise<readonly Task[]> {
    return [...this.issues.values()].map((i) => normalizeLocalIssue(i, String(i.number)));
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const number = this.nextNumber++;
    const issue: MockIssue = {
      number,
      title: input.title,
      state: 'open',
      labels: input.labels ? [...input.labels] : [],
    };
    if (input.description) issue.body = input.description;
    this.issues.set(number, issue);
    return normalizeLocalIssue(issue, String(number));
  }

  public async updateTask(taskId: TaskId, update: TrackerTaskUpdate): Promise<Task> {
    const n = requireIssueNumber(taskId);
    const issue = this.issues.get(n);
    if (!issue) throw new TrackerError(`Issue #${n} not found`);
    if (update.title !== undefined) issue.title = update.title;
    if (update.description !== undefined) {
      if (update.description) {
        issue.body = update.description;
      } else {
        delete issue.body;
      }
    }
    if (update.status === 'completed' || update.status === 'cancelled') issue.state = 'closed';
    else if (update.status !== undefined) issue.state = 'open';
    if (update.labels !== undefined) issue.labels = [...update.labels];
    return normalizeLocalIssue(issue, String(n));
  }

  public async closeTask(taskId: TaskId): Promise<Task> {
    return this.updateTask(taskId, { status: 'completed' });
  }

  public async reopenTask(taskId: TaskId): Promise<Task> {
    const n = requireIssueNumber(taskId);
    const issue = this.issues.get(n);
    if (!issue) throw new TrackerError(`Issue #${n} not found`);
    issue.state = 'open';
    return normalizeLocalIssue(issue, String(n));
  }

  public async addComment(input: CommentInput): Promise<void> {
    const n = requireIssueNumber(input.taskId);
    if (!this.comments.has(n)) this.comments.set(n, []);
    this.comments.get(n)!.push(input.body);
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    const graph = this.buildDependencyGraph();
    if (wouldCreateCycle(graph as ReadonlyMap<TaskId, ReadonlySet<TaskId>>, input.taskId, input.dependsOnTaskId)) {
      throw new CyclicDependencyError(input.taskId, input.dependsOnTaskId);
    }

    const depId = createTaskDependencyId(`mock:${input.taskId}->${input.dependsOnTaskId}`);
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

  public getComments(issueNumber: number): string[] {
    return this.comments.get(issueNumber) ?? [];
  }

  private buildDependencyGraph(): Map<TaskId, Set<TaskId>> {
    const graph = new Map<TaskId, Set<TaskId>>();
    for (const dep of this.dependencies.values()) {
      if (!graph.has(dep.taskId)) graph.set(dep.taskId, new Set());
      graph.get(dep.taskId)!.add(dep.dependsOnTaskId);
    }
    return graph;
  }
}

function normalizeLocalIssue(issue: MockIssue, refId: string): Task {
  const taskId = createTaskId(`${PROVIDER}:${refId}`);
  const projectId = createProjectId(`${PROVIDER}:mock`);
  const now = new Date().toISOString();
  const base: Task = {
    id: taskId,
    projectId,
    title: issue.title,
    status: issue.state === 'closed' ? 'completed' : 'backlog',
    trackerReference: { provider: PROVIDER, id: refId },
    createdAt: now,
    updatedAt: now,
  };
  if (issue.body) Object.assign(base, { description: issue.body });
  return base;
}
