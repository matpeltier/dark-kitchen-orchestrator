# Dark Kitchen architecture

Dark Kitchen is a standalone control plane for autonomous software teams. The monorepo
contains framework-neutral contracts in `packages/core` and the future HTTP control-plane
composition boundary in `apps/api`.

## Boundaries

| Boundary          | Responsibility                                                                  | Allowed concerns                                                                       |
| ----------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Tracker           | Work-management systems and task state                                          | Provider adapters for GitHub Issues, Linear, Jira, or another tracker                  |
| SCM               | Source repositories, branches, commits, pull requests, and repository lifecycle | GitHub is the initial SCM implementation, but GitHub is not a core requirement         |
| Runtime           | Lifecycle and state of an agent task                                            | Starting, observing, pausing, resuming, and stopping an execution                      |
| Workflow Engine   | Scheduling and coordinating task workflows                                      | Workflow state transitions and orchestration of ports                                  |
| Harness Runtime   | A concrete agent execution environment                                          | ACP/acpx and native/custom harnesses behind runtime ports                              |
| Channels          | Human intervention and communication paths                                      | Approval, escalation, and status interactions without coupling the core to one channel |
| MCP               | Model and PM-facing access to Dark Kitchen capabilities                         | PM clients manage tracker work through Dark Kitchen MCP                                |
| Workspace Manager | Repository checkout and task worktree lifecycle                                 | One primary Git worktree per active task                                               |
| Persistence       | Durable control-plane state and history                                         | Storage behind a port, independent of a particular database                            |
| Process Execution | Shell-free execution and payload transport                                      | Configured executables, bounded control arguments, stdin/stream/file payload channels  |

Tracker providers are adapters: tracker-specific APIs never define the core domain model.
GitHub is the initial SCM implementation, but GitHub is not a core requirement. SCM is
separate from Tracker even when the same vendor supplies both.

PM clients manage tracker work through Dark Kitchen MCP while GitHub remains separately
available for code/PR/commit inspection. MCP is an access boundary, not a replacement for SCM
access.

In short: one task = one primary Git worktree while active. Primary worktrees are not shared.

## Dependency direction

Dependencies point inward toward framework-neutral domain contracts:

```text
Channels / MCP / API
          |
          v
Workflow Engine -> Runtime -> Harness Runtime
          |
          +----> Tracker adapters
          +----> SCM adapters
          +----> Workspace Manager
          +----> Persistence
```

Adapters and infrastructure implement core ports; core does not import an adapter, harness,
transport, tracker SDK, SCM SDK, database client, or channel implementation. The API exposes
operational capabilities and composes these ports. Workflow execution, adapters, harnesses,
notifications, and MCP tools are intentionally not implemented by this bootstrap.

## Process execution and payload transport

The process boundary has two deliberately separate channels:

- Control metadata is small, bounded process configuration: an executable path, identifiers,
  safe artifact paths, flags, and enum values. It is passed as an executable plus an argument
  array through `@dark-kitchen/process-execution`.
- Payload data is arbitrary or potentially large: tracker bodies, prompts, agent outputs, human
  replies, diffs, JSON/config fragments, and structured context. It must travel through the typed
  payload transport as stdin, a stream, or a referenced file artifact. It must never be
  interpolated into a shell command string, executable definition, or CLI argument vector.

`defineProcess` keeps the configured executable and bounded arguments separate from each
`ProcessInvocation` payload. The shared executor uses `spawn` with `shell: false`, closes stdin
when there is no stdin payload, and exposes stdout/stderr only as programmatic result data. File
payloads expose only `DARK_KITCHEN_PAYLOAD_FILE`, a bounded path reference, to the child process.
ACP/acpx and native/custom process launch profiles both construct invocations using this same
transport boundary.

Shell execution is an exceptional compatibility escape hatch. It requires an explicit
`allowExceptionalShell` policy, accepts only a trusted configured shell command, and has no
payload parameter. Runtime diagnostics contain process metadata and payload kind/size only; they
must not log complete payload contents.

## Invariants

- Every active task has exactly one primary Git worktree.
- One task = one primary Git worktree while active; primary worktrees are not shared between
  active tasks.
- All operationally relevant agent state and control are exposed through the Dark Kitchen API
  without requiring terminal access.
- The core architecture cannot require Orca, Codex, GitHub Issues, ChatGPT, OpenClaw, ACP/acpx,
  or any particular harness.
- Tracker work-management access and SCM/code-context access remain separate contracts.
- A harness is replaceable without changing tracker, SCM, workflow, channel, MCP, workspace,
  or persistence contracts.
