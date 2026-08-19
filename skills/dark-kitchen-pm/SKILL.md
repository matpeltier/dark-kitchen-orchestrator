# Dark Kitchen PM Skill

**Trigger:** Use this skill whenever you are acting as a PM/product manager on a project that uses Dark Kitchen for autonomous task execution.

## Purpose

This skill teaches you to:

- Manage tracker work through Dark Kitchen MCP (not directly through GitHub/Linear/Jira connectors)
- Decompose product work into small vertical slices with observable acceptance criteria
- Configure verification profiles for tasks that require runtime proof
- Provision capabilities safely through Dark Kitchen services
- Inspect runtime state and intervene when needed

## Core Rules

### Work Management

- **Always use Dark Kitchen MCP** (`dk_*` tools) for task CRUD, dependency edges, labels, and state transitions — even when the underlying tracker is GitHub Issues.
- You may use the GitHub connector for **read-only code context** (files, commits, diffs, PRs, CI logs, reviews), but never for task mutation.
- Use **native dependency edges** (not "Depends on #..." text in issue bodies) to express blocking relationships.
- Validate cycles before adding dependencies: `dk_add_dependency` will reject cycles.

### Task Decomposition

1. Inspect current state first: `dk_list_tasks`, `dk_get_task`.
2. Decompose large work into small vertical slices, each with:
   - A clear, implementation-agnostic title.
   - Acceptance criteria describing **observable outcomes**, not internal architecture.
   - Native blocker edges to ordered predecessors.
3. Do not create roadmap-level tasks or epics unless the user explicitly requests them.

### Verification Requirements

Only add verification requirements when **normal repository tests cannot adequately prove the requested behavior**.

When a task needs runtime proof, add it to the task description (not in issue body macros) and select or create a verification profile:

| User need           | Default profile | Default provider     |
| ------------------- | --------------- | -------------------- |
| Web UI behavior     | `web-e2e`       | `browser.playwright` |
| Native mobile       | `mobile-e2e`    | `mobile.maestro`     |
| HTTP API / REST     | `api-e2e`       | `api.http`           |
| Existing repo suite | `command-e2e`   | `command.exec`       |

**Before assuming a provider exists**, inspect capability state: `dk_inspect_capability`, `dk_list_capabilities`.

**Reuse** an already-healthy capability rather than reinstalling per task.

### Capability Provisioning

1. `dk_list_capabilities` — see what is configured.
2. `dk_inspect_capability` — check per-node state.
3. `dk_request_capability_provisioning` — get a plan (without `approve: true`).
4. Review the plan. If it looks correct: `dk_request_capability_provisioning` with `approve: true`.
5. Never tell the user to manually run npm/apt/brew install commands for managed capabilities.
6. For user-managed/external capabilities: surface the dependency clearly and ask the user to set it up.

### Interventions

- `dk_list_interventions` — see open human-attention items.
- `dk_get_intervention` — inspect details.
- `dk_resolve_intervention` with the appropriate action: `retry`, `approve`, `stop`, `free-text`, `switch-harness`.
- Operational interventions (auth, quota, rate-limit) affect only runtime — do not update tracker state unless the product requirement itself is blocked.
- Product-decision interventions may warrant updating the task description with the resolution.

### Runtime Controls

Use runtime controls only as a fallback, not as routine operation:

- `dk_list_interventions` — check for pending escalations first.
- Sending instructions or stopping agents requires explicitly degraded situations.

## Workflow

```
1. Inspect current state
   dk_list_tasks → dk_get_task → check config/capabilities

2. Plan
   Decompose → identify dependencies → identify verification needs

3. Configure
   Create/update tasks → set native dependency edges
   Add verification profile to config if new proof needed
   Provision required managed capabilities with approval

4. Monitor
   Check interventions → resolve or escalate
   Use runtime controls only when agents are stuck/looping

5. Close
   Verify evidence → close/complete tasks
```

## Verification Profile Example

```yaml
# .dark-kitchen/config.yaml (excerpt)
verificationProfiles:
  - id: web-e2e
    requiredCapabilities: [playwright]
    timeoutSeconds: 300
    retryPolicy: { maxAttempts: 2, delaySeconds: 10 }
    evidencePolicy: { screenshots: true, logs: true }
    blocking: true

capabilityProviders:
  - managed: true
    id: playwright
    capability: browser.playwright
    version: '>=1.40'
```

## What the PM Must NOT Do

- Directly call GitHub/Linear/Jira APIs for task mutation.
- Spawn coding or verifier agents directly.
- Run installers or system commands from task bodies or issue text.
- Create sub-agents or worktrees (Dark Kitchen does this automatically).
- Add "Depends on #N" text to issue bodies (use native dependency edges instead).
- Install arbitrary machine-changing commands without an explicit Dark Kitchen provisioning plan and approval.

## Installation

Copy this skill file to your AI client's skill/instructions directory. The file name is `SKILL.md`. Do not overwrite existing skill files; add as a new skill entry.
