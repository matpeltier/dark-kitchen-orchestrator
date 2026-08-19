# Dark Kitchen

**Dark Kitchen** is a standalone TypeScript control plane for autonomous software teams.

It connects a PM-facing work tracker (GitHub Issues, Linear, or Jira) with one or more coding agents, a Git/GitHub source-control pipeline, and optional human-in-the-loop channels — without coupling any of those pieces to each other.

## What it does

1. **PM plans work** through Dark Kitchen MCP. Tasks get native blocker dependencies, optional verification requirements, and autonomous approval.
2. **Dark Kitchen schedules ready tasks** in parallel (up to a configurable limit), creating one Git worktree per task.
3. **Coding agents** (Cursor/Claude Code/Gemini CLI/DeepSeek/custom) implement and review the task in the worktree.
4. **Dark Kitchen owns the SCM lifecycle**: push branch → open PR → wait for CI → merge → close tracker task → release worktree.
5. **Verification runs** (Playwright/Maestro/HTTP/command) enforce observable acceptance criteria before merge when the task requests it.
6. **Human interventions** are routed through OpenClaw (Telegram, WhatsApp, Discord, Slack) or direct channel replies — the PM never needs to open an agent terminal.

## Architecture

```
PM (ChatGPT / Claude / other)
       │
       ▼  Dark Kitchen MCP
┌─────────────────────────────────────┐
│  Dark Kitchen Control Plane         │
│                                     │
│  Tracker  ──►  Scheduler  ──►  SCM  │
│  Adapter       (tasks)      Adapter │
│                   │                 │
│              Workflow Engine        │
│                   │                 │
│          ┌────────┼────────┐        │
│          ▼        ▼        ▼        │
│       Harness  Verifier  Channels   │
│       Runtime  Runtime   (OpenClaw) │
└─────────────────────────────────────┘
         ▼                 ▲
    Git Worktrees    Human Replies
    (one per task)
```

**Core invariant**: one active task = one primary Git worktree. Worktrees are never shared between active tasks.

**Role ≠ Harness ≠ Model**: Workflow code references semantic roles (`implementer`, `reviewer`, `verifier`). Harness profiles and models live in `.dark-kitchen/config.yaml`. The workflow engine never hard-codes a vendor name.

## Features

- **Multi-tracker**: GitHub Issues, Linear, Jira — normalized task graph with native blocker relationships
- **Multi-harness**: ACP/acpx (Cursor/Claude Code/Gemini CLI), DeepSeek Harness, and custom native adapters
- **Durable workflows**: SQLite-backed journal; completed agent calls replay on restart, never re-execute
- **Parallel execution**: task graph scheduler with configurable concurrency
- **First-class verification**: Playwright, Maestro, HTTP, and command-exec providers with bounded fix/reverify loops
- **Human-in-the-loop**: OpenClaw bidirectional channel gateway for Telegram/WhatsApp/Discord/Slack
- **MCP control surface**: full PM tooling via MCP server
- **Capability provisioning**: managed providers install into Dark Kitchen-owned storage with explicit approval
- **Security**: secrets never in config/logs, plugin allowlisting, path sanitization, policy gates for destructive actions

## Status

Active development. Core packages (config, runtime store, workspace manager, workflow engine, tracker/SCM adapters, harness, channels, MCP, CLI, verification) are implemented and tested.

## Prerequisites

- Node.js >= 22.13
- pnpm >= 10.14
- Git >= 2.5
- acpx (for ACP harnesses)
- GITHUB_TOKEN / LINEAR_API_KEY / JIRA_TOKEN (for tracker/SCM)

## Quick Start

```sh
# Install
npm install -g dark-kitchen

# Initialize a project
cd your-project
dark-kitchen init

# Edit .dark-kitchen/config.yaml to match your project
# Then start the daemon
dark-kitchen start --foreground

# Check health
dark-kitchen doctor
```

## Configuration

Dark Kitchen is configured in `.dark-kitchen/config.yaml`:

### GitHub Issues + GitHub SCM

```yaml
version: 1

trackers:
  - id: gh-issues
    kind: github-issues
    owner: my-org
    repo: my-repo
    tokenEnv: GITHUB_TOKEN

repositories:
  - id: main-repo
    kind: github
    owner: my-org
    repo: my-repo
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN

harnessProfiles:
  - managed: true
    id: cursor-composer
    kind: cursor-composer
    model: claude-opus-4-5

roles:
  - id: implementer
    harnessProfileId: cursor-composer
  - id: reviewer
    harnessProfileId: cursor-composer

workflows:
  - id: default
    file: .dark-kitchen/workflows/default.ts
    roles: [implementer, reviewer]

mergePolicy:
  strategy: squash
  requiredChecks: [ci]
  requireApproval: false
  deleteHeadBranchAfterMerge: true
```

### Linear + GitHub SCM

```yaml
version: 1

trackers:
  - id: linear
    kind: linear
    workspace: my-workspace
    tokenEnv: LINEAR_API_KEY

repositories:
  - id: main-repo
    kind: github
    owner: my-org
    repo: my-repo
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN

harnessProfiles:
  - managed: true
    id: cursor-composer
    kind: cursor-composer

roles:
  - id: implementer
    harnessProfileId: cursor-composer

workflows:
  - id: default
    file: .dark-kitchen/workflows/default.ts
    roles: [implementer]
```

### Adding E2E verification

```yaml
capabilityProviders:
  - managed: true
    id: playwright
    capability: browser.playwright
    version: '>=1.40'

verificationProfiles:
  - id: web-e2e
    requiredCapabilities: [playwright]
    timeoutSeconds: 300
    retryPolicy:
      maxAttempts: 2
      delaySeconds: 10
    evidencePolicy:
      screenshots: true
      logs: true
    blocking: true
```

## Daily Workflow (PM perspective)

1. **Plan** tasks through Dark Kitchen MCP (`dk_create_task`, `dk_add_dependency`)
2. **Dark Kitchen** autonomously schedules and executes ready tasks in parallel
3. **Monitor** via `dark-kitchen status`, `dk_list_interventions`
4. **Intervene** when needed: `dk_resolve_intervention` with `retry`, `approve`, or `free-text`
5. **Verify**: blocking E2E runs must pass before PR merge

See [docs/mcp.md](docs/mcp.md) for the full MCP tool reference.

## Harnesses

Dark Kitchen supports:

- **ACP/acpx**: Cursor Composer, Claude Code, Gemini CLI, and any custom ACP profile
- **DeepSeek Harness (DSH)**: first-party native adapter (`@dark-kitchen/harness-deepseek`)
- **Custom native**: any local executable via the `native-process` plugin

User-managed harness configurations (`.codex/`, `.claude/`, custom plugins) are never modified.

See [docs/harnesses.md](docs/harnesses.md).

## Human-in-the-Loop

When an agent needs human input (product decision, missing credentials, destructive approval), Dark Kitchen:

1. Creates a typed intervention record
2. Sends a notification through OpenClaw (to Telegram, WhatsApp, Discord, or Slack)
3. Waits for a direct reply or structured action
4. Resumes the exact workflow call that was waiting

See [docs/interventions.md](docs/interventions.md).

## Security

- Secrets are never stored in `.dark-kitchen/config.yaml` or SQLite; use environment variables
- Third-party harness plugins require explicit allowlisting
- Destructive actions (capability install, force-push) require policy approval
- MCP server defaults to local-only binding

See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

Third-party attribution: [packages/workflow-engine/NOTICE.md](packages/workflow-engine/NOTICE.md) (codex-dynamic-workflows, MIT).
