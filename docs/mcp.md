# Dark Kitchen MCP control plane

Dark Kitchen exposes one PM-facing MCP server. Tracker mutations, project configuration, autopilot approval, runtime controls, interventions, verification, and managed capability provisioning cross this boundary as normalized Dark Kitchen objects. A separate GitHub connector remains appropriate for repository files/history, commits, PRs, reviews, checks, and CI; it must not mutate tracker work.

MCP is an adapter, not an executor. Tool handlers call injected Dark Kitchen services. They never spawn a coding/verifier harness, run an installer, create a worktree, or synthesize successful runtime state.

## Transports and security

`startServer(context)` serves stdio. The standalone `dark-kitchen mcp` command currently builds only a reduced config-snapshot/tracker/intervention context. It is not a substitute for the running daemon and returns `service_unavailable` for live supervisor, runtime, verification, and provisioning operations. A complete PM control plane uses the daemon-populated HTTP server.

`startMcpHttpServer(context, options)` serves stateless Streamable HTTP at `/mcp` and defaults to `127.0.0.1:18801`. Its boundary provides:

- strict `/mcp` routing and Host-header validation;
- browser Origin denial unless `allowedOrigins` explicitly permits it;
- optional constant-time bearer-token validation or an `authorize(request)` hook;
- a configurable body limit (16 MiB by default, large enough for multi-megabyte task specs);
- JSON errors for unauthorized, malformed, oversized, and unknown-path requests;
- per-request MCP server/transport cleanup.

A non-loopback bind is rejected unless both an authorization boundary (`authToken` or `authorize`) and `allowedHosts` are configured. Use HTTPS plus OAuth or an authenticated reverse proxy for remote exposure; a static bearer token is suitable only for controlled machine-to-machine/VPN use. Never put tokens in `.dark-kitchen/config.yaml`, logs, task bodies, URLs, or MCP tool arguments; intervention answers carry access confirmation or an approved secret-manager reference, not raw credentials.

```ts
const server = await startMcpHttpServer(context, {
  host: '0.0.0.0',
  port: 18801,
  allowedHosts: ['dark-kitchen.internal.example'],
  authorize: async (request) => verifyProxyIdentity(request),
});
```

## Tool families

Tracker/work management:

- `dk_list_tasks`, `dk_get_task`, `dk_create_task`, `dk_update_task`, `dk_close_task`
- `dk_add_comment`, `dk_list_comments`
- `dk_get_task_graph`, `dk_validate_dependency`, `dk_add_dependency`, `dk_remove_dependency`, `dk_list_dependencies`
- `dk_set_autonomous_approval`

Configuration:

- `dk_get_config`, `dk_validate_config`, `dk_patch_config`
- `dk_list_config_entities`, `dk_upsert_config_entity`, `dk_remove_config_entity`

ID-addressed entity tools cover trackers, repositories, workflows, roles, harness profiles, verification profiles, capability providers, and channels. A validated broad patch covers concurrency, intervention, and merge policies. Skills, MCP servers, and plugins live in the relevant role/harness/verification entity rather than in an unvalidated side store. Writes use `ConfigStore` validation/atomic replacement and, when the daemon runtime store is present, journal a normalized `configuration.changed` event.

Runtime/autopilot:

- `dk_get_scheduler_status`, `dk_list_runs`, `dk_get_run`
- `dk_list_agents`, `dk_get_agent` (`dk_list_sessions`/`dk_get_session` remain compatibility aliases)
- `dk_send_instruction`, `dk_interrupt_agent`, `dk_stop_agent`, `dk_restart_agent`, `dk_retry_agent`, `dk_switch_agent_profile`
- `dk_pause_run`, `dk_resume_run`, `dk_retry_run`
- `dk_pause_task`, `dk_resume_task`, `dk_stop_task`, `dk_restart_task`
- `dk_get_diagnostics`

Interventions:

- `dk_ask_human`, `dk_list_interventions`, `dk_get_intervention`
- `dk_resolve_intervention`, `dk_cancel_intervention` (`dk_dismiss_intervention` is a compatibility alias)

Verification:

- `dk_inspect_task_verification`
- `dk_list_verification_runs`, `dk_get_verification_run`, `dk_get_verification_evidence`
- `dk_request_verification`, `dk_retry_verification`, `dk_cancel_verification`

Capabilities:

- `dk_list_capability_catalog`, `dk_list_capabilities`, `dk_inspect_capability`
- `dk_plan_capability_provisioning`, `dk_ensure_capability`, `dk_validate_capability`
- `dk_request_capability_provisioning` remains a plan-only compatibility alias

## Safe capability lifecycle

Planning and installation are separate to prevent an approval bypass or plan/execution time-of-check/time-of-use mismatch:

1. Inspect the catalog, configured provider ownership, and per-node state.
2. Call `dk_plan_capability_provisioning` with the semantic `capabilityId` from the catalog (for example `browser.playwright`, not a configured provider record ID). MCP normalizes the durable service plan `id` to the stable public `planId`, alongside the pinned provider/version, approval intervention ID, and proposed filesystem/network/process changes. Nothing is installed.
3. Route required approval/credentials/elevation/destructive changes through an intervention.
4. Resolve that intervention with `approve-capability-provisioning` and a non-empty `resolvedBy` identity, then call `dk_ensure_capability` with the exact reviewed `planId` and `approvalId`. MCP normalizes that semantic action to the runtime's audited `approve` resolution expected by the approval gateway.
5. Call `dk_validate_capability` for the health probe.

The legacy `approve: true` input is rejected. When `CapabilityControlService` is absent, planning/ensure/healthcheck return `service_unavailable`; MCP does not invent a plan or claim that provisioning was queued. Project-provided and user-managed/external providers remain untouched and return actionable prerequisites through the injected service.

## Results and errors

MCP text content remains human-readable JSON. `structuredContent` uses one of these normalized envelopes:

```json
{ "success": true, "data": {} }
```

```json
{
  "success": false,
  "code": "service_unavailable",
  "error": "No verification service configured",
  "retryable": true,
  "details": {}
}
```

Stable error codes are `invalid_arguments`, `not_found`, `conflict`, `unsupported`, `approval_required`, `authorization_failed`, `service_unavailable`, `operation_failed`, and `unknown_tool`. Invalid/missing/extra inputs are rejected before a service call. Provider errors are normalized rather than returned as raw payloads.

## Daemon wiring contract

The daemon passes existing `tracker`, `configPath`, `config`, `store`, `supervisor`, `agentControls`, and `interventionService` fields. Complete issue #19 behavior also requires the following exported structural interfaces from `@dark-kitchen/mcp`:

```ts
const context: McpContext = {
  // existing services...
  trackerControls: {
    getGraph: async (projectId) => ({ projectId, tasks, dependencies }),
    listComments: async (taskId) => comments,
    setAutonomousApproval: async (taskId, approved) => approvalResult,
  },
  runtimeControls: {
    listAgents: async (runId) => agents,
    getAgent: async (sessionId) => agent,
    restartAgent: async (sessionId) => newSession,
    retryAgent: async (sessionId) => newSession,
    switchAgentProfile: async (sessionId, harnessProfileId) => newSession,
    pauseRun: async (runId) => run,
    resumeRun: async (runId) => run,
    retryRun: async (runId) => run,
  },
  verification: {
    inspectTaskRequirements: async (taskId) => requirement,
    listRuns: async (taskId) => runs,
    getRun: async (runId) => run,
    getEvidence: async (runId, criterionName) => evidenceRefs,
    request: async ({ taskId, profileId }) => run,
    retry: async (runId) => run,
    cancel: async (runId) => run,
  },
  capabilities: {
    listCatalog: async () => catalog,
    inspect: async ({ capabilityId, nodeId }) => state,
    planProvisioning: async ({ capabilityId, nodeId }) => plan,
    ensureManaged: async ({ planId, approvalId }) => state,
    validate: async ({ capabilityId, nodeId }) => health,
  },
};
```

`trackerControls`, `runtimeControls`, `verification`, and `capabilities` must delegate to the same audited services used by CLI/daemon flows. The MCP package intentionally does not construct them. Missing optional wiring produces an explicit `service_unavailable` result. Historical run reads and low-level live instruction/interrupt/stop controls retain compatibility fallbacks to `store` and `agentControls`. Restart/retry/profile-switch, run state transitions, verification, and provisioning require their audited service and are never simulated.

## PM autopilot sequence

1. Read config, task graph, scheduler/runtime, interventions, and relevant capability state.
2. Create small tasks with observable acceptance criteria through MCP.
3. Validate/add native blocker edges.
4. Configure/reuse workflow roles, harnesses, and optional verification profiles.
5. Plan and approve any managed capability changes through the two-step lifecycle.
6. Set autonomous approval only when the task is ready. The scheduler allocates/reuses the primary worktree and launches the workflow.
7. Follow run, agent, verification, and intervention state.
8. Resolve an intervention, then request a supported audited control. Across daemon restarts, interrupted runs resume through durable journal replay (completed steps replay, the in-flight step re-runs); exact mid-turn workflow-call continuation remains incomplete. Use `dk_restart_task` only for an intentional fresh task run.
9. Inspect verdict/evidence and close task work through MCP.
