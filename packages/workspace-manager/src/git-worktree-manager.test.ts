import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitWorktreeManager, buildWorktreeBranch, WorkspaceError } from './git-worktree-manager.js';
import { createProjectId, createRepositoryId, createTaskId } from '@dark-kitchen/core';

const execAsync = promisify(exec);

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execAsync('git init -b main', { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# test\n');
  await execAsync('git add .', { cwd: dir });
  await execAsync('git commit -m "init"', { cwd: dir });
}

describe('buildWorktreeBranch', () => {
  it('builds a deterministic branch name', () => {
    const branch = buildWorktreeBranch(createTaskId('task-123'), createProjectId('proj-abc'));
    expect(branch).toBe('dk/proj-abc/task-123');
  });

  it('normalizes non-slug characters', () => {
    const branch = buildWorktreeBranch(
      createTaskId('task/with/slashes'),
      createProjectId('my project'),
    );
    expect(branch).toMatch(/^dk\/my-project\/task-with-slashes$/);
  });
});

describe('GitWorktreeManager - basic lifecycle', () => {
  let baseDir: string;
  let repoDir: string;
  let worktreesDir: string;
  let manager: GitWorktreeManager;

  beforeAll(async () => {
    baseDir = join(tmpdir(), `dk-wm-${Date.now()}`);
    repoDir = join(baseDir, 'repo');
    worktreesDir = join(baseDir, 'worktrees');
    await initRepo(repoDir);
    manager = new GitWorktreeManager({ repositoryPath: repoDir, worktreesBaseDir: worktreesDir });
  });

  afterAll(async () => {
    // Clean up manager worktrees
    const worktrees = await manager.listGitWorktrees().catch(() => []);
    for (const wt of worktrees) {
      if (wt.path !== repoDir) {
        await execAsync(`git worktree remove --force '${wt.path}'`, { cwd: repoDir }).catch(
          () => {},
        );
      }
    }
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it('allocates a primary worktree', async () => {
    const ws = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-1'),
      taskId: createTaskId('task-1'),
      repositoryId: createRepositoryId('repo-1'),
    });
    expect(ws.state).toBe('active');
    expect(ws.kind).toBe('primary-worktree');
    expect(ws.path).toBeTruthy();
  });

  it('is idempotent - returns same workspace on retry', async () => {
    const taskId = createTaskId('task-2');
    const ws1 = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-1'),
      taskId,
      repositoryId: createRepositoryId('repo-1'),
    });
    const ws2 = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-1'),
      taskId,
      repositoryId: createRepositoryId('repo-1'),
    });
    expect(ws1.id).toBe(ws2.id);
    expect(ws1.path).toBe(ws2.path);
  });

  it('returns workspace by id', async () => {
    const ws = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-1'),
      taskId: createTaskId('task-3'),
      repositoryId: createRepositoryId('repo-1'),
    });
    const fetched = await manager.getWorkspace(ws.id);
    expect(fetched?.id).toBe(ws.id);
  });

  it('returns primary worktree by task', async () => {
    const taskId = createTaskId('task-4');
    await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-1'),
      taskId,
      repositoryId: createRepositoryId('repo-1'),
    });
    const ws = await manager.getPrimaryWorktree(taskId);
    expect(ws?.taskId).toBe(taskId);
  });

  it('two tasks have separate worktrees (no collision)', async () => {
    const ws1 = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-2'),
      taskId: createTaskId('task-a'),
      repositoryId: createRepositoryId('repo-1'),
    });
    const ws2 = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-2'),
      taskId: createTaskId('task-b'),
      repositoryId: createRepositoryId('repo-1'),
    });
    expect(ws1.path).not.toBe(ws2.path);

    // Modify a file in each worktree independently
    await writeFile(join(ws1.path, 'task-a.txt'), 'hello from a');
    await writeFile(join(ws2.path, 'task-b.txt'), 'hello from b');

    // Verify no cross-contamination
    const { stdout: ls1 } = await execAsync('ls', { cwd: ws1.path });
    const { stdout: ls2 } = await execAsync('ls', { cwd: ws2.path });
    expect(ls1).not.toContain('task-b.txt');
    expect(ls2).not.toContain('task-a.txt');
  });

  it('fails closed when the deterministic path is an unrelated directory', async () => {
    await mkdir(join(worktreesDir, 'task-conflict'), { recursive: true });
    await expect(
      manager.allocatePrimaryWorktree({
        projectId: createProjectId('proj-conflict'),
        taskId: createTaskId('task-conflict'),
        repositoryId: createRepositoryId('repo-1'),
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('fails closed when the deterministic path is a matching branch in another repository', async () => {
    const taskId = createTaskId('task-foreign-repo');
    const projectId = createProjectId('proj-foreign-repo');
    const foreignPath = join(worktreesDir, taskId);
    const foreignRepo = join(baseDir, 'foreign-repo');
    const branch = buildWorktreeBranch(taskId, projectId);
    await initRepo(foreignRepo);
    await execAsync(`git branch '${branch}'`, { cwd: foreignRepo });
    await execAsync(`git worktree add '${foreignPath}' '${branch}'`, { cwd: foreignRepo });

    await expect(
      manager.allocatePrimaryWorktree({
        projectId,
        taskId,
        repositoryId: createRepositoryId('repo-1'),
      }),
    ).rejects.toThrow(/not registered/);
  });

  it('revalidates repository ownership before reusing an in-memory workspace', async () => {
    const taskId = createTaskId('task-replaced-worktree');
    const projectId = createProjectId('proj-replaced-worktree');
    const workspace = await manager.allocatePrimaryWorktree({
      projectId,
      taskId,
      repositoryId: createRepositoryId('repo-1'),
    });
    await execAsync(`git worktree remove --force '${workspace.path}'`, { cwd: repoDir });

    const foreignRepo = join(baseDir, 'replacement-repo');
    const branch = buildWorktreeBranch(taskId, projectId);
    await initRepo(foreignRepo);
    await execAsync(`git branch '${branch}'`, { cwd: foreignRepo });
    await execAsync(`git worktree add '${workspace.path}' '${branch}'`, { cwd: foreignRepo });

    await expect(
      manager.allocatePrimaryWorktree({
        projectId,
        taskId,
        repositoryId: createRepositoryId('repo-1'),
      }),
    ).rejects.toThrow(/not registered/);

    manager.markCompleted(workspace.id);
    await expect(manager.releaseWorkspace(workspace.id)).rejects.toThrow(/not registered/);
  });

  it('refuses to release an active workspace', async () => {
    const ws = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-3'),
      taskId: createTaskId('task-active'),
      repositoryId: createRepositoryId('repo-1'),
    });
    await expect(manager.releaseWorkspace(ws.id)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('releases a completed workspace', async () => {
    const ws = await manager.allocatePrimaryWorktree({
      projectId: createProjectId('proj-4'),
      taskId: createTaskId('task-done'),
      repositoryId: createRepositoryId('repo-1'),
    });
    manager.markCompleted(ws.id);
    await manager.releaseWorkspace(ws.id);
    const fetched = await manager.getWorkspace(ws.id);
    expect(fetched?.state).toBe('released');
  });
});
