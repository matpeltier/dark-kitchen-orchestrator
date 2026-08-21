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

import { wouldCreateCycle, type FullTrackerAdapter } from '@dark-kitchen/tracker';
import type { DarkKitchenConfig } from '@dark-kitchen/config';
import type { InterventionService } from '@dark-kitchen/runtime';
import {
  createConfigurationId,
  createEventId,
  createProjectId,
  createTaskId,
  createInterventionId,
} from '@dark-kitchen/core';
import { dirname } from 'node:path';
import { zodSchemaFromJsonSchema } from './schema.js';
import type {
  CapabilityControlService,
  ConfigEntitySection,
  InterventionResolutionControlService,
  RuntimeControlService,
  TrackerControlService,
  VerificationControlService,
} from './services.js';

// ─── Tool descriptors ─────────────────────────────────────────────────────────

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

const NON_EMPTY_STRING_SCHEMA = { type: 'string', minLength: 1 } as const;
const CONFIG_ENTITY_SECTIONS: readonly ConfigEntitySection[] = [
  'trackers',
  'repositories',
  'workflows',
  'roles',
  'harnessProfiles',
  'verificationProfiles',
  'capabilityProviders',
  'channels',
];

export const TRACKER_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_tasks',
    description:
      'List all tasks in the configured tracker project. Use this for work-management operations. ' +
      'For GitHub repository code, commits, diffs, or PRs, use the GitHub connector instead.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { ...NON_EMPTY_STRING_SCHEMA, description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'dk_get_task',
    description: 'Get a single task by its Dark Kitchen task ID.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_create_task',
    description: 'Create a new task in the tracker with a title and optional description.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: NON_EMPTY_STRING_SCHEMA,
        title: NON_EMPTY_STRING_SCHEMA,
        description: { type: 'string' },
        labels: { type: 'array', items: NON_EMPTY_STRING_SCHEMA },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'dk_update_task',
    description: 'Update a task title, description, labels, or normalized status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: NON_EMPTY_STRING_SCHEMA,
        title: NON_EMPTY_STRING_SCHEMA,
        description: { type: 'string' },
        labels: { type: 'array', items: NON_EMPTY_STRING_SCHEMA },
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
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_add_comment',
    description: 'Add a comment to a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA, body: NON_EMPTY_STRING_SCHEMA },
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
        taskId: { ...NON_EMPTY_STRING_SCHEMA, description: 'The task that is blocked' },
        dependsOnTaskId: {
          ...NON_EMPTY_STRING_SCHEMA,
          description: 'The task that blocks it',
        },
      },
      required: ['taskId', 'dependsOnTaskId'],
    },
  },
  {
    name: 'dk_remove_dependency',
    description: 'Remove a blocker dependency by dependency ID.',
    inputSchema: {
      type: 'object',
      properties: { dependencyId: NON_EMPTY_STRING_SCHEMA },
      required: ['dependencyId'],
    },
  },
  {
    name: 'dk_list_dependencies',
    description: 'List blocker dependencies for a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_list_comments',
    description: 'List normalized tracker comments for a task through Dark Kitchen.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_get_task_graph',
    description:
      'Read the normalized task graph, including tasks and native dependency edges, for planning autopilot work.',
    inputSchema: {
      type: 'object',
      properties: { projectId: NON_EMPTY_STRING_SCHEMA },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_validate_dependency',
    description:
      'Validate whether a native blocker edge would create a dependency cycle without mutating the tracker.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: NON_EMPTY_STRING_SCHEMA,
        taskId: NON_EMPTY_STRING_SCHEMA,
        dependsOnTaskId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['projectId', 'taskId', 'dependsOnTaskId'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'dk_set_autonomous_approval',
    description:
      'Approve or revoke autonomous execution for a tracker task through the configured Dark Kitchen policy service.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: NON_EMPTY_STRING_SCHEMA,
        approved: { type: 'boolean' },
      },
      required: ['taskId', 'approved'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
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
  {
    name: 'dk_list_config_entities',
    description:
      'List one configurable Dark Kitchen section such as workflows, roles, harnesses, verification profiles, providers, or channels.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: CONFIG_ENTITY_SECTIONS },
      },
      required: ['section'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_upsert_config_entity',
    description:
      'Create or replace one ID-addressed config entity, then validate and atomically persist the full configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: CONFIG_ENTITY_SECTIONS },
        entity: {
          type: 'object',
          properties: { id: NON_EMPTY_STRING_SCHEMA },
          required: ['id'],
          additionalProperties: true,
        },
      },
      required: ['section', 'entity'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'dk_remove_config_entity',
    description:
      'Remove one ID-addressed config entity, validating references before atomically persisting the change.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: CONFIG_ENTITY_SECTIONS },
        id: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['section', 'id'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

export const RUNTIME_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_ask_human',
    description:
      'Ask the human a question and wait for their reply. The question is sent over the ' +
      'configured messaging channel (e.g. Telegram) and this blocks until the human answers. ' +
      'Use this when you need a product decision, clarification, or approval before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          ...NON_EMPTY_STRING_SCHEMA,
          description: 'The question to ask the human',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86_400_000,
          description: 'How long to wait for a reply (ms) before giving up. Defaults to 30 min.',
        },
        requestId: {
          ...NON_EMPTY_STRING_SCHEMA,
          description:
            'Stable caller-generated ID. Reusing it makes MCP/network replays return the same durable intervention.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'dk_list_interventions',
    description: 'List interventions with open human-attention items first, followed by history.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_get_intervention',
    description: 'Get a specific intervention by ID.',
    inputSchema: {
      type: 'object',
      properties: { interventionId: NON_EMPTY_STRING_SCHEMA },
      required: ['interventionId'],
    },
  },
  {
    name: 'dk_resolve_intervention',
    description: 'Resolve an intervention with an action and optional answer.',
    inputSchema: {
      type: 'object',
      properties: {
        interventionId: NON_EMPTY_STRING_SCHEMA,
        action: {
          type: 'string',
          enum: [
            'retry',
            'switch-harness',
            'approve',
            'approve-capability-provisioning',
            'provide-access',
            'provide-credential',
            'stop',
            'free-text',
          ],
        },
        answer: { type: 'string' },
        resolvedBy: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['interventionId', 'action', 'resolvedBy'],
    },
  },
  {
    name: 'dk_dismiss_intervention',
    description: 'Legacy alias for cancelling a non-critical intervention.',
    inputSchema: {
      type: 'object',
      properties: { interventionId: NON_EMPTY_STRING_SCHEMA },
      required: ['interventionId'],
    },
  },
  {
    name: 'dk_cancel_intervention',
    description:
      'Cancel/dismiss an open non-critical intervention while preserving its durable audit record.',
    inputSchema: {
      type: 'object',
      properties: {
        interventionId: NON_EMPTY_STRING_SCHEMA,
        resolvedBy: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Optional human identity recording who cancelled the intervention.',
        },
      },
      required: ['interventionId'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

export const CAPABILITY_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_capability_catalog',
    description:
      'List the normalized capability/provider catalog, ownership, supported platforms, and health probe metadata.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_list_capabilities',
    description:
      'List configured capability provider references. Use inspect for actual per-node runtime state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_inspect_capability',
    description:
      'Inspect the per-node state of a semantic capability ID returned by the capability catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilityId: NON_EMPTY_STRING_SCHEMA,
        nodeId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['capabilityId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_request_capability_provisioning',
    description:
      'Compatibility alias that requests a provisioning plan only. It never installs; approve the returned plan through an intervention, then call dk_ensure_capability.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilityId: NON_EMPTY_STRING_SCHEMA,
        nodeId: NON_EMPTY_STRING_SCHEMA,
        approve: {
          type: 'boolean',
          description: 'Deprecated. true is rejected; use a reviewed plan ID and approval ID.',
        },
      },
      required: ['capabilityId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_plan_capability_provisioning',
    description:
      'Ask the capability service for an auditable, non-executing installation plan for one managed semantic capability ID and node.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilityId: NON_EMPTY_STRING_SCHEMA,
        nodeId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['capabilityId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_ensure_capability',
    description:
      'Ensure an approved managed capability using the exact reviewed plan ID and resolved approval intervention ID.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: NON_EMPTY_STRING_SCHEMA,
        approvalId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['planId', 'approvalId'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'dk_validate_capability',
    description:
      'Run the capability service healthcheck for a configured capability on an optional execution node.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilityId: NON_EMPTY_STRING_SCHEMA,
        nodeId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['capabilityId'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];

export const VERIFICATION_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_inspect_task_verification',
    description:
      'Inspect implementation-agnostic verification requirements attached to a tracker task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_list_verification_runs',
    description: 'List active and historical normalized verification runs, optionally by task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_get_verification_run',
    description:
      'Get a verification run with per-criterion pass/fail/blocked verdicts and evidence references.',
    inputSchema: {
      type: 'object',
      properties: { verificationRunId: NON_EMPTY_STRING_SCHEMA },
      required: ['verificationRunId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_get_verification_evidence',
    description:
      'List normalized evidence references for a verification run and optional criterion; binary artifacts are not embedded.',
    inputSchema: {
      type: 'object',
      properties: {
        verificationRunId: NON_EMPTY_STRING_SCHEMA,
        criterionName: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['verificationRunId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_request_verification',
    description:
      'Request verification for a task through the configured verification service; this does not launch a harness directly.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: NON_EMPTY_STRING_SCHEMA,
        profileId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['taskId'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'dk_retry_verification',
    description: 'Request a bounded retry of an existing verification run through workflow policy.',
    inputSchema: {
      type: 'object',
      properties: { verificationRunId: NON_EMPTY_STRING_SCHEMA },
      required: ['verificationRunId'],
    },
  },
  {
    name: 'dk_cancel_verification',
    description: 'Cancel an active verification run through the verification service.',
    inputSchema: {
      type: 'object',
      properties: { verificationRunId: NON_EMPTY_STRING_SCHEMA },
      required: ['verificationRunId'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

export const PM_CONTROL_TOOLS: McpToolDescriptor[] = [
  {
    name: 'dk_list_runs',
    description:
      'List all workflow runs recorded by the daemon (history). Each run maps to a task ' +
      'execution and has a state (running/completed/failed).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_get_run',
    description: 'Get a single run by ID, including its agent sessions and interventions.',
    inputSchema: {
      type: 'object',
      properties: { runId: { ...NON_EMPTY_STRING_SCHEMA, description: 'Run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'dk_list_sessions',
    description: 'List agent sessions (live or historical). Pass an optional runId to filter.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { ...NON_EMPTY_STRING_SCHEMA, description: 'Optional run ID to filter by' },
      },
      required: [],
    },
  },
  {
    name: 'dk_get_session',
    description: 'Get a single agent session by ID.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: NON_EMPTY_STRING_SCHEMA },
      required: ['sessionId'],
    },
  },
  {
    name: 'dk_list_agents',
    description:
      'List normalized agent sessions with role, harness, model, state, activity, error, and usage metadata when available.',
    inputSchema: {
      type: 'object',
      properties: { runId: NON_EMPTY_STRING_SCHEMA },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_get_agent',
    description: 'Get one normalized agent session and its negotiated control capabilities.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: NON_EMPTY_STRING_SCHEMA },
      required: ['sessionId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dk_send_instruction',
    description:
      'Send a live instruction to a RUNNING agent session. The agent will process it ' +
      'in its current turn — use this to steer the agent mid-task.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: NON_EMPTY_STRING_SCHEMA,
        instruction: {
          ...NON_EMPTY_STRING_SCHEMA,
          description: 'Instruction to send to the agent',
        },
      },
      required: ['sessionId', 'instruction'],
    },
  },
  {
    name: 'dk_interrupt_agent',
    description:
      'Interrupt the current agent turn with an instruction (cancel + send). Use to ' +
      'redirect an agent that is going down the wrong path.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: NON_EMPTY_STRING_SCHEMA,
        instruction: {
          ...NON_EMPTY_STRING_SCHEMA,
          description: 'Instruction to send after interrupting',
        },
      },
      required: ['sessionId', 'instruction'],
    },
  },
  {
    name: 'dk_stop_agent',
    description:
      'Stop an agent session (cancels the current turn). The task may still be auto-resumed ' +
      'by the scheduler on the next tick unless you also pause/stop the task.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: NON_EMPTY_STRING_SCHEMA },
      required: ['sessionId'],
    },
  },
  {
    name: 'dk_restart_agent',
    description:
      'Restart a stopped/failed agent through the runtime service, preserving the run, worktree, and audit history.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: NON_EMPTY_STRING_SCHEMA },
      required: ['sessionId'],
    },
  },
  {
    name: 'dk_retry_agent',
    description:
      'Retry the failed workflow call represented by an agent session through durable runtime policy.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: NON_EMPTY_STRING_SCHEMA },
      required: ['sessionId'],
    },
  },
  {
    name: 'dk_switch_agent_profile',
    description:
      'Switch a stopped/failed agent to a compatible harness profile, creating a new audited session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: NON_EMPTY_STRING_SCHEMA,
        harnessProfileId: NON_EMPTY_STRING_SCHEMA,
      },
      required: ['sessionId', 'harnessProfileId'],
    },
  },
  {
    name: 'dk_pause_run',
    description: 'Pause a workflow run through runtime policy without manipulating a terminal.',
    inputSchema: {
      type: 'object',
      properties: { runId: NON_EMPTY_STRING_SCHEMA },
      required: ['runId'],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'dk_resume_run',
    description: 'Resume a paused workflow run through runtime policy.',
    inputSchema: {
      type: 'object',
      properties: { runId: NON_EMPTY_STRING_SCHEMA },
      required: ['runId'],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'dk_retry_run',
    description:
      'Retry a failed/stopped workflow run through durable runtime policy without creating duplicate work.',
    inputSchema: {
      type: 'object',
      properties: { runId: NON_EMPTY_STRING_SCHEMA },
      required: ['runId'],
    },
  },
  {
    name: 'dk_pause_task',
    description:
      'Pause a task so the scheduler stops launching it. Combined with dk_stop_agent for ' +
      'total stop. Use dk_resume_task (or dk_restart_task) to re-enable.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_resume_task',
    description: 'Resume a paused task so the scheduler can launch it again.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_stop_task',
    description:
      'Stop a task completely: pauses it, removes it from active/completed bookkeeping, and ' +
      'sets it blocked on the tracker so it stays stopped across daemon restarts.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_restart_task',
    description:
      'Restart a task: clears scheduler bookkeeping (active/completed/paused), reopens the ' +
      'task on the tracker so it is scheduled again with a fresh run.',
    inputSchema: {
      type: 'object',
      properties: { taskId: NON_EMPTY_STRING_SCHEMA },
      required: ['taskId'],
    },
  },
  {
    name: 'dk_get_scheduler_status',
    description: 'Current scheduler state: active runs, paused tasks, completed tasks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dk_get_diagnostics',
    description: 'Store diagnostics: schema version, table row counts, SQLite integrity check.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export const ALL_TOOLS = [
  ...TRACKER_TOOLS,
  ...CONFIG_TOOLS,
  ...RUNTIME_TOOLS,
  ...VERIFICATION_TOOLS,
  ...CAPABILITY_TOOLS,
  ...PM_CONTROL_TOOLS,
];

// ─── Tool handler ─────────────────────────────────────────────────────────────

export interface McpContext {
  tracker?: FullTrackerAdapter;
  trackerControls?: TrackerControlService;
  configPath?: string;
  interventionService?: InterventionService;
  config?: DarkKitchenConfig;
  store?: import('@dark-kitchen/core').RuntimeStore;
  supervisor?: import('@dark-kitchen/runtime').RunSupervisor;
  agentControls?: import('@dark-kitchen/runtime').AgentControlService;
  runtimeControls?: RuntimeControlService;
  verification?: VerificationControlService;
  capabilities?: CapabilityControlService;
  interventionResolutionControls?: InterventionResolutionControlService;
}

export type ToolErrorCode =
  | 'invalid_arguments'
  | 'not_found'
  | 'conflict'
  | 'unsupported'
  | 'approval_required'
  | 'authorization_failed'
  | 'service_unavailable'
  | 'operation_failed'
  | 'unknown_tool';

export type ToolResult =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly code: ToolErrorCode;
      readonly error: string;
      readonly details?: unknown;
      readonly retryable: boolean;
    };

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<ToolResult> {
  const descriptor = ALL_TOOLS.find((tool) => tool.name === name);
  if (!descriptor) return fail('unknown_tool', `Unknown Dark Kitchen tool: ${name}`);

  const parsed = zodSchemaFromJsonSchema(descriptor.inputSchema).safeParse(args);
  if (!parsed.success) {
    return fail('invalid_arguments', `Invalid arguments for ${name}`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const input = parsed.data;
  args = input;

  try {
    switch (name) {
      // ─── Tracker tools ─────────────────────────────────────────────────
      case 'dk_list_tasks': {
        if (!ctx.tracker) return err('No tracker configured');
        const tasks = await ctx.tracker.listTasks(createProjectId(String(input['projectId'])));
        return ok(tasks);
      }

      case 'dk_get_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const task = await ctx.tracker.getTaskById(createTaskId(String(input['taskId'])));
        if (!task) return fail('not_found', `Task "${input['taskId']}" not found`);
        return ok(task);
      }

      case 'dk_create_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const createInput: Parameters<typeof ctx.tracker.createTask>[0] = {
          projectId: createProjectId(String(input['projectId'])),
          title: String(input['title']),
        };
        if (input['description'] !== undefined)
          Object.assign(createInput, { description: String(input['description']) });
        if (input['labels'] !== undefined)
          Object.assign(createInput, { labels: input['labels'] as string[] });
        const task = await ctx.tracker.createTask(createInput);
        return ok(task);
      }

      case 'dk_update_task': {
        if (!ctx.tracker) return err('No tracker configured');
        const updateInput: Parameters<typeof ctx.tracker.updateTask>[1] = {};
        if (input['title'] !== undefined)
          Object.assign(updateInput, { title: String(input['title']) });
        if (input['description'] !== undefined)
          Object.assign(updateInput, { description: String(input['description']) });
        if (input['status'] !== undefined)
          Object.assign(updateInput, { status: input['status'] as never });
        if (input['labels'] !== undefined)
          Object.assign(updateInput, { labels: input['labels'] as string[] });
        if (Object.keys(updateInput).length === 0) {
          return fail('invalid_arguments', 'dk_update_task requires at least one changed field');
        }
        const task = await ctx.tracker.updateTask(
          createTaskId(String(input['taskId'])),
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

      case 'dk_list_comments': {
        if (!ctx.trackerControls) {
          return fail('service_unavailable', 'No tracker comment-read service configured');
        }
        return ok(await ctx.trackerControls.listComments(String(args['taskId'])));
      }

      case 'dk_get_task_graph': {
        return ok(await getTaskGraph(String(args['projectId']), ctx));
      }

      case 'dk_validate_dependency': {
        const graph = await getTaskGraph(String(args['projectId']), ctx);
        const taskId = createTaskId(String(args['taskId']));
        const dependsOnTaskId = createTaskId(String(args['dependsOnTaskId']));
        const graphTaskIds = new Set(
          graph.tasks
            .filter(isRecord)
            .map((task) => task['id'])
            .filter((id): id is string => typeof id === 'string'),
        );
        const missingTaskIds = [taskId, dependsOnTaskId].filter((id) => !graphTaskIds.has(id));
        if (missingTaskIds.length > 0) {
          return fail(
            'not_found',
            `Dependency references unknown task(s): ${missingTaskIds.join(', ')}`,
          );
        }
        const dependencies = new Map<
          import('@dark-kitchen/core').TaskId,
          Set<import('@dark-kitchen/core').TaskId>
        >();
        for (const rawDependency of graph.dependencies) {
          if (!isRecord(rawDependency)) continue;
          const dependent = createTaskId(String(rawDependency['taskId']));
          const blocker = createTaskId(String(rawDependency['dependsOnTaskId']));
          const existing = dependencies.get(dependent) ?? new Set();
          existing.add(blocker);
          dependencies.set(dependent, existing);
        }
        const createsCycle = wouldCreateCycle(dependencies, taskId, dependsOnTaskId);
        return ok({ valid: !createsCycle, createsCycle, taskId, dependsOnTaskId });
      }

      case 'dk_set_autonomous_approval': {
        if (!ctx.trackerControls) {
          return fail('service_unavailable', 'No autonomous-approval service configured');
        }
        return ok(
          await ctx.trackerControls.setAutonomousApproval(
            String(args['taskId']),
            Boolean(args['approved']),
          ),
        );
      }

      // ─── Config tools ──────────────────────────────────────────────────
      case 'dk_get_config': {
        return ok((await readCurrentConfig(ctx)) ?? null);
      }

      case 'dk_patch_config': {
        if (!isRecord(args['patch']) || Object.keys(args['patch']).length === 0) {
          return fail('invalid_arguments', 'dk_patch_config requires a non-empty patch object');
        }
        const store = await getConfigStore(ctx);
        const updated = await store.patch(args['patch'] as never);
        return ok(updated);
      }

      case 'dk_validate_config': {
        const { validateConfig } = await import('@dark-kitchen/config');
        const validated = validateConfig(args['config']);
        return ok({ valid: true, config: validated });
      }

      case 'dk_list_config_entities': {
        const config = await readCurrentConfig(ctx);
        if (!config) return fail('service_unavailable', 'No project config configured');
        const section = args['section'] as ConfigEntitySection;
        return ok(config[section] ?? []);
      }

      case 'dk_upsert_config_entity': {
        const config = await requireCurrentConfig(ctx);
        const section = args['section'] as ConfigEntitySection;
        const entity = args['entity'] as Record<string, unknown>;
        const current = [...(config[section] ?? [])] as Array<Record<string, unknown>>;
        const existingIndex = current.findIndex((entry) => entry['id'] === entity['id']);
        if (existingIndex >= 0) current[existingIndex] = entity;
        else current.push(entity);
        const store = await getConfigStore(ctx);
        const updated = await store.patch({ [section]: current } as never);
        return ok(updated);
      }

      case 'dk_remove_config_entity': {
        const config = await requireCurrentConfig(ctx);
        const section = args['section'] as ConfigEntitySection;
        const id = String(args['id']);
        const current = [...(config[section] ?? [])] as Array<Record<string, unknown>>;
        if (!current.some((entry) => entry['id'] === id)) {
          return fail('not_found', `Config entity "${id}" not found in ${section}`);
        }
        const store = await getConfigStore(ctx);
        const updated = await store.patch({
          [section]: current.filter((entry) => entry['id'] !== id),
        } as never);
        return ok(updated);
      }

      // ─── Intervention tools ────────────────────────────────────────────
      case 'dk_ask_human': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? Number(args['timeoutMs']) : undefined;
        const result = await ctx.interventionService.askHuman(String(args['question']), {
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(typeof args['requestId'] === 'string' ? { requestId: args['requestId'] } : {}),
        });
        return ok(result);
      }

      case 'dk_list_interventions': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const interventions = await ctx.interventionService.list();
        return ok(interventions);
      }

      case 'dk_get_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const intervention = await ctx.interventionService.get(
          createInterventionId(String(args['interventionId'])),
        );
        if (!intervention) {
          return fail('not_found', `Intervention "${args['interventionId']}" not found`);
        }
        return ok(intervention);
      }

      case 'dk_resolve_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const requestedAction = String(args['action']);
        const action =
          requestedAction === 'approve-capability-provisioning'
            ? 'approve'
            : requestedAction === 'provide-access' || requestedAction === 'provide-credential'
              ? 'free-text'
              : requestedAction;
        if (
          ['free-text', 'provide-access', 'provide-credential', 'switch-harness'].includes(
            requestedAction,
          ) &&
          (typeof args['answer'] !== 'string' || args['answer'].trim().length === 0)
        ) {
          return fail('invalid_arguments', `${requestedAction} requires a non-empty answer`);
        }
        const resolveInput: Parameters<typeof ctx.interventionService.resolve>[0] = {
          interventionId: createInterventionId(String(args['interventionId'])),
          action: action as never,
        };
        if (args['answer'] !== undefined)
          Object.assign(resolveInput, { answer: String(args['answer']) });
        if (args['resolvedBy'] !== undefined)
          Object.assign(resolveInput, { resolvedBy: String(args['resolvedBy']) });
        const resolved = await ctx.interventionService.resolve(resolveInput);
        if (ctx.interventionResolutionControls) {
          await ctx.interventionResolutionControls.apply({
            scope: resolved.scope,
            targetId: resolved.targetId,
            kind: resolved.kind,
            ...(resolved.details ? { details: resolved.details } : {}),
            action: action as 'retry' | 'switch-harness' | 'approve' | 'stop' | 'free-text',
            ...(args['answer'] !== undefined ? { answer: String(args['answer']) } : {}),
          });
        }
        return ok(resolved);
      }

      case 'dk_dismiss_intervention':
      case 'dk_cancel_intervention': {
        if (!ctx.interventionService) return err('No intervention service configured');
        const rawResolvedBy = args['resolvedBy'];
        const dismissed = await ctx.interventionService.dismiss(
          createInterventionId(String(args['interventionId'])),
          typeof rawResolvedBy === 'string' && rawResolvedBy.trim().length > 0
            ? { resolvedBy: rawResolvedBy }
            : undefined,
        );
        return ok(dismissed);
      }

      // ─── Capability tools ──────────────────────────────────────────────
      case 'dk_list_capability_catalog': {
        if (!ctx.capabilities) {
          return fail('service_unavailable', 'No capability catalog service configured');
        }
        return ok(await ctx.capabilities.listCatalog());
      }

      case 'dk_list_capabilities': {
        const config = await readCurrentConfig(ctx);
        const providers = config?.capabilityProviders ?? [];
        return ok(providers);
      }

      case 'dk_inspect_capability': {
        if (ctx.capabilities) {
          return ok(
            await ctx.capabilities.inspect({
              capabilityId: String(args['capabilityId']),
              ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
            }),
          );
        }
        const config = await readCurrentConfig(ctx);
        const providers = config?.capabilityProviders ?? [];
        const cap = providers.find((provider) => provider.capability === args['capabilityId']);
        if (!cap) {
          return fail(
            'not_found',
            `Capability "${args['capabilityId']}" not found in project config`,
          );
        }
        return ok({
          provider: cap,
          nodeId: args['nodeId'] ?? null,
          state: 'unknown',
          actionableRequirement:
            cap.managed === true
              ? 'The capability runtime service is unavailable; no install was attempted.'
              : 'This provider is project/user managed. Preserve its configuration and satisfy its documented prerequisites.',
        });
      }

      case 'dk_request_capability_provisioning':
      case 'dk_plan_capability_provisioning': {
        if (args['approve'] === true) {
          return fail(
            'approval_required',
            'Inline approve:true is no longer accepted. Review a plan, resolve its approval intervention, then call dk_ensure_capability with both IDs.',
          );
        }
        if (!ctx.capabilities) {
          return fail(
            'service_unavailable',
            'No capability provisioning service configured; no installation plan was invented and no command was run.',
          );
        }
        const plan = await ctx.capabilities.planProvisioning({
          capabilityId: String(args['capabilityId']),
          ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
        });
        // CapabilityService exposes the durable plan key as `id`, while the
        // execution method deliberately accepts `planId`. Keep the public MCP
        // contract explicit and backward compatible without changing the
        // service-owned record.
        if (isRecord(plan) && typeof plan['id'] === 'string' && plan['planId'] === undefined) {
          return ok({ ...plan, planId: plan['id'] });
        }
        return ok(plan);
      }

      case 'dk_ensure_capability': {
        if (!ctx.capabilities) {
          return fail('service_unavailable', 'No managed capability service configured');
        }
        return ok(
          await ctx.capabilities.ensureManaged({
            planId: String(args['planId']),
            approvalId: String(args['approvalId']),
          }),
        );
      }

      case 'dk_validate_capability': {
        if (!ctx.capabilities) {
          return fail('service_unavailable', 'No capability healthcheck service configured');
        }
        return ok(
          await ctx.capabilities.validate({
            capabilityId: String(args['capabilityId']),
            ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
          }),
        );
      }

      // ─── Verification tools ────────────────────────────────────────────
      case 'dk_inspect_task_verification': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(await ctx.verification.inspectTaskRequirements(String(args['taskId'])));
      }

      case 'dk_list_verification_runs': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(
          await ctx.verification.listRuns(
            args['taskId'] !== undefined ? String(args['taskId']) : undefined,
          ),
        );
      }

      case 'dk_get_verification_run': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        const run = await ctx.verification.getRun(String(args['verificationRunId']));
        if (!run) {
          return fail('not_found', `Verification run "${args['verificationRunId']}" not found`);
        }
        return ok(run);
      }

      case 'dk_get_verification_evidence': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(
          await ctx.verification.getEvidence(
            String(args['verificationRunId']),
            args['criterionName'] !== undefined ? String(args['criterionName']) : undefined,
          ),
        );
      }

      case 'dk_request_verification': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(
          await ctx.verification.request({
            taskId: String(args['taskId']),
            ...(args['profileId'] !== undefined ? { profileId: String(args['profileId']) } : {}),
          }),
        );
      }

      case 'dk_retry_verification': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(await ctx.verification.retry(String(args['verificationRunId'])));
      }

      case 'dk_cancel_verification': {
        if (!ctx.verification) {
          return fail('service_unavailable', 'No verification service configured');
        }
        return ok(await ctx.verification.cancel(String(args['verificationRunId'])));
      }

      default:
        break;
    }
  } catch (e) {
    return errorFromException(e);
  }

  // PM control-plane tools are handled separately.
  return handlePmTool(name, args, ctx);
}

// ─── PM control-plane helpers ────────────────────────────────────────────────

export async function handlePmTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'dk_list_runs': {
        if (!ctx.store) return err('No runtime store configured');
        const store = ctx.store;
        const runs = await store.listRuns();
        const workflowRuns = await store.listWorkflowRuns();
        const sessions = await store.listAgentSessions();
        return ok({
          runs,
          workflowCount: workflowRuns.length,
          sessionCount: sessions.length,
        });
      }

      case 'dk_get_run': {
        if (!ctx.store) return err('No runtime store configured');
        const store = ctx.store;
        const runId = String(args['runId']) as import('@dark-kitchen/core').RunId;
        const run = await store.getRun(runId);
        if (!run) return fail('not_found', `Run "${args['runId']}" not found`);
        const sessions = (await store.listAgentSessions()).filter((s) => s.runId === runId);
        const interventions = ctx.interventionService ? await ctx.interventionService.list() : [];
        const sessionIds = new Set(sessions.map((session) => session.id));
        const runInterventions = interventions.filter(
          (intervention) =>
            intervention.targetId === runId ||
            intervention.targetId === run.taskId ||
            sessionIds.has(intervention.targetId as import('@dark-kitchen/core').AgentSessionId),
        );
        return ok({ run, sessions, interventions: runInterventions });
      }

      case 'dk_list_sessions':
      case 'dk_list_agents': {
        if (name === 'dk_list_agents' && ctx.runtimeControls) {
          return ok(
            await ctx.runtimeControls.listAgents(
              args['runId'] !== undefined ? String(args['runId']) : undefined,
            ),
          );
        }
        if (!ctx.agentControls) return err('No agent control service configured');
        const runId = args['runId'] !== undefined ? String(args['runId']) : undefined;
        const sessions = await ctx.agentControls.listSessions(
          runId as import('@dark-kitchen/core').RunId | undefined,
        );
        return ok(sessions);
      }

      case 'dk_get_session':
      case 'dk_get_agent': {
        if (name === 'dk_get_agent' && ctx.runtimeControls) {
          const agent = await ctx.runtimeControls.getAgent(String(args['sessionId']));
          if (!agent) return fail('not_found', `Agent "${args['sessionId']}" not found`);
          return ok(agent);
        }
        if (!ctx.agentControls) return err('No agent control service configured');
        const session = await ctx.agentControls.getSession(
          String(args['sessionId']) as import('@dark-kitchen/core').AgentSessionId,
        );
        if (!session) return fail('not_found', `Session "${args['sessionId']}" not found`);
        return ok(session);
      }

      case 'dk_send_instruction': {
        if (!ctx.agentControls) return err('No agent control service configured');
        await ctx.agentControls.sendInstruction(
          String(args['sessionId']) as import('@dark-kitchen/core').AgentSessionId,
          String(args['instruction']),
        );
        return ok({ sent: true });
      }

      case 'dk_interrupt_agent': {
        if (!ctx.agentControls) return err('No agent control service configured');
        await ctx.agentControls.interruptAndSend(
          String(args['sessionId']) as import('@dark-kitchen/core').AgentSessionId,
          String(args['instruction']),
        );
        return ok({ interrupted: true });
      }

      case 'dk_stop_agent': {
        if (!ctx.agentControls) return err('No agent control service configured');
        await ctx.agentControls.stopSession(
          String(args['sessionId']) as import('@dark-kitchen/core').AgentSessionId,
        );
        return ok({ stopped: true });
      }

      case 'dk_restart_agent': {
        if (!ctx.runtimeControls) {
          return fail(
            'service_unavailable',
            'No audited agent restart service configured; the existing session was not reused.',
          );
        }
        return ok(await ctx.runtimeControls.restartAgent(String(args['sessionId'])));
      }

      case 'dk_retry_agent': {
        if (!ctx.runtimeControls) {
          return fail(
            'service_unavailable',
            'No durable agent retry service configured; restart was not simulated.',
          );
        }
        return ok(await ctx.runtimeControls.retryAgent(String(args['sessionId'])));
      }

      case 'dk_switch_agent_profile': {
        if (!ctx.runtimeControls) {
          return fail('service_unavailable', 'No harness/profile switch service configured');
        }
        return ok(
          await ctx.runtimeControls.switchAgentProfile(
            String(args['sessionId']),
            String(args['harnessProfileId']),
          ),
        );
      }

      case 'dk_pause_run': {
        if (!ctx.runtimeControls) {
          return fail('service_unavailable', 'No audited run pause service configured');
        }
        return ok(await ctx.runtimeControls.pauseRun(String(args['runId'])));
      }

      case 'dk_resume_run': {
        if (!ctx.runtimeControls) {
          return fail('service_unavailable', 'No audited run resume service configured');
        }
        return ok(await ctx.runtimeControls.resumeRun(String(args['runId'])));
      }

      case 'dk_retry_run': {
        if (!ctx.runtimeControls) {
          return fail('service_unavailable', 'No audited run retry service configured');
        }
        return ok(await ctx.runtimeControls.retryRun(String(args['runId'])));
      }

      case 'dk_pause_task': {
        if (!ctx.supervisor) return err('No supervisor configured');
        const taskId = String(args['taskId']) as import('@dark-kitchen/core').TaskId;
        ctx.supervisor.pauseTask(taskId);
        return ok({ paused: true, taskId });
      }

      case 'dk_resume_task': {
        if (!ctx.supervisor) return err('No supervisor configured');
        const taskId = String(args['taskId']) as import('@dark-kitchen/core').TaskId;
        ctx.supervisor.resumeTask(taskId);
        return ok({ resumed: true, taskId });
      }

      case 'dk_stop_task': {
        if (!ctx.supervisor) return err('No supervisor configured');
        const taskId = String(args['taskId']) as import('@dark-kitchen/core').TaskId;
        ctx.supervisor.stopTask(taskId);
        await ctx.tracker?.setBlocked(taskId);
        return ok({ stopped: true, taskId, blocked: true });
      }

      case 'dk_restart_task': {
        if (!ctx.supervisor) return err('No supervisor configured');
        const taskId = String(args['taskId']) as import('@dark-kitchen/core').TaskId;
        ctx.supervisor.retryTask(taskId);
        // Flip the tracker state to ready (label dk:blocked → dk:ready) so the
        // daemon loop re-schedules the task on the next tick.
        await ctx.tracker?.updateTask(taskId, { status: 'ready' });
        return ok({ restarted: true, taskId });
      }

      case 'dk_get_scheduler_status': {
        if (!ctx.supervisor) return err('No supervisor configured');
        const supervisor = ctx.supervisor;
        return ok({
          activeRuns: [...supervisor.getActiveRuns().entries()].map(([taskId, runId]) => ({
            taskId,
            runId,
          })),
          pausedTasks: [...supervisor.getPausedTasks()],
          completedTasks: [...supervisor.getCompletedTasks()],
          maxParallelTasks: supervisor.getMaxParallelTasks(),
        });
      }

      case 'dk_get_diagnostics': {
        if (!ctx.store) return err('No runtime store configured');
        return ok(ctx.store.getDiagnostics());
      }

      default:
        return err(`Unknown PM tool: ${name}`);
    }
  } catch (e) {
    return errorFromException(e);
  }
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function err(error: string): ToolResult {
  const unavailable = error.startsWith('No ');
  return fail(
    unavailable ? 'service_unavailable' : 'operation_failed',
    error,
    undefined,
    unavailable,
  );
}

function fail(
  code: ToolErrorCode,
  error: string,
  details?: unknown,
  retryable = false,
): ToolResult {
  return {
    success: false,
    code,
    error,
    retryable,
    ...(details !== undefined ? { details } : {}),
  };
}

function errorFromException(error: unknown): ToolResult {
  const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
  const name = error instanceof Error ? error.name : '';
  if (name === 'ServiceUnavailableError') {
    return fail('service_unavailable', message, undefined, true);
  }
  if (/not found/i.test(message)) return fail('not_found', message);
  if (/cycle|already|conflict|race|state/i.test(`${name} ${message}`)) {
    return fail('conflict', message);
  }
  if (/unsupported/i.test(`${name} ${message}`)) return fail('unsupported', message);
  if (/auth|permission|forbidden|unauthor/i.test(`${name} ${message}`)) {
    return fail('authorization_failed', message);
  }
  if (/approval|credential|quota|rate.?limit/i.test(`${name} ${message}`)) {
    return fail('approval_required', message, undefined, true);
  }
  if (/valid|argument|schema|config/i.test(name)) return fail('invalid_arguments', message);
  return fail('operation_failed', message);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;&]+/giu, '$1$2[REDACTED]')
    .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/giu, '$1[REDACTED]');
}

async function getTaskGraph(projectId: string, ctx: McpContext) {
  if (ctx.trackerControls) return ctx.trackerControls.getGraph(projectId);
  if (!ctx.tracker) {
    throw new ServiceUnavailableError('No tracker graph service configured');
  }
  const tasks = await ctx.tracker.listTasks(createProjectId(projectId));
  const dependencies = (
    await Promise.all(tasks.map((task) => ctx.tracker!.listDependencies(task.id)))
  ).flat();
  return { projectId, tasks, dependencies };
}

async function readCurrentConfig(ctx: McpContext): Promise<DarkKitchenConfig | undefined> {
  if (ctx.configPath) {
    const store = await getConfigStore(ctx);
    return store.read();
  }
  return ctx.config;
}

async function requireCurrentConfig(ctx: McpContext): Promise<DarkKitchenConfig> {
  const config = await readCurrentConfig(ctx);
  if (!config) throw new ServiceUnavailableError('No project config configured');
  return config;
}

async function getConfigStore(ctx: McpContext) {
  if (!ctx.configPath) throw new ServiceUnavailableError('No config path configured');
  const { ConfigStore } = await import('@dark-kitchen/config');
  const runtimeStore = ctx.store;
  return new ConfigStore({
    projectRoot: dirname(dirname(ctx.configPath)),
    ...(runtimeStore
      ? {
          onChanged: async (event) =>
            runtimeStore.appendEvent({
              id: createEventId(event.id),
              type: 'configuration.changed',
              occurredAt: event.occurredAt,
              payload: {
                configurationId: createConfigurationId('project-config'),
                key: event.payload.configPath,
                version: event.payload.newVersion,
              },
            }),
        }
      : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class ServiceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}
