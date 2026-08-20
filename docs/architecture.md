# Architecture and trust boundaries

Dark Kitchen is a standalone, self-hosted control plane. Its core is provider-neutral: trackers, SCM, harness runtimes, channels, persistence, capabilities, and PM clients meet through typed ports rather than importing each other's SDK-specific objects.

![Dark Kitchen architecture](assets/dark-kitchen-architecture.png)

## Control flow

```text
PM client --------> MCP (stdio / authenticated HTTP) --------+
Human messaging --> Channel gateway --> Interventions -------+
                                                            |
Tracker --> normalized task graph --> Scheduler/Supervisor --+
                                      |
                                      v
                         one primary worktree per task
                                      |
                                      v
                         durable dynamic workflow engine
                                      |
                       role resolver --> harness runtime
                                      |
                                      v
                   tests/review/verification result + evidence
                                      |
                                      v
                 SCM PR/check/approval/merge --> tracker close
                                      |
                                      v
                            safe worktree release
```

## Boundaries

| Boundary               | Responsibility                                                                     | Current stock implementations                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tracker                | Work items, normalized status, comments, native blocker edges                      | GitHub Issues, Linear, Jira                                             |
| SCM                    | Repositories, branches, PRs, checks, merge, branch cleanup                         | GitHub                                                                  |
| Scheduler/runtime      | Ready-task selection, concurrency, runs/sessions, control, recovery                | In-process daemon + SQLite store                                        |
| Workspace manager      | Checkout and primary task worktree lifecycle                                       | Git worktrees                                                           |
| Workflow engine        | Semantic role call graph, parallelism, retry, cancellation, journal replay         | Provider-neutral TypeScript engine                                      |
| Harness runtime        | Concrete agent sessions and capability negotiation                                 | ACP/acpx; bundled DSH adapter; optional native/custom plugins           |
| Verification           | Requirements, profiles, runs, criterion verdicts, evidence references, merge gates | Durable file-backed control service plus provider contracts             |
| Capabilities           | Catalog, host state, managed provisioning plans/approval/health                    | Pinned Playwright, Maestro, built-in HTTP, project command              |
| Interventions/channels | Durable human pause/decision plus replaceable delivery/reply                       | Telegram, Discord, Slack, iMessage, WhatsApp; optional OpenClaw adapter |
| MCP                    | PM/agent-facing normalized control tools                                           | stdio and Streamable HTTP                                               |
| Process execution      | Shell-free executable/control/payload separation                                   | Shared Node process API                                                 |

Adapters point inward toward framework-neutral contracts. `packages/core` does not import provider SDKs, transports, databases, or harnesses. The CLI daemon is the composition root that selects concrete adapters from project config.

## The primary-worktree invariant

One active task owns exactly one primary Git worktree. Workflows may run multiple role-specific agents inside it, sequentially or concurrently, but primary worktrees are never shared across active tasks.

The manager derives deterministic filesystem-safe task branch/path identities, returns the same healthy worktree on retry, and detects missing/detached/external mutation. Worktrees persist through agent failure, intervention, PR/check failure, and daemon recovery. Release is permitted only after lifecycle state is safe.

This is isolation, not a general sandbox: agents in a worktree still run with the daemon user's OS/network credentials. Use separate execution users/containers when stronger isolation is required.

## Tracker is not SCM

Tracker providers define tasks and dependency semantics. SCM providers define code and review lifecycle. Keeping them separate enables Linear + GitHub SCM and Jira + GitHub SCM while also preventing a PM from bypassing scheduler policy.

PM work-management mutations go through Dark Kitchen MCP. A GitHub connector may separately supply read context for repository files/history, PR reviews, checks, and CI. Dark Kitchen's SCM adapter owns push/PR/merge transitions after workflow and policy gates.

## Workflow and harness independence

The workflow API sees semantic roles only. `RoleResolver` may asynchronously select any runtime whose declared capabilities satisfy the profile/overrides. Deterministic call keys derive from logical position before async execution, so changing harness latency cannot corrupt journal replay.

ACP/acpx is the primary stock daemon integration. The daemon also selects the bundled DSH adapter for explicit user-managed `deepseek-harness` profiles. Other native/custom adapters implement the same runtime contract, but executable plugin loading remains an explicit host composition/allowlist decision. User-managed profiles are never rewritten to make a workflow fit.

## Process execution and payload transport

Two channels remain deliberately separate:

- **Control metadata:** trusted executable, bounded flags/IDs/paths/enums as an argument array.
- **Payload data:** issue bodies, prompts, human replies, diffs, JSON/config fragments, and outputs through stdin, a programmatic API/stream, or a referenced temporary file.

The shared executor uses `spawn` with `shell: false` and exposes bounded stdout/stderr as programmatic result data. File payloads expose only `DARK_KITCHEN_PAYLOAD_FILE`, never the content, to the child. Diagnostics record payload kind/size rather than complete content.

An exceptional shell escape hatch requires an explicit policy and a separately trusted static command definition; runtime payloads cannot be interpolated into it.

GitHub push authentication is passed in the child environment as an extra header. The token is absent from the remote URL and argv.

## Durable state and recovery

SQLite stores normalized runs, sessions, interventions, events, and task runtime state. Per-run SQLite journals can replay completed workflow calls during an explicit retry. Verification/capability control state uses atomic file replacement in the current services; large proof artifacts remain external and are referenced by ID/path/URL.

Implemented persistence boundaries:

- an explicit workflow retry can reuse completed journal entries and the primary worktree;
- intervention creation/terminal transition is idempotent and durable;
- outbound channel correlations and processed inbound message receipts survive daemon restarts in SQLite;
- PR creation is idempotent by branch;
- PR creation is reused by branch when the lifecycle is deliberately retried.

The stock daemon reconstructs scheduler state from persisted runs on startup: runs cut off mid-execution are resumed with their deterministic run ID (so the durable journal replays completed steps), and human-gated runs are re-seeded as paused. It does not yet reconstruct ACP checkpoints, resume the exact in-flight turn, reconcile workspaces/verification runs on startup, or replay post-merge lifecycle steps. Agent/run controls can create an audited replacement session, but its result is reconnected to the workflow continuation at the call boundary (re-execution), not mid-turn. Exact mid-turn reattachment and post-merge reconciliation remain release blockers for fully crash-safe unattended operation.

## Verification versus capabilities

A task-level verification requirement describes what observable behavior must pass. A config-level profile selects how to prove it. The capability service reports whether the execution node is `available`, `provisionable`, `missing`, `unhealthy`, `requires_auth`, or `unsupported`.

Managed capability installation never begins from task text. It follows:

```text
catalog/inspect -> durable plan -> approval intervention
                -> exact planId + approvalId -> install -> real health probe
```

Pinned managed assets live outside project repositories. Project-provided and user-managed/external assets are inspected without mutation.

The stock daemon parses one requested verification profile, inspects its declared capability providers, selects the verifier workflow, persists the normalized verdict/evidence references, and passes required proof to the PR lifecycle. Not every declarative profile resource is operationalized by the stock executor, and evidence references are not fetched or cryptographically attested. Independent SCM required checks remain essential.

## Human channels

The intervention is durable before notification. `ChannelGateway` attempts bounded delivery, correlates real provider message IDs/codes, rejects malformed/oversized input, and deduplicates successful replies. Direct adapters connect independently so one outage cannot take down others.

The stock daemon uses direct Telegram/Discord/Slack/iMessage/WhatsApp transports; Discord, Slack, and WhatsApp require their documented opt-in peer packages on enabled nodes. `OpenClawGatewayAdapter` is available for embedding deployments that already centralize those channels; core does not require OpenClaw.

## MCP boundary

MCP is an adapter, not an executor. Tool handlers delegate to the same tracker/runtime/intervention/verification/capability services used by the daemon. A missing service yields `service_unavailable`; MCP does not invent a successful run, installation, or verification.

Stdio is local. HTTP defaults to `127.0.0.1:18801/mcp`, validates host/origin/body size, and requires authorization + allowed hosts before non-loopback binding. See [MCP](mcp.md).

## Core invariants

- One active task has one primary Git worktree; active tasks never share it.
- Work-management mutation and source-code/PR access are separate authorities.
- Workflow code uses semantic roles and never imports a provider/model enum.
- Unsupported harness controls fail explicitly through capability negotiation.
- Payload text is never evaluated as a shell command or used to choose an executable.
- Secrets stay out of config values, argv, URLs, logs, PR bodies, and durable payloads.
- Managed host mutation requires a pinned trusted provider, reviewed plan, and audited approval.
- Workflow success alone cannot override configured review, verification, CI, approval, or SCM merge gates.
- No terminal inspection is required for normal PM/operator control.
- Core remains usable without OpenClaw, a particular harness, or any human channel.

## Current composition limits

The repository contains broader port contracts than the stock CLI currently composes. In particular, arbitrary native/custom plugin loading, OpenClaw YAML selection, a non-loopback Telegram webhook listener, and some verification-profile execution resources require host integration. Documentation calls these boundaries out so a declarative field is never mistaken for operational support.
