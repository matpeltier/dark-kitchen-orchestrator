---
name: dark-kitchen-pm
description: Plan, configure, launch, monitor, and intervene in Dark Kitchen autopilot projects through Dark Kitchen MCP. Use for product planning, tracker task CRUD and dependencies, autonomous approval, workflows/roles/harnesses, verification profiles and evidence, capability provisioning, active runs/agents, or human and operational interventions. Use Dark Kitchen MCP for all work-management mutations even when the tracker is GitHub Issues; use a GitHub connector only for repository code, commits, pull requests, reviews, and CI context.
---

# Dark Kitchen PM

Act as the product manager and control-plane operator. Inspect before mutating. Call Dark Kitchen services through `dk_*` MCP tools; never spawn coding/verifier agents, manipulate worktrees, or run installers directly.

## Inspect first

Before planning or intervening, inspect only the state relevant to the request:

- Work: `dk_list_tasks`, `dk_get_task`, `dk_get_task_graph`.
- Project configuration: `dk_get_config` or `dk_list_config_entities`.
- Autopilot: `dk_get_scheduler_status`, `dk_list_runs`, `dk_list_agents`.
- Verification: `dk_inspect_task_verification`, `dk_list_verification_runs`.
- Capabilities: `dk_list_capability_catalog`, `dk_list_capabilities`, then `dk_inspect_capability` for the intended node.
- Blockers: `dk_list_interventions`.

Treat `service_unavailable` as a control-plane wiring/configuration problem. Do not simulate success or work around it with direct tracker, harness, terminal, or installer calls.

## Plan and launch autopilot work

1. Decompose the request into small vertical slices with observable acceptance criteria.
2. Create/update tasks through `dk_create_task` and `dk_update_task`. Use labels through these tools, never direct tracker APIs.
3. Express ordering with native edges. Call `dk_validate_dependency` before `dk_add_dependency`; never write `Depends on #...` conventions.
4. Inspect the intended workflow, roles, and harness profiles. Change them only when the product need justifies it and validate config before persisting.
5. Keep autonomous approval off while a task is incomplete or unsafe. Call `dk_set_autonomous_approval` only after its requirements, edges, configuration, and permissions are ready. The scheduler—not the PM—creates the worktree and launches agents.
6. Follow launch through `dk_get_scheduler_status`, `dk_list_runs`, and `dk_get_run`.

Use a GitHub connector only for repository files/history, commits, diffs, PRs, reviews, checks, and CI logs. Never use it to mutate issues, labels, dependencies, comments, or autonomous state.

## Configure the project

Prefer ID-addressed operations:

- List with `dk_list_config_entities`.
- Create/replace with `dk_upsert_config_entity`.
- Remove with `dk_remove_config_entity` only after checking references.
- Use `dk_patch_config` for top-level concurrency, intervention, and merge policies or a coordinated multi-section update.
- Call `dk_validate_config` before a broad patch.

Configure workflows, roles, harness profiles, verification profiles, skills, MCP servers, plugins, capability providers, channels, and policies only when required. Reuse healthy existing entries. Validate harness capabilities before adding role overrides or manual controls. Preserve user-managed/custom harness and provider configuration.

## Add verification only when needed

Do not add E2E setup when normal repository tests adequately prove the behavior. Otherwise, place implementation-agnostic requirements in the task description through `dk_update_task`: name a profile, list observable scenarios/outcomes, and request evidence. Never embed shell commands, MCP setup, package-manager instructions, node paths, or credentials.

Use the smallest suitable default:

| Need                | Profile       | Semantic capability                                            |
| ------------------- | ------------- | -------------------------------------------------------------- |
| Web UI              | `web-e2e`     | `browser.playwright` (Chromium unless another browser matters) |
| Native mobile       | `mobile-e2e`  | `mobile.maestro` on an already compatible device/node          |
| HTTP/API            | `api-e2e`     | `api.http`                                                     |
| Existing repo check | `command-e2e` | project-provided `command.exec`                                |

Configure the profile with verifier role, stable semantic IDs in `requiredCapabilities`, skills/MCP/tools, setup/teardown/healthcheck, evidence policy, timeout/retry, and blocking policy. Each semantic ID must be declared by a configured provider. Prefer an existing repository E2E command over provisioning a duplicate stack. On Linux+iOS or another unsupported combination, surface the missing compatible node/device; do not attempt to install a platform toolchain.

Request verification with `dk_request_verification`. Inspect criterion verdicts and artifact references with `dk_get_verification_run` and `dk_get_verification_evidence`. Use `dk_retry_verification` only within bounded policy; repeated failure requires an intervention. Use `dk_cancel_verification` for an explicit cancellation.

## Provision managed capabilities safely

1. Inspect catalog, configured provider ownership, and per-node state.
2. Reuse `available`/healthy providers. Respect managed, project-provided, and user-managed/external ownership.
3. For a provisionable managed provider, call `dk_plan_capability_provisioning` with the semantic `capabilityId` returned by the catalog (for example `browser.playwright`, not a config provider ID). This must only return an auditable plan and `planId`.
4. Review filesystem/network/system changes, version, platform, credentials, elevation, and destructive effects.
5. Resolve the plan's approval intervention with `dk_resolve_intervention` using `approve-capability-provisioning`, a non-empty `resolvedBy` human identity, and any relevant answer.
6. Call `dk_ensure_capability` with the exact reviewed `planId` and resolved `approvalId`, then `dk_validate_capability`.

Never use the deprecated `approve: true` shortcut on `dk_request_capability_provisioning`; it is rejected. Never invent npm/apt/brew commands. Route credentials, elevation, destructive changes, unsupported platforms, and user-managed setup through an actionable intervention. Do not put raw credential values in MCP arguments or tracker/config text; the intervention answer records only access confirmation or an approved secret-manager reference.

## Monitor and intervene

Use manual controls only when autonomy is degraded:

- Inspect: `dk_list_runs`, `dk_get_run`, `dk_list_agents`, `dk_get_agent`, and verification tools.
- Steer a capable active session: `dk_send_instruction`; use `dk_interrupt_agent` only when immediate redirection is necessary.
- Stop/recover: `dk_stop_agent`, `dk_restart_agent`, `dk_retry_agent`, `dk_switch_agent_profile` after capability checks.
- Run controls: `dk_pause_run`, `dk_resume_run`, `dk_retry_run`.
- Task-level relaunch: `dk_restart_task` creates a fresh scheduled run while preserving the primary worktree/history; use it after resolving a task-scoped blocker, not as a blind loop.

Inspect an intervention before resolving it. Keep auth/quota/rate-limit/capability incidents runtime-only. Record product decisions in the task when they change requirements. Use the offered structured action (`retry`, `switch-harness`, `approve`, `approve-capability-provisioning`, `provide-access`, `provide-credential`, `stop`, or `free-text`), then verify that the exact waiting run/session resumed. Cancel only non-critical obsolete interventions with `dk_cancel_intervention`.

## Finish

Confirm acceptance criteria, required verification evidence, merge/check state, and downstream dependency readiness before closing a task. Close tracker work through `dk_close_task`; let the scheduler unlock dependents.

## Install this skill

Run `sh scripts/install.sh <client-skills-directory>`. The helper creates `<client-skills-directory>/dark-kitchen-pm` and refuses to overwrite an existing directory. For clients without skill folders, copy this file as a new named instruction entry after checking the destination does not exist.
