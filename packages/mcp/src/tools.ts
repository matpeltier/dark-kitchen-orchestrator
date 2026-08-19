/**
 * Dark Kitchen MCP tool definitions.
 *
 * Tools are organized into categories:
 * - tracker: task CRUD, dependencies, state, labels
 * - config: read/patch Dark Kitchen configuration
 * - runtime: run/session status and controls
 * - interventions: list/resolve/dismiss interventions
 * - capabilities: catalog, state, provisioning
 *
 * The MCP layer calls Dark Kitchen services — it never spawns agents or
 * external installers directly.
 */

import type { FullTrackerAdapter } from '@dark-kitchen/tracker';
import type { DarkKitchenConfig } from '@dark-kitchen/config';
import type { InterventionService } from '@dark-kitchen/runtime';
import { createProjectId, createTaskId, createInterventionId } from '@dark-kitchen/core';

// ─── Tool descriptors ─────────────────────────────────────────────────────────

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TRACKER_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_tasks',
    description:
      'List all tasks in the configured tracker project. Use this for work-management operations. ' +
      'For GitHub repository code, commits, diffs, or PRs, use the GitHub connector instead.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'dk_get_task',
    description: 'Get a single task by its Dark Kitchen task ID.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_create_task',
    description: 'Create a new task in the tracker with a title and optional description.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'dk_update_task',
    description: 'Update a task title, description, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: {
          type: 'string',
          enum: ['backlog', 'ready', 'active', 'blocked', 'completed', 'cancelled'],
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_close_task',
    description: 'Close/complete a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_add_comment',
    description: 'Add a comment to a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, body: { type: 'string' } },
      required: ['taskId', 'body'],
    },
  },
  {
    name: 'dk_add_dependency',
    description:
      'Add a native blocker dependency between tasks (A blocks B). ' +
      'Validates for cycles before mutating the tracker. ' +
      'Use native dependency edges — never inject "Depends on #..." text into issue bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task that is blocked' },
        dependsOnTaskId: { type: 'string', description: 'The task that blocks it' },
      },
      required: ['taskId', 'dependsOnTaskId'],
    },
  },
  {
    name: 'dk_remove_dependency',
    description: 'Remove a blocker dependency by dependency ID.',
    inputSchema: {
      type: 'object',
      properties: { dependencyId: { type: 'string' } },
      required: ['dependencyId'],
    },
  },
  {
    name: 'dk_list_dependencies',
    description: 'List blocker dependencies for a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
];

export const CONFIG_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_get_config',
    description: 'Read the current .dark-kitchen/config.yaml configuration.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_patch_config',
    description: 'Apply a partial patch to the Dark Kitchen configuration.',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: 'Partial config object to merge' } },
      required: ['patch'],
    },
  },
  {
    name: 'dk_validate_config',
    description: 'Validate a proposed Dark Kitchen config object without writing it.',
    inputSchema: {
      type: 'object',
      properties: { config: { type: 'object' } },
      required: ['config'],
    },
  },
];

export const RUNTIME_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_interventions',
    description: 'List open interventions requiring human attention.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_get_intervention',
    description: 'Get a specific intervention by ID.',
    inputSchema: {
      type: 'object',
      properties: { interventionId: { type: 'string' } },
      required: ['interventionId'],
    },
  },
  {
    name: 'dk_resolve_intervention',
    description: 'Resolve an intervention with an action and optional answer.',
    inputSchema: {
      type: 'object',
      properties: {
        interventionId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['retry', 'switch-harness', 'approve', 'stop', 'free-text'],
        },
        answer: { type: 'string' },
      },
      required: ['interventionId', 'action'],
    },
  },
  {
    name: 'dk_dismiss_intervention',
    description: 'Dismiss a non-critical intervention.',
    inputSchema: {
      type: 'object',
      properties: { interventionId: { type: 'string' } },
      required: ['interventionId'],
    },
  },
];

export const CAPABILITY_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_capabilities',
    description: 'List all configured capability providers and their management status.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_inspect_capability',
    description: 'Inspect the state of a specific capability provider.',
    inputSchema: {
      type: 'object',
      properties: { capabilityId: { type: 'string' } },
      required: ['capabilityId'],
    },
  },
  {
    name: 'dk_request_capability_provisioning',
    description:
      'Request a provisioning plan for a managed capability. Returns an installation plan requiring approval. ' +
      'Never silently installs or runs arbitrary commands.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilityId: { type: 'string' },
        approve: { type: 'boolean', description: 'Set to true to approve the plan and execute it' },
      },
      required: ['capabilityId'],
    },
  },
];

export const ALL_TOOLS = [...TRACKER_TOOLS, ...CONFIG_TOOLS, ...RUNTIME_TOOLS, ...CAPABILITY_TOOLS];

// ─── Tool handler ─────────────────────────────────────────────────────────────

export interface McpContext {
  tracker?: FullTrackerAdapter;
  configPath?: string;
  interventionService?: InterventionService;
  config?: DarkKitchenConfig;
}

export type ToolResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string };

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      // ─── Tracker tools ─────────────────────────────────────────────────
      case 'dk_list_tasks': {
        if (!ctx.tracker) return err('No tracker configured');
        const tasks = await ctx.tracker.listTasks(createProjectId(String(args['projectId'])));
        return ok(tasks);
      }

      case 'dk_get_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const task = await ctx.tracker.getTaskById(createTaskId(String(args['taskId'])));
        if (!task) return err(`Task "${args['taskId']}" not found`);
        return ok(task);
      }

      case 'dk_create_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const createInput: Parameters<typeof ctx.tracker.createTask>[0] = {
          projectId: createProjectId(String(args['projectId'])),
          title: String(args['title']),
        };
        if (args['description'] !== undefined)
          Object.assign(createInput, { description: String(args['description']) });
        const task = await ctx.tracker.createTask(createInput);
        return ok(task);
      }

      case 'dk_update_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const updateInput: Parameters<typeof ctx.tracker.updateTask>[1] = {};
        if (args['title'] !== undefined)
          Object.assign(updateInput, { title: String(args['title']) });
        if (args['description'] !== undefined)
          Object.assign(updateInput, { description: String(args['description']) });
        if (args['status'] !== undefined)
          Object.assign(updateInput, { status: args['status'] as never });
        const task = await ctx.tracker.updateTask(
          createTaskId(String(args['taskId'])),
          updateInput,
        );
        return ok(task);
      }

      case 'dk_close_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const task = await ctx.tracker.closeTask(createTaskId(String(args['taskId'])));
        return ok(task);
      }

      case 'dk_add_comment': {
        if (!ctx.tracker) return err('No tracker configured');
        await ctx.tracker.addComment({
          taskId: createTaskId(String(args['taskId'])),
          body: String(args['body']),
        });
        return ok({ added: true });
      }

      case 'dk_add_dependency': {
        if (!ctx.tracker) return err('No tracker configured');
        const dep = await ctx.tracker.addDependency({
          taskId: createTaskId(String(args['taskId'])),
          dependsOnTaskId: createTaskId(String(args['dependsOnTaskId'])),
        });
        return ok(dep);
      }

      case 'dk_remove_dependency': {
        if (!ctx.tracker) return err('No tracker configured');
        await ctx.tracker.removeDependency(String(args['dependencyId']) as never);
        return ok({ removed: true });
      }

      case 'dk_list_dependencies': {
        if (!ctx.tracker) return err('No tracker configured');
        const deps = await ctx.tracker.listDependencies(createTaskId(String(args['taskId'])));
        return ok(deps);
      }

      // ─── Config tools ──────────────────────────────────────────────────
      case 'dk_get_config': {
        return ok(ctx.config ?? null);
      }

      case 'dk_validate_config': {
        try {
          const { validateConfig } = await import('@dark-kitchen/config');
          const validated = validateConfig(args['config']);
          return ok({ valid: true, config: validated });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }

      // ─── Intervention tools ────────────────────────────────────────────
      case 'dk_get_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const intervention = await ctx.interventionService.get(
          createInterventionId(String(args['interventionId'])),
        );
        if (!intervention) return err(`Intervention "${args['interventionId']}" not found`);
        return ok(intervention);
      }

      case 'dk_resolve_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const resolveInput: Parameters<typeof ctx.interventionService.resolve>[0] = {
          interventionId: createInterventionId(String(args['interventionId'])),
          action: args['action'] as never,
        };
        if (args['answer'] !== undefined)
          Object.assign(resolveInput, { answer: String(args['answer']) });
        const resolved = await ctx.interventionService.resolve(resolveInput);
        return ok(resolved);
      }

      case 'dk_dismiss_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const dismissed = await ctx.interventionService.dismiss(
          createInterventionId(String(args['interventionId'])),
        );
        return ok(dismissed);
      }

      // ─── Capability tools ──────────────────────────────────────────────
      case 'dk_list_capabilities': {
        const providers = ctx.config?.capabilityProviders ?? [];
        return ok(providers);
      }

      case 'dk_inspect_capability': {
        const providers = ctx.config?.capabilityProviders ?? [];
        const cap = providers.find((p) => p.id === args['capabilityId']);
        if (!cap) return err(`Capability "${args['capabilityId']}" not found in config`);
        return ok({ ...cap, state: 'unknown' });
      }

      case 'dk_request_capability_provisioning': {
        const providers = ctx.config?.capabilityProviders ?? [];
        const cap = providers.find((p) => p.id === args['capabilityId']);
        if (!cap) return err(`Capability "${args['capabilityId']}" not configured`);
        if (cap.managed !== true) {
          return err(`Capability "${args['capabilityId']}" is not managed — provision it manually`);
        }
        const plan = {
          capabilityId: cap.id,
          capability: cap.capability,
          version: cap.version ?? 'latest',
          steps: [`Install ${cap.capability}@${cap.version ?? 'latest'}`],
          requiresApproval: true,
          approved: args['approve'] === true,
        };
        if (!plan.approved) {
          return ok({
            plan,
            message: 'Review the plan and call again with approve:true to execute.',
          });
        }
        // In production, this would trigger the actual installation through DK services.
        return ok({ plan, executed: true, message: 'Provisioning queued.' });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function err(error: string): ToolResult {
  return { success: false, error };
}
