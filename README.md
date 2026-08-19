# Dark Kitchen 🍳

**Dark Kitchen** is a standalone TypeScript control plane for autonomous software teams.

It connects a work tracker (GitHub Issues, Linear, or Jira) with coding agents (Cursor/Claude Code/Codex/Gemini), a GitHub SCM pipeline, and optional human-in-the-loop messaging — all from a single CLI.

---

## Getting started in 5 minutes

### 1. Install and configure

```sh
npx dark-kitchen setup
```

The wizard:

- Checks Node 22+ and git
- Installs `acpx` globally if missing (the agent runtime)
- Asks: tracker type, GitHub org/repo, coding agent, messaging channel (optional), merge policy
- Writes `.dark-kitchen/config.yaml`
- Runs `doctor` to confirm everything is healthy

### 2. Set your credentials

```sh
export GITHUB_TOKEN=ghp_...          # GitHub Issues + SCM
export TELEGRAM_BOT_TOKEN=...        # optional: for notifications
```

Or create `.dark-kitchen/.env` (never committed — it's gitignored by `dk setup`).

### 3. Start the daemon

```sh
dk start --foreground
```

Output:

```
[INFO] Daemon started {"pid":12345}
[ADE] Dashboard: http://localhost:18800
[INFO] Channels: telegram
```

### 4. Open the live dashboard

```sh
dk dashboard
# → opens http://localhost:18800 in your browser
```

You'll see each agent's steps, roles, outputs, and interventions in real time.

### 5. Create tasks and let Dark Kitchen run them

In GitHub Issues, add the label `dk:ready` to any issue you want automated.

Dark Kitchen will:

1. Detect the task
2. Create an isolated git worktree
3. Launch the coding agent in the worktree
4. Open a PR, wait for CI, merge, close the issue
5. Notify you on Telegram/Discord/iMessage if intervention needed

---

## Connect Cursor/ChatGPT as PM

Dark Kitchen exposes an MCP server for PM-level task management. Configure it once and use it from any MCP-compatible client.

### In Cursor

Add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dark-kitchen": {
      "command": "node",
      "args": ["--experimental-sqlite", "/path/to/your-project/node_modules/.bin/dk", "mcp"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

Or if `dk` is installed globally:

```json
{
  "mcpServers": {
    "dark-kitchen": {
      "command": "dk",
      "args": ["mcp"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

### In ChatGPT (custom GPT or Projects)

1. Start the MCP server as an HTTP proxy (requires an MCP-to-HTTP bridge like `mcpx-proxy` or similar)
2. Or use the **PM skill** directly:

### PM skill

Copy `skills/dark-kitchen-pm/SKILL.md` into your custom GPT instructions or ChatGPT Project instructions. This teaches the PM to:

- Create and manage tasks through Dark Kitchen MCP (`dk_*` tools)
- Set native dependency edges (never `Depends on #...` text)
- Configure verification profiles for tasks that need runtime proof
- Inspect capability state and provision managed capabilities safely

### Available MCP tools

| Category     | Tool                                 | What it does                                 |
| ------------ | ------------------------------------ | -------------------------------------------- |
| Tracker      | `dk_list_tasks`                      | List all tasks in the project                |
| Tracker      | `dk_create_task`                     | Create a new task                            |
| Tracker      | `dk_update_task`                     | Update title, description, status            |
| Tracker      | `dk_close_task`                      | Close/complete a task                        |
| Tracker      | `dk_add_comment`                     | Add a comment to a task                      |
| Tracker      | `dk_add_dependency`                  | Add a native blocker edge (validates cycles) |
| Tracker      | `dk_remove_dependency`               | Remove a dependency                          |
| Tracker      | `dk_list_dependencies`               | List dependencies for a task                 |
| Config       | `dk_get_config`                      | Read current `.dark-kitchen/config.yaml`     |
| Config       | `dk_validate_config`                 | Validate a config object                     |
| Runtime      | `dk_list_interventions`              | List open interventions                      |
| Runtime      | `dk_get_intervention`                | Get intervention details                     |
| Runtime      | `dk_resolve_intervention`            | Resolve with retry/approve/stop/free-text    |
| Runtime      | `dk_dismiss_intervention`            | Dismiss a non-critical intervention          |
| Capabilities | `dk_list_capabilities`               | List configured capability providers         |
| Capabilities | `dk_inspect_capability`              | Inspect a capability state                   |
| Capabilities | `dk_request_capability_provisioning` | Plan + approve capability install            |

---

## Configuration reference

```yaml
# .dark-kitchen/config.yaml

version: 1

# ── Tracker ──────────────────────────────────────────────────────
trackers:
  - id: gh-issues
    kind: github-issues # github-issues | linear | jira
    owner: my-org
    repo: my-repo
    tokenEnv: GITHUB_TOKEN

# ── SCM (source control) ─────────────────────────────────────────
repositories:
  - id: main-repo
    kind: github
    owner: my-org
    repo: my-repo
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN

# ── Coding agents ─────────────────────────────────────────────────
harnessProfiles:
  - managed: true
    id: fast-impl
    kind: claude-code # codex | claude-code | gemini-cli
    model: claude-sonnet-4-5
    instructions: 'Focus on tests and clean code.'
    mcpServers:
      - http://localhost:3001 # optional: inject MCP servers into agent sessions

  - managed: true
    id: strong-reviewer
    kind: claude-code
    model: claude-opus-4-5

# ── Roles ─────────────────────────────────────────────────────────
roles:
  - id: implementer
    harnessProfileId: fast-impl
  - id: reviewer
    harnessProfileId: strong-reviewer
    overrides:
      instructions: 'Be strict. Check security and edge cases.'

# ── Workflows ─────────────────────────────────────────────────────
workflows:
  - id: default
    file: .dark-kitchen/workflows/default.ts
    roles: [implementer, reviewer]

# ── Messaging (optional) ─────────────────────────────────────────
channels:
  - id: telegram
    kind: telegram # telegram | discord | slack | imessage
    tokenEnv: TELEGRAM_BOT_TOKEN
    defaultTarget: '123456789' # your Telegram chat ID

# ── Merge policy ─────────────────────────────────────────────────
mergePolicy:
  strategy: squash
  requiredChecks: [ci]
  requireApproval: false
  deleteHeadBranchAfterMerge: true
```

### AGENTS.md — project-level agent instructions

Create `AGENTS.md` (or `.dark-kitchen/AGENTS.md`) in your repository. Dark Kitchen automatically injects it into every agent session. Use it to describe:

- Architecture decisions
- Coding standards
- Testing requirements
- Things agents must never do

```markdown
# Project instructions

## Stack

- TypeScript strict mode, ESM only
- Vitest for tests
- pnpm workspace

## Rules

- Never commit secrets
- All public functions need JSDoc
- Tests must pass before opening a PR
```

---

## Live view (ADE)

```sh
dk start
# → Live dashboard: http://localhost:18800

dk dashboard  # opens browser automatically
```

The dashboard shows in real time:

- Active runs and their task/role
- Steps (start/complete/retry/error)
- Agent output snippets
- Intervention alerts

### Connect to Orca or other ADE

```typescript
import { ADEBridge, WebhookAdeAdapter } from '@dark-kitchen/runtime';

const bridge = new ADEBridge();
// Webhook to any ADE with an HTTP API
bridge.register(new WebhookAdeAdapter('my-ade', 'http://localhost:XXXX/dk-events'));
```

---

## Human-in-the-loop

When an agent is blocked (product decision, missing credentials, quota exhausted), Dark Kitchen:

1. Creates a typed intervention (`auth`, `quota`, `rate-limit`, `approval`, `product-decision`…)
2. Sends a notification on Telegram/Discord/iMessage/Slack
3. Waits for your reply
4. Resumes the exact workflow call that was waiting

You never open an agent terminal. Just reply in your messaging app.

```
🍳 Dark Kitchen — Intervention

Task: #42 Implement OAuth login
Kind: product-decision
Summary: Should we support Google and GitHub OAuth, or GitHub only?

Reply with your answer or:
  1. retry
  2. stop
```

---

## CLI reference

```
dk setup             Interactive setup (installs acpx, creates config)
dk init              Create config template (non-interactive)
dk start             Start the daemon (+ dashboard on :18800)
dk stop              Stop the daemon
dk status            Show daemon status
dk dashboard         Open live dashboard in browser
dk doctor            Check system health
dk config get        Print current config
dk interventions     List open interventions
dk mcp               Start as MCP server on stdio
```

---

## Architecture

```
PM (Cursor / ChatGPT + MCP)
         │
         ▼  dk mcp (stdio)
┌────────────────────────────────────────────────────┐
│  Dark Kitchen Control Plane                        │
│                                                    │
│  GitHub Issues / Linear / Jira (tracker)           │
│         │                                          │
│         ▼                                          │
│  Scheduler → Git worktrees (1 per task)            │
│         │                                          │
│         ▼                                          │
│  Workflow Engine (implement → review → verify)     │
│    ├── implementer role → acpx → Claude Code       │
│    ├── reviewer role    → acpx → Claude Opus       │
│    └── verifier role    → acpx → Playwright/HTTP   │
│         │                                          │
│  AGENTS.md injected into every agent session       │
│  MCP servers passed to acpx per harness profile    │
│         │                                          │
│         ▼                                          │
│  PR lifecycle (push → CI → merge → close issue)    │
│         │                                          │
│  Interventions → Telegram/Discord/iMessage         │
│  Live view     → http://localhost:18800            │
└────────────────────────────────────────────────────┘
```

**Core invariant**: one active task = one primary Git worktree. Never shared.

---

## Trackers

| Tracker       | Label for auto   | Dependency edges           |
| ------------- | ---------------- | -------------------------- |
| GitHub Issues | `dk:ready`       | Native sub-issues API      |
| Linear        | `dk:ready` state | Blocking relations         |
| Jira          | `dk:ready` label | Issue links (configurable) |

**PM rule**: tracker mutations go through Dark Kitchen MCP (`dk_*` tools). Use the GitHub connector separately for code/PR/commit inspection.

---

## Prerequisites

- Node.js >= 22.13
- git
- acpx (`npm install -g acpx` — done automatically by `dk setup`)
- GitHub token with `repo` + `issues` scopes

## License

MIT — see [LICENSE](LICENSE).

Third-party attribution: [packages/workflow-engine/NOTICE.md](packages/workflow-engine/NOTICE.md) (codex-dynamic-workflows, MIT).
