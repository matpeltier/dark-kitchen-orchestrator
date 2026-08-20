import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MockTrackerAdapter } from '@dark-kitchen/tracker';
import { ConfigStore } from '@dark-kitchen/config';
import { createMcpServer } from './server.js';
import type { McpContext } from './tools.js';

describe('MCP SDK integration', () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('advertises real schemas and returns structured success/error envelopes', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await createMcpServer({});
    client = new Client({ name: 'mcp-test', version: '1.0.0' });
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);

    const listed = await client.listTools();
    const getTask = listed.tools.find((tool) => tool.name === 'dk_get_task');
    expect(getTask?.inputSchema).toMatchObject({
      type: 'object',
      required: ['taskId'],
      additionalProperties: false,
    });

    const success = await client.callTool({
      name: 'dk_validate_config',
      arguments: { config: { version: 1 } },
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toMatchObject({ success: true });

    const unavailable = await client.callTool({ name: 'dk_list_runs', arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({
      success: false,
      code: 'service_unavailable',
      retryable: true,
    });
  });

  it('lets the MCP SDK reject extra or wrongly typed arguments before dispatch', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await createMcpServer({});
    client = new Client({ name: 'mcp-test', version: '1.0.0' });
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);

    const result = await client.callTool({
      name: 'dk_get_task',
      arguments: { taskId: 123, unexpected: 'payload' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/validation|invalid/i) }),
      ]),
    );
  });

  it('runs the PM acceptance flow entirely through MCP SDK calls', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dk-mcp-sdk-'));
    const tracker = new MockTrackerAdapter();
    const resolved: unknown[] = [];
    const ensured: unknown[] = [];
    const context: McpContext = {
      tracker,
      configPath: join(projectRoot, '.dark-kitchen', 'config.yaml'),
      runtimeControls: {
        listAgents: async () => [{ id: 'agent-1', state: 'running' }],
        getAgent: async () => ({ id: 'agent-1', state: 'running' }),
        restartAgent: async () => ({ id: 'agent-2', state: 'running' }),
        retryAgent: async () => ({ id: 'agent-3', state: 'running' }),
        switchAgentProfile: async () => ({ id: 'agent-4', state: 'running' }),
        pauseRun: async (runId) => ({ id: runId, state: 'waiting' }),
        resumeRun: async (runId) => ({ id: runId, state: 'running' }),
        retryRun: async (runId) => ({ id: runId, state: 'queued' }),
      },
      capabilities: {
        listCatalog: async () => [{ capabilityId: 'browser.playwright' }],
        inspect: async () => ({
          capabilityId: 'browser.playwright',
          state: 'provisionable',
        }),
        planProvisioning: async () => ({
          id: 'plan-1',
          approvalId: 'approval-1',
          requiresApproval: true,
        }),
        ensureManaged: async (input) => {
          ensured.push(input);
          return { capabilityId: 'browser.playwright', state: 'available' };
        },
        validate: async () => ({ capabilityId: 'browser.playwright', state: 'available' }),
      },
      interventionService: {
        resolve: async (input: unknown) => {
          resolved.push(input);
          return { id: 'approval-1', status: 'resolved' };
        },
      } as unknown as NonNullable<McpContext['interventionService']>,
    };

    try {
      await new ConfigStore({ projectRoot }).write({ version: 1 });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = await createMcpServer(context);
      client = new Client({ name: 'pm-acceptance-test', version: '1.0.0' });
      await server.connect(serverTransport as unknown as Transport);
      await client.connect(clientTransport as unknown as Transport);

      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args });
        expect(
          result.isError,
          `${name} should succeed: ${JSON.stringify(result.structuredContent)}`,
        ).not.toBe(true);
        const envelope = result.structuredContent as
          | { readonly success: true; readonly data: unknown }
          | undefined;
        expect(envelope?.success).toBe(true);
        return envelope!.data;
      };

      await call('dk_patch_config', {
        patch: {
          version: 1,
          harnessProfiles: [{ managed: true, id: 'acpx', kind: 'acpx' }],
          capabilityProviders: [
            { managed: true, id: 'playwright', capability: 'browser.playwright' },
          ],
        },
      });
      await call('dk_upsert_config_entity', {
        section: 'roles',
        entity: { id: 'implementer', harnessProfileId: 'acpx' },
      });
      await call('dk_upsert_config_entity', {
        section: 'verificationProfiles',
        entity: {
          id: 'web-e2e',
          verifierRoleId: 'implementer',
          requiredCapabilities: ['browser.playwright'],
        },
      });

      const first = (await call('dk_create_task', {
        projectId: 'project-1',
        title: 'Implement browser flow',
      })) as { id: string };
      const second = (await call('dk_create_task', {
        projectId: 'project-1',
        title: 'Verify browser flow',
      })) as { id: string };
      await call('dk_add_dependency', {
        taskId: second.id,
        dependsOnTaskId: first.id,
      });

      await call('dk_inspect_capability', { capabilityId: 'browser.playwright' });
      const plan = (await call('dk_plan_capability_provisioning', {
        capabilityId: 'browser.playwright',
      })) as { planId: string; approvalId: string };
      await call('dk_resolve_intervention', {
        interventionId: plan.approvalId,
        action: 'approve-capability-provisioning',
        resolvedBy: 'pm@example.test',
      });
      await call('dk_ensure_capability', {
        planId: plan.planId,
        approvalId: plan.approvalId,
      });
      const agents = (await call('dk_list_agents', {})) as unknown[];

      expect(agents).toEqual([{ id: 'agent-1', state: 'running' }]);
      expect(resolved).toContainEqual({
        interventionId: 'approval-1',
        action: 'approve',
        resolvedBy: 'pm@example.test',
      });
      expect(ensured).toEqual([{ planId: 'plan-1', approvalId: 'approval-1' }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
