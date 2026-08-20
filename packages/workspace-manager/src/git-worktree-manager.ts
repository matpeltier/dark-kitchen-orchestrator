import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProjectId,
  TaskId,
  Workspace,
  WorkspaceId,
  WorkspaceManager,
  PrimaryWorktreeRequest,
} from '@dark-kitchen/core';
import { createWorkspaceId } from '@dark-kitchen/core';
import { controlArgument, defineProcess, executeProcess } from '@dark-kitchen/process-execution';

export class WorkspaceError extends Error {
  public readonly worktreeCause?: unknown;
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkspaceError';
    this.worktreeCause = cause;
  }
}

export interface GitWorktreeManagerOptions {
  /**
   * Base directory under which all worktrees are created.
   * E.g. `/home/user/.dark-kitchen/worktrees`
   */
  readonly worktreesBaseDir: string;
  /**
   * Path to the main repository checkout (the primary git directory).
   * This is where `git worktree add` commands are run.
   */
  readonly repositoryPath: string;
}

/**
 * Implements the `WorkspaceManager` port using `git worktree` commands.
 * One primary worktree per active task; worktrees are preserved across retries.
 */
export class GitWorktreeManager implements WorkspaceManager {
  private readonly options: GitWorktreeManagerOptions;
  private readonly workspaces = new Map<WorkspaceId, Workspace>();
  private readonly primaryByTask = new Map<TaskId, WorkspaceId>();

  public constructor(options: GitWorktreeManagerOptions) {
    this.options = options;
  }

  /**
   * Allocate a primary worktree for a task. Returns the existing workspace if
   * one already exists for this task (idempotent).
   */
  public async allocatePrimaryWorktree(request: PrimaryWorktreeRequest): Promise<Workspace> {
    // Idempotent: return existing workspace if already allocated
    const existingId = this.primaryByTask.get(request.taskId);
    if (existingId !== undefined) {
      const existing = this.workspaces.get(existingId);
      if (existing !== undefined) {
        await this.validateWorktreeHealth(existing);
        return existing;
      }
    }

    const branchName = buildWorktreeBranch(request.taskId, request.projectId);
    const worktreePath = join(this.options.worktreesBaseDir, sanitizePath(request.taskId));

    await mkdir(this.options.worktreesBaseDir, { recursive: true });

    const now = new Date().toISOString();
    const workspaceId = createWorkspaceId(`ws-${request.taskId}`);

    // Check if the worktree already exists on disk (e.g. from a previous process)
    const existingWorktree = await this.findExistingWorktree(worktreePath, branchName);
    if (existingWorktree) {
      const workspace: Workspace = {
        id: workspaceId,
        projectId: request.projectId,
        taskId: request.taskId,
        repositoryId: request.repositoryId,
        kind: 'primary-worktree',
        state: 'active',
        path: worktreePath,
        createdAt: now,
        updatedAt: now,
      };
      if (request.revision) Object.assign(workspace, { revision: request.revision });
      this.workspaces.set(workspaceId, workspace);
      this.primaryByTask.set(request.taskId, workspaceId);
      return workspace;
    }

    // Create a provisioning workspace entry
    const provisioningWorkspace: Workspace = {
      id: workspaceId,
      projectId: request.projectId,
      taskId: request.taskId,
      repositoryId: request.repositoryId,
      kind: 'primary-worktree',
      state: 'provisioning',
      path: worktreePath,
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(workspaceId, provisioningWorkspace);
    this.primaryByTask.set(request.taskId, workspaceId);

    try {
      await this.createWorktree(worktreePath, branchName, request.revision);
    } catch (err) {
      const failed: Workspace = {
        ...provisioningWorkspace,
        state: 'failed',
        updatedAt: new Date().toISOString(),
      };
      this.workspaces.set(workspaceId, failed);
      throw new WorkspaceError(
        `Failed to create worktree for task ${request.taskId}: ${String(err)}`,
        err,
      );
    }

    const activeWorkspace: Workspace = {
      ...provisioningWorkspace,
      state: 'active',
      updatedAt: new Date().toISOString(),
    };
    if (request.revision) Object.assign(activeWorkspace, { revision: request.revision });
    this.workspaces.set(workspaceId, activeWorkspace);
    return activeWorkspace;
  }

  public async getWorkspace(workspaceId: WorkspaceId): Promise<Workspace | undefined> {
    return this.workspaces.get(workspaceId);
  }

  public async getPrimaryWorktree(taskId: TaskId): Promise<Workspace | undefined> {
    const id = this.primaryByTask.get(taskId);
    if (!id) return undefined;
    return this.workspaces.get(id);
  }

  /**
   * Release (clean up) a workspace. The worktree is removed only when the
   * lifecycle is safely complete. Fails fast for active/blocked tasks.
   */
  public async releaseWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    if (workspace.state === 'active') {
      throw new WorkspaceError(
        `Cannot release an active workspace ${workspaceId}. Transition to a terminal state first.`,
      );
    }

    if (workspace.kind === 'primary-worktree') {
      await this.removeWorktree(
        workspace.path,
        buildWorktreeBranch(workspace.taskId, workspace.projectId),
      );
      this.primaryByTask.delete(workspace.taskId);
    }

    const released: Workspace = {
      ...workspace,
      state: 'released',
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(workspaceId, released);
  }

  /** Mark a workspace as released (without removing the worktree). Used for lifecycle completion. */
  public markCompleted(workspaceId: WorkspaceId): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new WorkspaceError(`Unknown workspace ${workspaceId}`);
    const updated: Workspace = {
      ...workspace,
      state: 'released',
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(workspaceId, updated);
  }

  /** List all managed worktrees from git. */
  public async listGitWorktrees(): Promise<GitWorktreeInfo[]> {
    return listGitWorktrees(this.options.repositoryPath);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async createWorktree(
    worktreePath: string,
    branchName: string,
    revision?: string,
  ): Promise<void> {
    const base = revision ?? 'HEAD';
    try {
      // Create the branch first (ignore error if it already exists)
      await gitExec(this.options.repositoryPath, ['branch', branchName, base]).catch(() => {
        // Branch may already exist
      });
      await gitExec(this.options.repositoryPath, ['worktree', 'add', worktreePath, branchName]);
    } catch (err) {
      throw new WorkspaceError(`git worktree add failed: ${String(err)}`, err);
    }
  }

  private async removeWorktree(worktreePath: string, expectedBranch: string): Promise<void> {
    if (!(await this.findExistingWorktree(worktreePath, expectedBranch))) {
      throw new WorkspaceError(`Managed worktree ${worktreePath} no longer exists.`);
    }
    try {
      await gitExec(this.options.repositoryPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch (error) {
      // Never recursively delete a path that Git did not confirm as one of this
      // repository's worktrees. A stale/injected workspace path must fail closed.
      throw new WorkspaceError(
        `Git refused to remove managed worktree ${worktreePath}: ${String(error)}`,
        error,
      );
    }
    await gitExec(this.options.repositoryPath, ['worktree', 'prune']).catch(() => {
      // prune is best-effort
    });
  }

  private async findExistingWorktree(
    worktreePath: string,
    expectedBranch: string,
  ): Promise<boolean> {
    try {
      const s = await stat(worktreePath);
      if (!s.isDirectory()) {
        throw new WorkspaceError(`Expected worktree path ${worktreePath} is not a directory.`);
      }
      const [{ stdout: topLevel }, { stdout: branch }] = await Promise.all([
        gitExec(worktreePath, ['rev-parse', '--show-toplevel']),
        gitExec(worktreePath, ['branch', '--show-current']),
      ]);
      const [actualRoot, expectedRoot] = await Promise.all([
        realpath(topLevel.trim()),
        realpath(worktreePath),
      ]);
      if (actualRoot !== expectedRoot) {
        throw new WorkspaceError(
          `Existing path ${worktreePath} resolves to a different Git worktree root.`,
        );
      }
      if (branch.trim() !== expectedBranch) {
        throw new WorkspaceError(
          `Existing worktree ${worktreePath} is on ${branch.trim() || 'a detached HEAD'}, expected ${expectedBranch}.`,
        );
      }
      let registered: GitWorktreeInfo | undefined;
      for (const worktree of await listGitWorktrees(this.options.repositoryPath)) {
        if ((await realpath(worktree.path)) === expectedRoot) {
          registered = worktree;
          break;
        }
      }
      if (!registered || registered.branch !== expectedBranch) {
        throw new WorkspaceError(
          `Existing worktree ${worktreePath} is not registered to repository ${this.options.repositoryPath} on ${expectedBranch}.`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkspaceError(
          `Existing path ${worktreePath} is not the expected managed Git worktree: ${String(error)}`,
          error,
        );
      }
      return false;
    }
  }

  private async validateWorktreeHealth(workspace: Workspace): Promise<void> {
    try {
      const expectedBranch = buildWorktreeBranch(workspace.taskId, workspace.projectId);
      if (!(await this.findExistingWorktree(workspace.path, expectedBranch))) {
        throw new WorkspaceError(`Worktree at ${workspace.path} no longer exists.`);
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        `Worktree at ${workspace.path} is missing, detached, or externally modified: ${String(err)}`,
        err,
      );
    }
  }
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  head: string;
  bare: boolean;
}

async function listGitWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const { stdout } = await gitExec(repoPath, ['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(stdout);
}

function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const result: GitWorktreeInfo[] = [];
  const blocks = output.trim().split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const info: Partial<GitWorktreeInfo> = { bare: false };
    for (const line of lines) {
      if (line.startsWith('worktree ')) info.path = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) info.head = line.slice(5).trim();
      else if (line.startsWith('branch '))
        info.branch = line
          .slice(7)
          .trim()
          .replace(/^refs\/heads\//, '');
      else if (line === 'bare') info.bare = true;
    }
    if (info.path && info.head) {
      result.push(info as GitWorktreeInfo);
    }
  }
  return result;
}

async function gitExec(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await executeProcess({
      definition: defineProcess({
        executable: 'git',
        args: args.map(controlArgument),
        label: 'git-worktree',
      }),
      cwd,
    });
    const stdout = Buffer.from(result.stdout).toString('utf8');
    const stderr = Buffer.from(result.stderr).toString('utf8');
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git exited ${String(result.exitCode)}: ${stderr.trim()}`);
    }
    return { stdout, stderr };
  } catch (err: unknown) {
    if (err instanceof WorkspaceError) throw err;
    const e = err as { message?: string; stderr?: string };
    throw new WorkspaceError(
      `git command failed in ${cwd}: ${e.stderr ?? e.message ?? String(err)}`,
      err,
    );
  }
}

/** Build a deterministic, collision-safe branch name from task + project IDs. */
export function buildWorktreeBranch(taskId: TaskId, projectId: ProjectId): string {
  // Normalize to lowercase slugs.
  const taskSlug = taskId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  const projectSlug = projectId
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .slice(0, 20);
  // Cap length while preserving the trailing identifier (e.g. the issue number),
  // which is the distinguishing part and must not be truncated away.
  const cappedTask = capPreservingTail(taskSlug, 80);
  return `dk/${projectSlug}/${cappedTask}`;
}

/** Truncate `s` to `max` chars, keeping both a head prefix and the tail. */
function capPreservingTail(s: string, max: number): string {
  if (s.length <= max) return s;
  const headLen = Math.floor(max / 2);
  const tailLen = max - headLen - 1;
  return `${s.slice(0, headLen)}-${s.slice(-tailLen)}`;
}

/** Sanitize a task ID for use as a filesystem path component. */
function sanitizePath(taskId: TaskId): string {
  const slug = taskId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return capPreservingTail(slug, 60);
}
