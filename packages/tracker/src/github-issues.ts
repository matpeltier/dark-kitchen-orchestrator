/**
 * GitHub Issues tracker adapter.
 *
 * Uses GitHub's native issue dependency API. Tracker bodies are never used as
 * a dependency database and native API failures fail closed.
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
import { createProjectId, createTaskId, createTaskDependencyId } from '@dark-kitchen/core';
import type {
  AddDependencyInput,
  CommentInput,
  CreateTaskInput,
  FullTrackerAdapter,
  TrackerComment,
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
    const state =
      update.status === 'completed' || update.status === 'cancelled' ? 'closed' : 'open';
    // When a task returns to 'ready', swap the DK state label (e.g. dk:blocked)
    // back to dk:ready so the scheduler picks it up again — mirror of setBlocked.
    let labels: string[] | undefined;
    if (update.status === 'ready') {
      const { data: current } = await this.octokit.issues.get({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: issueNumber,
      });
      const currentLabels = (current.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean);
      labels = [
        ...currentLabels.filter((l) => !l.startsWith(this.labelPrefix)),
        `${this.labelPrefix}ready`,
      ];
    }
    const { data } = await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.description !== undefined ? { body: update.description ?? '' } : {}),
      ...(update.status !== undefined ? { state } : {}),
      ...(labels !== undefined
        ? { labels }
        : update.labels !== undefined
          ? { labels: [...update.labels] }
          : {}),
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

  public async setBlocked(taskId: TaskId): Promise<void> {
    const issueNumber = requireIssueNumber(taskId);
    const { data } = await this.octokit.issues.get({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
    });
    const current = (data.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter(Boolean);
    const next = [
      ...current.filter(
        (l) =>
          l !== 'dk:ready' &&
          l !== 'dk:active' &&
          l !== 'dk:running' &&
          !l.startsWith('dk:blocked'),
      ),
      'dk:blocked',
    ];
    await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      labels: next,
    });
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

  public async listComments(taskId: TaskId): Promise<readonly TrackerComment[]> {
    const issueNumber = requireIssueNumber(taskId);
    const { data } = await this.octokit.issues.listComments({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return data.map((comment) => ({
      id: String(comment.id),
      taskId,
      body: comment.body ?? '',
      ...(comment.user?.login ? { author: comment.user.login } : {}),
      createdAt: comment.created_at,
      ...(comment.html_url ? { url: comment.html_url } : {}),
    }));
  }

  public async setAutonomousApproval(taskId: TaskId, approved: boolean): Promise<Task> {
    const issueNumber = requireIssueNumber(taskId);
    const { data: current } = await this.octokit.issues.get({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
    });
    const labels = (current.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((label) => Boolean(label) && !label.startsWith(this.labelPrefix));
    if (approved) labels.push(`${this.labelPrefix}ready`);
    const { data } = await this.octokit.issues.update({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      state: 'open',
      labels,
    });
    return this.normalizeIssue(data);
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    const graph = await this.loadNativeDependencyGraph();
    if (wouldCreateCycle(graph, input.taskId, input.dependsOnTaskId)) {
      throw new CyclicDependencyError(input.taskId, input.dependsOnTaskId);
    }

    const depId = createTaskDependencyId(`${PROVIDER}:${input.taskId}->${input.dependsOnTaskId}`);
    const dep: TaskDependency = {
      id: depId,
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      kind: input.kind ?? 'blocks',
    };
    const existing = await this.listDependencies(input.taskId);
    if (existing.some((candidate) => candidate.dependsOnTaskId === input.dependsOnTaskId)) {
      return dep;
    }
    await this.addGitHubBlockingRelationship(input.taskId, input.dependsOnTaskId);
    return dep;
  }

  public async removeDependency(dependencyId: TaskDependencyId): Promise<void> {
    const dep = parseDependencyId(dependencyId);
    if (!dep) throw new TrackerError(`Invalid GitHub dependency ID: ${dependencyId}`);
    const existing = await this.listDependencies(dep.taskId);
    if (!existing.some((candidate) => candidate.dependsOnTaskId === dep.dependsOnTaskId)) return;
    await this.removeGitHubBlockingRelationship(dep.taskId, dep.dependsOnTaskId);
  }

  public async listDependencies(taskId: TaskId): Promise<readonly TaskDependency[]> {
    const issueNumber = requireIssueNumber(taskId);
    const blockedBy = await this.requestNativeDependencies(issueNumber);
    return blockedBy.map((issue) => {
      const dependsOnTaskId = createTaskId(
        `${PROVIDER}:${this.config.owner}/${this.config.repo}#${String(issue.number)}`,
      );
      return {
        id: createTaskDependencyId(`${PROVIDER}:${taskId}->${dependsOnTaskId}`),
        taskId,
        dependsOnTaskId,
        kind: 'blocks' as const,
      };
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private normalizeIssue(issue: GitHubIssue): Task {
    const taskId = createTaskId(
      `${PROVIDER}:${this.config.owner}/${this.config.repo}#${issue.number}`,
    );
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
    const labels = (issue.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter(Boolean);
    if (labels.length > 0) Object.assign(base, { labels });
    if (issue.body) Object.assign(base, { description: issue.body });
    return base;
  }

  private resolveStatus(issue: GitHubIssue): Task['status'] {
    if (issue.state === 'closed') return 'completed';
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const dkLabel = labels.find((l) => l.startsWith(this.labelPrefix));
    if (dkLabel) {
      const state = dkLabel.slice(this.labelPrefix.length);
      if (state === 'ready') return 'ready';
      if (state === 'active' || state === 'running') return 'active';
      if (state === 'blocked') return 'blocked';
    }
    return 'backlog';
  }

  private async loadNativeDependencyGraph(): Promise<Map<TaskId, Set<TaskId>>> {
    const graph = new Map<TaskId, Set<TaskId>>();
    const tasks = await this.listTasks(
      createProjectId(`${PROVIDER}:${this.config.owner}/${this.config.repo}`),
    );
    for (const task of tasks) {
      const dependencies = await this.listDependencies(task.id);
      if (dependencies.length === 0) continue;
      graph.set(task.id, new Set(dependencies.map((dependency) => dependency.dependsOnTaskId)));
    }
    return graph;
  }

  private async addGitHubBlockingRelationship(
    taskId: TaskId,
    dependsOnTaskId: TaskId,
  ): Promise<void> {
    const blockerNumber = requireIssueNumber(dependsOnTaskId);
    const blockedNumber = requireIssueNumber(taskId);
    const { data: blocker } = await this.octokit.issues.get({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: blockerNumber,
    });
    await this.octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: blockedNumber,
        issue_id: blocker.id,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
        },
      },
    );
  }

  private async removeGitHubBlockingRelationship(
    taskId: TaskId,
    dependsOnTaskId: TaskId,
  ): Promise<void> {
    const blockerNumber = requireIssueNumber(dependsOnTaskId);
    const blockedNumber = requireIssueNumber(taskId);
    const { data: blocker } = await this.octokit.issues.get({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: blockerNumber,
    });
    await this.octokit.request(
      'DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: blockedNumber,
        issue_id: blocker.id,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
        },
      },
    );
  }

  private async requestNativeDependencies(
    issueNumber: number,
  ): Promise<readonly { readonly id: number; readonly number: number }[]> {
    const response = await this.octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: issueNumber,
        per_page: 100,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
        },
      },
    );
    if (!Array.isArray(response.data)) {
      throw new TrackerError('GitHub returned an invalid native dependency response.');
    }
    return response.data.map((issue) => ({
      id: Number((issue as { id: unknown }).id),
      number: Number((issue as { number: unknown }).number),
    }));
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

function parseDependencyId(
  dependencyId: TaskDependencyId,
): { readonly taskId: TaskId; readonly dependsOnTaskId: TaskId } | undefined {
  const prefix = `${PROVIDER}:`;
  if (!dependencyId.startsWith(prefix)) return undefined;
  const parts = dependencyId.slice(prefix.length).split('->');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return {
    taskId: createTaskId(parts[0]),
    dependsOnTaskId: createTaskId(parts[1]),
  };
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
    return this.updateTask(taskId, { status: 'backlog' });
  }

  public async setBlocked(taskId: TaskId): Promise<void> {
    const n = requireIssueNumber(taskId);
    const issue = this.issues.get(n);
    if (!issue) throw new TrackerError(`Issue #${n} not found`);
    issue.labels = [...(issue.labels ?? []).filter((l) => l !== 'dk:ready'), 'dk:blocked'];
  }

  public async addComment(input: CommentInput): Promise<void> {
    const n = requireIssueNumber(input.taskId);
    if (!this.comments.has(n)) this.comments.set(n, []);
    this.comments.get(n)!.push(input.body);
  }

  public async listComments(taskId: TaskId): Promise<readonly TrackerComment[]> {
    const n = requireIssueNumber(taskId);
    const now = new Date().toISOString();
    return (this.comments.get(n) ?? []).map((body, index) => ({
      id: `mock:${n}:comment:${index + 1}`,
      taskId,
      body,
      author: 'mock',
      createdAt: now,
    }));
  }

  public async setAutonomousApproval(taskId: TaskId, approved: boolean): Promise<Task> {
    const n = requireIssueNumber(taskId);
    const issue = this.issues.get(n);
    if (!issue) throw new TrackerError(`Issue #${n} not found`);
    issue.state = 'open';
    issue.labels = (issue.labels ?? []).filter((label) => !label.startsWith('dk:'));
    if (approved) issue.labels.push('dk:ready');
    return normalizeLocalIssue(issue, String(n));
  }

  public async addDependency(input: AddDependencyInput): Promise<TaskDependency> {
    const graph = this.buildDependencyGraph();
    if (
      wouldCreateCycle(
        graph as ReadonlyMap<TaskId, ReadonlySet<TaskId>>,
        input.taskId,
        input.dependsOnTaskId,
      )
    ) {
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
    status:
      issue.state === 'closed'
        ? 'completed'
        : issue.labels?.includes('dk:ready')
          ? 'ready'
          : issue.labels?.includes('dk:blocked')
            ? 'blocked'
            : 'backlog',
    trackerReference: { provider: PROVIDER, id: refId },
    createdAt: now,
    updatedAt: now,
  };
  if (issue.body) Object.assign(base, { description: issue.body });
  if (issue.labels && issue.labels.length > 0) Object.assign(base, { labels: [...issue.labels] });
  return base;
}
