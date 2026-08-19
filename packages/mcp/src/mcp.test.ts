import { describe, it, expect } from 'vitest';
import { handleTool, ALL_TOOLS, TRACKER_TOOLS, CONFIG_TOOLS, RUNTIME_TOOLS, CAPABILITY_TOOLS } from './tools.js';
import { MockTrackerAdapter } from '@dark-kitchen/tracker';
import { createProjectId } from '@dark-kitchen/core';

describe('MCP tool registry', () => {
  it('has tools in all categories', () => {
    expect(TRACKER_TOOLS.length).toBeGreaterThan(0);
    expect(CONFIG_TOOLS.length).toBeGreaterThan(0);
    expect(RUNTIME_TOOLS.length).toBeGreaterThan(0);
    expect(CAPABILITY_TOOLS.length).toBeGreaterThan(0);
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

  it('creates a task via dk_create_task', async () => {
    const result = await handleTool('dk_create_task', { projectId, title: 'MCP task' }, ctx);
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { title: string }).title).toBe('MCP task');
  });

  it('gets a task via dk_get_task', async () => {
    const created = await handleTool('dk_create_task', { projectId, title: 'Task A' }, ctx);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const taskId = (created.data as { id: string }).id;
    const result = await handleTool('dk_get_task', { taskId }, ctx);
    expect(result.success).toBe(true);
  });

  it('adds a dependency and validates cycle detection', async () => {
    const ta = await handleTool('dk_create_task', { projectId, title: 'A' }, ctx);
    const tb = await handleTool('dk_create_task', { projectId, title: 'B' }, ctx);
    const tc = await handleTool('dk_create_task', { projectId, title: 'C' }, ctx);
    expect(ta.success && tb.success && tc.success).toBe(true);
    if (!ta.success || !tb.success || !tc.success) return;

    const idA = (ta.data as { id: string }).id;
    const idB = (tb.data as { id: string }).id;
    const idC = (tc.data as { id: string }).id;

    // B blocks A, C blocks B
    await handleTool('dk_add_dependency', { taskId: idA, dependsOnTaskId: idB }, ctx);
    await handleTool('dk_add_dependency', { taskId: idB, dependsOnTaskId: idC }, ctx);

    // A blocks C would create a cycle -> should fail
    const cycleResult = await handleTool('dk_add_dependency', { taskId: idC, dependsOnTaskId: idA }, ctx);
    expect(cycleResult.success).toBe(false);
  });

  it('returns error when tracker is not configured', async () => {
    const result = await handleTool('dk_list_tasks', { projectId: 'p' }, {});
    expect(result.success).toBe(false);
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
    expect(result.success).toBe(false);
  });
});

describe('MCP tool handler - capabilities', () => {
  const config = {
    version: 1 as const,
    capabilityProviders: [
      { managed: true as const, id: 'playwright', capability: 'browser.playwright', version: '>=1.40' },
    ],
  };

  it('lists capability providers', async () => {
    const result = await handleTool('dk_list_capabilities', {}, { config });
    expect(result.success).toBe(true);
    if (result.success) expect(Array.isArray(result.data)).toBe(true);
  });

  it('requests a provisioning plan without auto-approval', async () => {
    const result = await handleTool('dk_request_capability_provisioning', { capabilityId: 'playwright' }, { config });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { plan: { requiresApproval: boolean }; message: string };
      expect(d.plan.requiresApproval).toBe(true);
      expect(d.message).toMatch(/approve/i);
    }
  });

  it('approves a provisioning plan when approve:true', async () => {
    const result = await handleTool('dk_request_capability_provisioning', { capabilityId: 'playwright', approve: true }, { config });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { executed: boolean };
      expect(d.executed).toBe(true);
    }
  });

  it('rejects provisioning of user-managed capability', async () => {
    const cfg = {
      version: 1 as const,
      capabilityProviders: [{ managed: false as const, id: 'custom-tool', capability: 'custom.tool' }],
    };
    const result = await handleTool('dk_request_capability_provisioning', { capabilityId: 'custom-tool' }, { config: cfg });
    expect(result.success).toBe(false);
  });
});
