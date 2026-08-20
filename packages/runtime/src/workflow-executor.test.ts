import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRunId, createTaskId } from '@dark-kitchen/core';
import type { AgentCallInput, RoleResolver, WorkflowFn } from '@dark-kitchen/workflow-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow, type WorkflowExecutorResult } from './workflow-executor.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function appendCommand(path: string, value: string) {
  return {
    executable: process.execPath,
    args: [
      '-e',
      'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")',
      path,
      value,
    ],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('executeWorkflow verification environment', () => {
  it('prepares before the independent verifier and tears down in finally on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dark-kitchen-workflow-executor-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
    const log = join(root, 'environment.log');
    const roleResolver: RoleResolver = vi.fn(async (role) => {
      expect(role).toBe('independent-verifier');
      return async (input: AgentCallInput) => {
        expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['setup', 'health']);
        expect(
          (input as unknown as { runtimeResources?: { skills?: readonly string[] } })
            .runtimeResources?.skills,
        ).toEqual(['web-testing']);
        throw new Error('verifier failed');
      };
    });
    const workflow: WorkflowFn<WorkflowExecutorResult> = async (builder) => {
      await builder.agent({ role: 'verifier', prompt: 'verify observable behavior' });
      throw new Error('unreachable');
    };

    await expect(
      executeWorkflow(
        {
          id: createTaskId('task-33'),
          title: 'Verify safely',
          description: 'Tracker text: $(touch should-never-exist)',
        },
        createRunId('run-33'),
        {
          databasePath: join(root, 'runtime.db'),
          worktreesBaseDir: join(root, 'worktrees'),
          repositoryPath: root,
          repositoryId: 'repository',
          verificationProfileId: 'web-e2e',
          verificationRoleId: 'independent-verifier',
          verificationResources: { skills: ['web-testing'] },
          verificationEnvironment: {
            setup: [appendCommand(log, 'setup')],
            healthcheck: [appendCommand(log, 'health')],
            teardown: [appendCommand(log, 'teardown')],
          },
        },
        {
          workspaceManager: {
            allocatePrimaryWorktree: vi.fn(async () => ({ path: root })),
          },
          roleResolver,
          workflow,
        },
      ),
    ).rejects.toThrow(/verifier failed/);

    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'setup',
      'health',
      'teardown',
    ]);
    await expect(readFile(join(root, 'should-never-exist'), 'utf8')).rejects.toThrow();
  });
});
