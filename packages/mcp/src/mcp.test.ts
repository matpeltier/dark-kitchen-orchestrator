import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleTool,
  ALL_TOOLS,
  TRACKER_TOOLS,
  CONFIG_TOOLS,
  RUNTIME_TOOLS,
  CAPABILITY_TOOLS,
  VERIFICATION_TOOLS,
  PM_CONTROL_TOOLS,
} from './tools.js';
import { MockTrackerAdapter } from '@dark-kitchen/tracker';
import {
  createEventId,
  createProjectId,
  createRunId,
  createAgentSessionId,
  createTaskId,
  createExecutionNodeId,
  createWorkspaceId,
} from '@dark-kitchen/core';
import type { RuntimeStore, AgentSession } from '@dark-kitchen/core';
import { ConfigStore } from '@dark-kitchen/config';

function makeStore(sessions: AgentSession[]): RuntimeStore {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const run = {
    id: createRunId('run-1'),
    projectId: createProjectId('proj'),
    taskId: createTaskId('task-1'),
    state: 'running' as const,
    executionNodeIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    listRuns: async () => [run],
    listWorkflowRuns: async () => [],
    getRun: async () => run,
    listAgentSessions: async () => [...byId.values()],
    getAgentSession: async (id: string) => byId.get(id as never),
    getDiagnostics: () => ({ schemaVersion: 1, counts: { runs: 0 }, integrityCheck: 'ok' }),
  } as unknown as RuntimeStore;
}

describe('MCP tool registry', () => {
  it('has tools in all categories', () => {
    expect(TRACKER_TOOLS.length).toBeGreaterThan(0);
    expect(CONFIG_TOOLS.length).toBeGreaterThan(0);
    expect(RUNTIME_TOOLS.length).toBeGreaterThan(0);
    expect(CAPABILITY_TOOLS.length).toBeGreaterThan(0);
    expect(VERIFICATION_TOOLS.length).toBeGreaterThan(0);
    expect(PM_CONTROL_TOOLS.length).toBeGreaterThan(0);
  });

  it('all tools have non-empty descriptions distinguishing work-management from GitHub code', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
    // List tasks must mention the distinction
    const listTasks = ALL_TOOLS.find((t) => t.name === 'dk_list_tasks');
    expect(listTasks?.description).toMatch(/GitHub connector|code/i);
  });
});

describe('MCP tool handler - tracker', () => {
  const tracker = new MockTrackerAdapter();
  const ctx = { tracker };
  const projectId = createProjectId('proj-mcp');
  const handle = (name: string, args: Record<string, unknown>) => handleTool(name, args, ctx);

  it('creates a task via dk_create_task', async () => {
    const result = await handle('dk_create_task', { projectId, title: 'MCP task' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { title: string }).title).toBe('MCP task');
  });

  it('gets a task via dk_get_task', async () => {
    const created = await handle('dk_create_task', { projectId, title: 'Task A' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const taskId = (created.data as { id: string }).id;
    const result = await handle('dk_get_task', { taskId });
    expect(result.success).toBe(true);
  });

  it('adds a dependency and validates cycle detection', async () => {
    const ta = await handle('dk_create_task', { projectId, title: 'A' });
    const tb = await handle('dk_create_task', { projectId, title: 'B' });
    const tc = await handle('dk_create_task', { projectId, title: 'C' });
    expect(ta.success && tb.success && tc.success).toBe(true);
    if (!ta.success || !tb.success || !tc.success) return;

    const idA = (ta.data as { id: string }).id;
    const idB = (tb.data as { id: string }).id;
    const idC = (tc.data as { id: string }).id;

    // B blocks A, C blocks B
    await handle('dk_add_dependency', { taskId: idA, dependsOnTaskId: idB });
    await handle('dk_add_dependency', { taskId: idB, dependsOnTaskId: idC });

    // A blocks C would create a cycle -> should fail
    const cycleResult = await handleTool(
      'dk_add_dependency',
      { taskId: idC, dependsOnTaskId: idA },
      ctx,
    );
    expect(cycleResult).toMatchObject({ success: false, code: 'conflict' });
  });

  it('returns error when tracker is not configured', async () => {
    const result = await handleTool('dk_list_tasks', { projectId: 'p' }, {});
    expect(result.success).toBe(false);
  });

  it('validates an edge without mutating the tracker', async () => {
    const first = await handle('dk_create_task', { projectId, title: 'Dry-run A' });
    const second = await handle('dk_create_task', { projectId, title: 'Dry-run B' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    const result = await handle('dk_validate_dependency', {
      projectId,
      taskId: (first.data as { id: string }).id,
      dependsOnTaskId: (second.data as { id: string }).id,
    });
    expect(result).toMatchObject({ success: true, data: { valid: true } });
  });

  it('delegates autonomous approval to the policy service', async () => {
    const approvals: unknown[] = [];
    const result = await handleTool(
      'dk_set_autonomous_approval',
      { taskId: 'task-ready', approved: true },
      {
        trackerControls: {
          getGraph: async (id) => ({ projectId: id, tasks: [], dependencies: [] }),
          listComments: async () => [],
          setAutonomousApproval: async (taskId, approved) => {
            approvals.push({ taskId, approved });
            return { taskId, approved };
          },
        },
      },
    );
    expect(result.success).toBe(true);
    expect(approvals).toEqual([{ taskId: 'task-ready', approved: true }]);
  });
});

describe('MCP tool handler - config', () => {
  it('validates a valid config', async () => {
    const result = await handleTool('dk_validate_config', { config: { version: 1 } }, {});
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { valid: boolean }).valid).toBe(true);
  });

  it('rejects an invalid config', async () => {
    const result = await handleTool('dk_validate_config', { config: { version: 99 } }, {});
    expect(result).toMatchObject({ success: false, code: 'invalid_arguments' });
  });

  it('returns an actionable error for unsupported user-managed harness overrides', async () => {
    const result = await handleTool(
      'dk_validate_config',
      {
        config: {
          version: 1,
          harnessProfiles: [
            { managed: false, id: 'custom-agent', kind: 'custom', description: 'owned by user' },
          ],
          roles: [
            {
              id: 'designer',
              harnessProfileId: 'custom-agent',
              overrides: { model: 'unsupported-override' },
            },
          ],
        },
      },
      {},
    );

    expect(result).toMatchObject({ success: false, code: 'invalid_arguments' });
    if (!result.success) expect(result.error).toMatch(/overrides.*not supported/i);
  });

  it('upserts ID-addressed config entities atomically and preserves the file on invalid refs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dk-mcp-config-'));
    const store = new ConfigStore({ projectRoot });
    const configPath = join(projectRoot, '.dark-kitchen', 'config.yaml');
    try {
      await store.write({ version: 1 });
      const harness = await handleTool(
        'dk_upsert_config_entity',
        {
          section: 'harnessProfiles',
          entity: { managed: true, id: 'acpx', kind: 'acpx' },
        },
        { configPath },
      );
      expect(harness.success).toBe(true);

      const role = await handleTool(
        'dk_upsert_config_entity',
        {
          section: 'roles',
          entity: { id: 'implementer', harnessProfileId: 'acpx' },
        },
        { configPath },
      );
      expect(role.success).toBe(true);
      const beforeInvalid = await readFile(configPath, 'utf8');

      const invalid = await handleTool(
        'dk_upsert_config_entity',
        {
          section: 'roles',
          entity: { id: 'reviewer', harnessProfileId: 'missing-profile' },
        },
        { configPath },
      );
      expect(invalid).toMatchObject({ success: false, code: 'invalid_arguments' });
      expect(await readFile(configPath, 'utf8')).toBe(beforeInvalid);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('journals successful config mutations when the daemon runtime store is available', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dk-mcp-config-audit-'));
    const configStore = new ConfigStore({ projectRoot });
    const configPath = join(projectRoot, '.dark-kitchen', 'config.yaml');
    const events: unknown[] = [];
    try {
      await configStore.write({ version: 1 });
      const result = await handleTool(
        'dk_patch_config',
        { patch: { concurrency: { maxParallelTasks: 2, maxParallelWorkflows: 1 } } },
        {
          configPath,
          store: {
            appendEvent: async (event: unknown) => {
              events.push(event);
            },
          } as unknown as RuntimeStore,
        },
      );

      expect(result.success).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'configuration.changed',
          payload: expect.objectContaining({
            configurationId: 'project-config',
            key: configPath,
            version: 1,
          }),
        }),
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('MCP tool handler - capabilities', () => {
  const config = {
    version: 1 as const,
    capabilityProviders: [
      {
        managed: true as const,
        id: 'playwright',
        capability: 'browser.playwright',
        version: '>=1.40',
      },
    ],
  };
  const plans: unknown[] = [];
  const ensures: unknown[] = [];
  const capabilities = {
    listCatalog: async () => [{ id: 'playwright', capability: 'browser.playwright' }],
    inspect: async (input: unknown) => ({ input, state: 'provisionable' }),
    planProvisioning: async (input: unknown) => {
      plans.push(input);
      return {
        planId: 'plan-1',
        requiresApproval: true,
        changes: [{ kind: 'filesystem', path: '/dk-tools/playwright' }],
      };
    },
    ensureManaged: async (input: unknown) => {
      ensures.push(input);
      return { state: 'available' };
    },
    validate: async () => ({ state: 'available', health: 'ok' }),
  };

  it('lists capability providers', async () => {
    const result = await handleTool('dk_list_capabilities', {}, { config });
    expect(result.success).toBe(true);
    if (result.success) expect(Array.isArray(result.data)).toBe(true);
  });

  it('requests a provisioning plan without auto-approval', async () => {
    const result = await handleTool(
      'dk_request_capability_provisioning',
      { capabilityId: 'playwright' },
      { config, capabilities },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { planId: string; requiresApproval: boolean };
      expect(d.requiresApproval).toBe(true);
      expect(d.planId).toBe('plan-1');
    }
  });

  it('normalizes the capability service durable id to the public planId contract', async () => {
    const result = await handleTool(
      'dk_plan_capability_provisioning',
      { capabilityId: 'browser.playwright' },
      {
        capabilities: {
          ...capabilities,
          planProvisioning: async () => ({
            id: 'cap-plan-service-1',
            approvalId: 'intervention-1',
            requiresApproval: true,
          }),
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        id: 'cap-plan-service-1',
        planId: 'cap-plan-service-1',
        approvalId: 'intervention-1',
      },
    });
  });

  it('rejects the unsafe legacy approve:true shortcut', async () => {
    const result = await handleTool(
      'dk_request_capability_provisioning',
      { capabilityId: 'playwright', approve: true },
      { config, capabilities },
    );
    expect(result).toMatchObject({ success: false, code: 'approval_required' });
    expect(ensures).toHaveLength(0);
  });

  it('ensures only by delegating an exact plan and approval ID to the service', async () => {
    const result = await handleTool(
      'dk_ensure_capability',
      { planId: 'plan-1', approvalId: 'intervention-approved-1' },
      { config, capabilities },
    );
    expect(result).toMatchObject({ success: true, data: { state: 'available' } });
    expect(ensures).toContainEqual({
      planId: 'plan-1',
      approvalId: 'intervention-approved-1',
    });
    expect(plans.length).toBeGreaterThan(0);
  });

  it('surfaces an unapproved provisioning attempt as approval_required', async () => {
    const result = await handleTool(
      'dk_ensure_capability',
      { planId: 'plan-1', approvalId: 'wrong-approval' },
      {
        capabilities: {
          ...capabilities,
          ensureManaged: async () => {
            throw new Error('Approval does not belong to this plan');
          },
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: 'approval_required',
      retryable: true,
    });
  });

  it('never invents a plan or reports execution when the service is absent', async () => {
    const result = await handleTool(
      'dk_request_capability_provisioning',
      { capabilityId: 'playwright' },
      { config },
    );
    expect(result).toMatchObject({ success: false, code: 'service_unavailable' });
  });

  it('redacts credentials from delegated service failures', async () => {
    const result = await handleTool(
      'dk_inspect_capability',
      { capabilityId: 'browser.playwright' },
      {
        capabilities: {
          ...capabilities,
          inspect: async () => {
            throw new Error('Auth failed: Bearer super-secret api_key=also-secret');
          },
        },
      },
    );
    expect(result).toMatchObject({ success: false, code: 'authorization_failed' });
    if (!result.success) {
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('super-secret');
      expect(result.error).not.toContain('also-secret');
    }
  });
});

describe('MCP tool handler - verification', () => {
  const run = {
    id: 'verification-1',
    taskId: 'task-1',
    state: 'passed',
    criterionResults: [{ criterionName: 'signup', status: 'pass' }],
  };
  const verification = {
    inspectTaskRequirements: async () => ({ profileId: 'web-e2e', scenarios: ['signup'] }),
    listRuns: async () => [run],
    getRun: async (runId: string) => (runId === run.id ? run : undefined),
    getEvidence: async () => [{ kind: 'screenshot', artifactRef: 'artifact://signup.png' }],
    request: async (input: unknown) => ({ id: 'verification-2', input, state: 'pending' }),
    retry: async (runId: string) => ({ id: runId, state: 'pending', attempt: 2 }),
    cancel: async (runId: string) => ({ id: runId, state: 'cancelled' }),
  };

  it('covers requirements, run verdicts, evidence, request, retry, and cancel through services', async () => {
    const ctx = { verification };
    expect(
      (await handleTool('dk_inspect_task_verification', { taskId: 'task-1' }, ctx)).success,
    ).toBe(true);
    expect((await handleTool('dk_list_verification_runs', { taskId: 'task-1' }, ctx)).success).toBe(
      true,
    );
    expect(
      (await handleTool('dk_get_verification_run', { verificationRunId: 'verification-1' }, ctx))
        .success,
    ).toBe(true);
    expect(
      (
        await handleTool(
          'dk_get_verification_evidence',
          { verificationRunId: 'verification-1', criterionName: 'signup' },
          ctx,
        )
      ).success,
    ).toBe(true);
    expect(
      (await handleTool('dk_request_verification', { taskId: 'task-1', profileId: 'web-e2e' }, ctx))
        .success,
    ).toBe(true);
    expect(
      (await handleTool('dk_retry_verification', { verificationRunId: 'verification-1' }, ctx))
        .success,
    ).toBe(true);
    expect(
      (await handleTool('dk_cancel_verification', { verificationRunId: 'verification-1' }, ctx))
        .success,
    ).toBe(true);
  });

  it('returns an actionable error instead of simulating an unavailable verifier', async () => {
    const result = await handleTool('dk_request_verification', { taskId: 'task-1' }, {});
    expect(result).toMatchObject({ success: false, code: 'service_unavailable' });
  });
});

describe('MCP tool handler - interventions', () => {
  it('requires resolver identity and normalizes capability approval for the approval gateway', async () => {
    const resolvedInputs: unknown[] = [];
    const ctx = {
      interventionService: {
        resolve: async (input: unknown) => {
          resolvedInputs.push(input);
          return { id: 'approval-1', status: 'resolved' };
        },
      },
    } as unknown as import('./tools.js').McpContext;

    expect(
      await handleTool(
        'dk_resolve_intervention',
        { interventionId: 'approval-1', action: 'approve-capability-provisioning' },
        ctx,
      ),
    ).toMatchObject({ success: false, code: 'invalid_arguments' });

    const approved = await handleTool(
      'dk_resolve_intervention',
      {
        interventionId: 'approval-1',
        action: 'approve-capability-provisioning',
        resolvedBy: 'pm@example.test',
      },
      ctx,
    );
    expect(approved.success).toBe(true);
    expect(resolvedInputs).toContainEqual({
      interventionId: 'approval-1',
      action: 'approve',
      resolvedBy: 'pm@example.test',
    });
  });

  it('applies the same downstream resume control as a channel reply', async () => {
    const controls: unknown[] = [];
    const result = await handleTool(
      'dk_resolve_intervention',
      {
        interventionId: 'workflow-gate-1',
        action: 'approve',
        resolvedBy: 'chatgpt-pm',
      },
      {
        interventionService: {
          resolve: async () => ({
            id: 'workflow-gate-1',
            status: 'resolved',
            scope: 'task',
            targetId: 'github-issues:o/r#42',
            kind: 'approval',
            details: 'Workflow gate task-42:high-risk',
          }),
        } as never,
        interventionResolutionControls: {
          apply: async (input) => {
            controls.push(input);
          },
        },
      },
    );

    expect(result.success).toBe(true);
    expect(controls).toEqual([
      expect.objectContaining({
        scope: 'task',
        targetId: 'github-issues:o/r#42',
        action: 'approve',
      }),
    ]);
  });
});

describe('MCP tool handler - adversarial arguments', () => {
  it('rejects missing, blank, wrongly typed, and unknown arguments before service calls', async () => {
    const missing = await handleTool('dk_get_task', {}, {});
    const blank = await handleTool('dk_get_task', { taskId: '' }, {});
    const wrongType = await handleTool('dk_get_task', { taskId: 42 }, {});
    const extra = await handleTool('dk_get_task', { taskId: 'task-1', shell: 'rm -rf /' }, {});

    for (const result of [missing, blank, wrongType, extra]) {
      expect(result).toMatchObject({ success: false, code: 'invalid_arguments' });
    }
  });

  it('returns a stable code for unknown tools and rejects no-op mutations', async () => {
    expect(await handleTool('dk_does_not_exist', {}, {})).toMatchObject({
      success: false,
      code: 'unknown_tool',
    });
    expect(
      await handleTool(
        'dk_update_task',
        { taskId: 'task-1' },
        { tracker: new MockTrackerAdapter() },
      ),
    ).toMatchObject({
      success: false,
      code: 'invalid_arguments',
    });
  });
});

describe('MCP tool handler - PM control plane', () => {
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: createAgentSessionId('s1'),
    runId: createRunId('run-1'),
    taskId: createTaskId('task-1'),
    executionNodeId: createExecutionNodeId('node-1'),
    workspaceId: createWorkspaceId('ws-1'),
    state: 'running',
    createdAt: now,
    updatedAt: now,
  };
  const store = makeStore([session]);

  const supervisor = {
    getActiveRuns: () => new Map([[createTaskId('task-1'), createRunId('run-1')]]),
    getPausedTasks: () => new Set([createTaskId('task-2')]),
    getCompletedTasks: () => new Set(),
    getMaxParallelTasks: () => 4,
    pauseTask: (_t: unknown) => undefined,
    resumeTask: (_t: unknown) => undefined,
    stopTask: (_t: unknown) => undefined,
    retryTask: (_t: unknown) => undefined,
  } as unknown as import('@dark-kitchen/runtime').RunSupervisor;

  const sendInstruction = (id: unknown, text: string) => {
    expect(text).toMatch(/steer/);
    return Promise.resolve();
  };
  const agentControls = {
    listSessions: async (runId?: unknown) => (runId ? [session] : [session]),
    getSession: async (id: unknown) => (id === session.id ? session : undefined),
    sendInstruction,
    interruptAndSend: sendInstruction,
    stopSession: async () => undefined,
    restartSession: async () => session,
  };

  const ctx = {
    store,
    supervisor,
    agentControls: agentControls as unknown as import('@dark-kitchen/runtime').AgentControlService,
    runtimeControls: {
      listAgents: async () => [session],
      getAgent: async (id: string) => (id === session.id ? session : undefined),
      restartAgent: async () => ({ ...session, id: createAgentSessionId('s2') }),
      retryAgent: async () => ({ ...session, id: createAgentSessionId('s3') }),
      switchAgentProfile: async () => ({ ...session, id: createAgentSessionId('s4') }),
      pauseRun: async (runId: string) => ({ runId, state: 'waiting' }),
      resumeRun: async (runId: string) => ({ runId, state: 'running' }),
      retryRun: async (runId: string) => ({ runId, state: 'queued' }),
    },
    tracker: {
      setBlocked: async () => undefined,
      reopenTask: async () => undefined,
      updateTask: async (_id: string, _update: unknown) => ({
        id: 'task-1',
        projectId: createProjectId('proj'),
        title: 't',
        status: 'ready' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
  } as unknown as import('./tools.js').McpContext;

  const handle = (name: string, args: Record<string, unknown>) => handleTool(name, args, ctx);

  it('lists runs with aggregate counts', async () => {
    const result = await handle('dk_list_runs', {});
    expect(result.success).toBe(true);
  });

  it('returns run detail with sessions and interventions', async () => {
    const result = await handle('dk_get_run', { runId: 'run-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { run?: unknown; sessions: unknown[] };
      expect(d.sessions.length).toBeGreaterThan(0);
    }
  });

  it('lists sessions (optionally filtered by run)', async () => {
    const result = await handle('dk_list_sessions', { runId: 'run-1' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('gets a single session', async () => {
    const result = await handle('dk_get_session', { sessionId: session.id });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { id: string }).id).toBe(session.id);
  });

  it('errors for unknown session', async () => {
    const result = await handle('dk_get_session', { sessionId: 'ghost' });
    expect(result.success).toBe(false);
  });

  it('sends a live instruction to the agent', async () => {
    const result = await handle('dk_send_instruction', {
      sessionId: session.id,
      instruction: 'steer left',
    });
    expect(result.success).toBe(true);
  });

  it('interrupts the agent with an instruction', async () => {
    const result = await handle('dk_interrupt_agent', {
      sessionId: session.id,
      instruction: 'steer right',
    });
    expect(result.success).toBe(true);
  });

  it('stops an agent session', async () => {
    const result = await handle('dk_stop_agent', { sessionId: session.id });
    expect(result.success).toBe(true);
  });

  it('restarts an agent and exposes canonical agent aliases', async () => {
    expect((await handle('dk_list_agents', { runId: 'run-1' })).success).toBe(true);
    expect((await handle('dk_get_agent', { sessionId: session.id })).success).toBe(true);
    expect((await handle('dk_restart_agent', { sessionId: session.id })).success).toBe(true);
  });

  it('pauses, resumes, and retries a run by resolving it to its task', async () => {
    expect((await handle('dk_pause_run', { runId: 'run-1' })).success).toBe(true);
    expect((await handle('dk_resume_run', { runId: 'run-1' })).success).toBe(true);
    expect((await handle('dk_retry_run', { runId: 'run-1' })).success).toBe(true);
  });

  it('pauses and resumes a task', async () => {
    expect((await handle('dk_pause_task', { taskId: 'task-1' })).success).toBe(true);
    expect((await handle('dk_resume_task', { taskId: 'task-1' })).success).toBe(true);
  });

  it('stops a task fully (pause + blocked on tracker)', async () => {
    const result = await handle('dk_stop_task', { taskId: 'task-1' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { blocked: boolean }).blocked).toBe(true);
  });

  it('restarts a task (retry + reopened on tracker)', async () => {
    const result = await handle('dk_restart_task', { taskId: 'task-1' });
    expect(result.success).toBe(true);
  });

  it('reports scheduler status', async () => {
    const result = await handle('dk_get_scheduler_status', {});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { activeRuns: unknown[]; pausedTasks: unknown[] };
      expect(d.activeRuns.length).toBeGreaterThan(0);
      expect(d.pausedTasks.length).toBeGreaterThan(0);
    }
  });

  it('reports store diagnostics', async () => {
    const result = await handle('dk_get_diagnostics', {});
    expect(result.success).toBe(true);
  });

  it('errors when store/supervisor not configured', async () => {
    expect((await handleTool('dk_list_runs', {}, {})).success).toBe(false);
    expect((await handleTool('dk_get_scheduler_status', {}, {})).success).toBe(false);
  });

  it('does not simulate audited restart/run controls with lower-level services', async () => {
    expect(
      await handleTool(
        'dk_restart_agent',
        { sessionId: session.id },
        { agentControls: ctx.agentControls! },
      ),
    ).toMatchObject({ success: false, code: 'service_unavailable' });
    expect(
      await handleTool('dk_retry_run', { runId: 'run-1' }, { store, supervisor }),
    ).toMatchObject({ success: false, code: 'service_unavailable' });
  });
});

describe('MCP tool handler - task lifecycle', () => {
  it('returns the latest lifecycle event for a task', async () => {
    const events: unknown[] = [
      {
        id: createEventId('evt-1'),
        type: 'task.lifecycle',
        occurredAt: '2026-08-22T08:00:00Z',
        payload: {
          taskId: 't-1',
          state: 'merge-conflict',
          errorMessage: 'conflict with main',
          pullRequestId: 'github:org/repo#6',
          pullRequestUrl: 'https://github.com/org/repo/pull/6',
          sourceBranch: 'dk/branch',
        },
      },
      {
        id: createEventId('evt-2'),
        type: 'task.lifecycle',
        occurredAt: '2026-08-22T09:00:00Z',
        payload: { taskId: 't-1', state: 'merged', sourceBranch: 'dk/branch' },
      },
    ];
    const store = {
      listEvents: async (options?: { type?: string }) =>
        options?.type === 'task.lifecycle' ? events : [],
    } as unknown as RuntimeStore;
    const result = await handleTool('dk_get_task_lifecycle', { taskId: 't-1' }, { store });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { state: string };
    expect(data.state).toBe('merged');
  });

  it('reports unknown when no lifecycle event exists', async () => {
    const store = { listEvents: async () => [] } as unknown as RuntimeStore;
    const result = await handleTool('dk_get_task_lifecycle', { taskId: 't-x' }, { store });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { state: string };
    expect(data.state).toBe('unknown');
  });
});
