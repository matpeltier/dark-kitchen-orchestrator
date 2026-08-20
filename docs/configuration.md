# Configuration

Dark Kitchen reads `.dark-kitchen/config.yaml` from the repository root. The current schema version is `1`. Reads run registered migrations before strict validation; writes use a temporary file plus rename so a partial write cannot replace the last valid config.

Use environment-variable **names** in `tokenEnv`/`token2Env`. Never put a token value in YAML.

## Complete example

```yaml
version: 1

trackers:
  - id: work
    kind: github-issues
    owner: my-org
    repo: my-project
    tokenEnv: GITHUB_TOKEN

repositories:
  - id: source
    kind: github
    owner: my-org
    repo: my-project
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN

concurrency:
  maxParallelTasks: 2
  maxParallelWorkflows: 2

harnessProfiles:
  - managed: true
    id: codex-main
    kind: codex
    model: gpt-5.6-codex
    instructions: Follow AGENTS.md, run relevant tests, and inspect the final diff.
    mcpServers:
      - http://127.0.0.1:9000/mcp

  - managed: true
    id: opencode-review
    kind: opencode
    model: anthropic/claude-sonnet-4-5

roles:
  - id: implementer
    harnessProfileId: codex-main
  - id: reviewer
    harnessProfileId: opencode-review
  - id: fixer
    harnessProfileId: codex-main
  - id: repository-tester
    harnessProfileId: codex-main
  - id: verifier
    harnessProfileId: opencode-review

verificationProfiles:
  - id: web-e2e
    verifierRoleId: verifier
    requiredCapabilities: [playwright]
    timeoutSeconds: 300
    retryPolicy:
      maxAttempts: 2
      delaySeconds: 10
    evidencePolicy:
      screenshots: true
      logs: true
      reports: [trace]
    blocking: true

capabilityProviders:
  - managed: true
    id: playwright
    capability: browser.playwright
    version: 1.62.1
  - managed: false
    id: project-e2e
    capability: command.exec
    description: Repository-owned E2E command

workflows:
  - id: default
    builtin: default
    default: true
    description: Implement, review, fix, test, then optionally verify
    roles: [implementer, reviewer, fixer, repository-tester, verifier]
    verificationProfiles: [web-e2e]

channels:
  - id: owner-telegram
    kind: telegram
    tokenEnv: TELEGRAM_BOT_TOKEN
    defaultTarget: '123456789'
    allowedSenderIds: ['123456789']
  - id: team-slack
    kind: slack
    tokenEnv: SLACK_BOT_TOKEN
    token2Env: SLACK_APP_TOKEN
    defaultTarget: C0123456789

interventionPolicy:
  escalateOnBlockedSeconds: 300
  escalateOnFailedAttempts: 3
  channels: [owner-telegram]

mergePolicy:
  strategy: squash
  requiredChecks: [ci]
  requireApproval: true
  deleteHeadBranchAfterMerge: true
```

## Root fields

| Field                  | Meaning                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `version`              | Required literal `1`. Missing pre-versioned files migrate to version 1 on read.                 |
| `trackers`             | Work-management adapters. The daemon currently uses the first configured tracker.               |
| `repositories`         | SCM adapters. GitHub is the currently supported SCM kind; the daemon uses the first repository. |
| `concurrency`          | `maxParallelTasks` and `maxParallelWorkflows`, both positive integers.                          |
| `harnessProfiles`      | Managed ACP profiles or declarations for user-managed/custom profiles.                          |
| `roles`                | Semantic workflow role → harness profile mapping, with optional managed-profile overrides.      |
| `verificationProfiles` | How this installation proves task-level verification requirements.                              |
| `capabilityProviders`  | Managed, project-provided, or external/user-managed capability declarations.                    |
| `workflows`            | Built-in templates or trusted project modules plus deterministic task selectors.                |
| `channels`             | Messaging transports and environment-variable references.                                       |
| `interventionPolicy`   | Escalation thresholds and channel IDs.                                                          |
| `mergePolicy`          | Merge method, required checks, approval gate, and branch cleanup.                               |

Unknown object fields are rejected by the MCP input schemas; cross-reference validation also rejects duplicate IDs, missing role/profile references, unknown workflow verification profiles, and unknown intervention channels.

## Trackers and repositories

### GitHub Issues + GitHub SCM

```yaml
trackers:
  - id: work
    kind: github-issues
    owner: my-org
    repo: my-project
    tokenEnv: GITHUB_TOKEN
repositories:
  - id: source
    kind: github
    owner: my-org
    repo: my-project
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN
```

The two entries may point to the same repository and token, but they grant different authority: the tracker owns tasks/dependencies/comments; SCM owns branches/PRs/checks/merge.

### Linear + GitHub SCM

```yaml
trackers:
  - id: linear-work
    kind: linear
    workspace: ENG
    tokenEnv: LINEAR_API_KEY
repositories:
  - id: source
    kind: github
    owner: my-org
    repo: my-project
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN
```

`workspace` is the Linear team key used to list work. GitHub credentials remain required for the source lifecycle.

### Jira + GitHub SCM

```yaml
trackers:
  - id: jira-work
    kind: jira
    workspace: https://example.atlassian.net
    project: ENG
    tokenEnv: JIRA_TOKEN
```

The daemon also reads `JIRA_EMAIL`. Confirm the installation's workflow/status names match the adapter's default mapping before enabling merge automation.

## Harness profiles and roles

A workflow asks for a role such as `reviewer`; it never asks for `codex` or a model. A managed profile can declare `model`, `reasoning`, `instructions`, `skills`, `mcpServers`, and `plugins`; a role may override the same fields. Overrides on `managed: false` profiles are rejected because Dark Kitchen must not rewrite user-owned configuration.

The built-in default workflow calls these roles:

- `implementer`
- `reviewer`
- `fixer`
- `repository-tester`

`workflowWithVerification` additionally calls `verifier`. Define all roles explicitly even when several use the same profile. This keeps routing portable and makes later model separation a config-only change.

The daemon forwards profile kind, model, instructions, and an isolated per-session MCP selection to ACP. It selects bundled `deepseek-harness` only through a user-managed profile and refuses per-run skill/MCP injection there. Reasoning, skills, plugins, and other optional fields are capability-negotiated; unsupported requests fail before agent launch.

## Workflows

Every workflow defines exactly one implementation source:

- `builtin: default`, `builtin: design-frontend`, or `builtin: high-risk`; or
- `file`, resolved relative to the project root and constrained to `.dark-kitchen/workflows/`. The module must export a compatible workflow as its default export, `workflow`, or `defaultWorkflow`.

If no workflow is configured, the daemon uses the built-in default. `default: true` is the explicit fallback when selectors do not match; at most one workflow may be the default. With no explicit default, the first declaration is the compatibility fallback.

The `roles` and `verificationProfiles` arrays document and validate the workflow's dependencies; workflow code still decides which calls execute. See [workflows](workflows.md).

## Verification profiles

Task descriptions contain a portable `## Verification` section with profile IDs and observable scenarios. Config supplies the local method:

| Field                                                               | Meaning                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `verifierRoleId`                                                    | Independent semantic agent role.                                                                                          |
| `requiredCapabilities`                                              | Stable semantic IDs such as `browser.playwright`; a configured provider must declare each capability.                     |
| `skills`, `mcpServers`, `tools`                                     | Verifier resources, capability-negotiated against the selected harness.                                                   |
| `environmentSetup`, `environmentTeardown`, `environmentHealthcheck` | Trusted `{ executable, args, timeoutSeconds }` commands, executed with `shell: false`; tracker text is never substituted. |
| `timeoutSeconds`                                                    | Positive whole-number runtime bound.                                                                                      |
| `retryPolicy`                                                       | `maxAttempts >= 1` and non-negative `delaySeconds`.                                                                       |
| `evidencePolicy`                                                    | Screenshot/log flags and named report kinds.                                                                              |
| `blocking`                                                          | Defaults to `true`; a required blocking profile must pass before merge.                                                   |

Verification state and evidence references are durable control-plane metadata. The built-in daemon parses one requested profile, inspects semantic capabilities, executes setup and healthcheck commands before the verifier and teardown in `finally`, isolates selected MCP servers per ACP runtime, passes authorized tool references to the verifier, applies timeout/retry policy, persists a normalized verdict, and forwards structured proof to the PR gate when `blocking` is true. Unsupported skill/MCP injection fails before launch; user-managed DSH resources remain user-owned. Readable local evidence artifacts are recorded with a `sha256` content digest; unreadable or remote references remain un-attested, so required SCM checks stay mandatory independent proof.

## Capability providers

```yaml
capabilityProviders:
  - managed: true
    id: playwright
    capability: browser.playwright
    version: 1.62.1

  - managed: false
    id: repo-command
    capability: command.exec
    description: Uses an explicitly configured repository executable

  - managed: external
    id: company-device-farm
    capability: mobile.device-farm
    description: Authenticated outside Dark Kitchen
```

- `managed: true`: Dark Kitchen recognizes a trusted pinned provider. Installation requires plan + human approval and writes under `~/.dark-kitchen/tools` by default.
- `managed: false`: the repository provides it. Dark Kitchen validates availability but does not install it.
- `managed: external`: the user or organization owns installation/authentication. Dark Kitchen must not modify it.

Verification profiles and capability MCP calls both reference the stable semantic capability ID (`browser.playwright`), not the deployment-local provider ID (`playwright`). A configured provider must declare that semantic ID. Never substitute an arbitrary install command. The two-step lifecycle is documented in [MCP](mcp.md).

## Channels

The CLI daemon currently composes direct `telegram`, `discord`, `slack`, `imessage`, and `whatsapp` transports. `openclaw` and `webhook` are schema vocabulary for host adapters; they are not automatically composed by the stock daemon.

| Kind       | Credentials/prerequisite                                                   | Target                            |
| ---------- | -------------------------------------------------------------------------- | --------------------------------- |
| `telegram` | Bot token in `tokenEnv`; polling by default                                | Numeric private/group chat ID     |
| `discord`  | Explicit `discord.js@14.27.0` peer plus bot token in `tokenEnv`            | Channel ID                        |
| `slack`    | Explicit `@slack/bolt@3.22.0` peer, bot token, and Socket Mode `token2Env` | Channel/conversation ID           |
| `imessage` | macOS Messages access                                                      | Address understood by the adapter |
| `whatsapp` | Explicit `whatsapp-web.js@1.34.7` peer install, QR pairing, local Chromium | Self-chat JID or configured chat  |

`defaultTarget` is both the outbound destination and, for the direct daemon path, an inbound conversation allowlist. Keep it explicit. `allowedSenderIds` can further restrict group replies. Telegram additionally accepts `telegramMode: webhook`, public HTTPS `url`, `webhookPort`, `webhookPath`, and `webhookSecretEnv`; the secret value stays in the environment and the stock listener stays on loopback. See [interventions](interventions.md).

## Merge policy

- `strategy`: `squash`, `merge`, or `rebase`.
- `requiredChecks`: exact GitHub check names. A missing check fails closed.
- `requireApproval: true`: leave the PR in an awaiting-approval state. `false` permits autonomous merge after every other gate passes.
- `deleteHeadBranchAfterMerge`: remove the remote task branch only after merge is confirmed.

Repository branch protection remains the final SCM authority. Start with `requireApproval: true` while commissioning a project.

## Migrations, backup, and reload

Config version 0 (no `version` field) migrates to version 1 on read. Runtime SQLite migrations use the database's schema version and run when the store opens. Before upgrading:

1. Stop the daemon.
2. Copy `.dark-kitchen/config.yaml`, `.dark-kitchen/runtime/`, and `~/.dark-kitchen/` to a private backup.
3. Install the pinned release.
4. Run `dark-kitchen doctor`, then start in the foreground and inspect logs.

`ConfigStore` exposes gzip backup/restore for embedded hosts. Do not downgrade a migrated database/config unless that release explicitly documents backward compatibility.

## Environment variables

| Variable                             | Used for                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                       | Example GitHub Issues and GitHub SCM credential. The actual name comes from `tokenEnv`. |
| `LINEAR_API_KEY`                     | Example Linear credential.                                                              |
| `JIRA_TOKEN`, `JIRA_EMAIL`           | Jira API credential and account email.                                                  |
| `TELEGRAM_BOT_TOKEN`                 | Telegram bot token.                                                                     |
| `TELEGRAM_WEBHOOK_SECRET`            | Example Telegram webhook secret; actual name comes from `webhookSecretEnv`.             |
| `DISCORD_BOT_TOKEN`                  | Discord bot token.                                                                      |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Slack bot and Socket Mode tokens.                                                       |
| `DSH_EXECUTABLE`                     | Optional reviewed path/name for the user-managed DeepSeek Harness executable.           |
| `DK_DASHBOARD_PORT`                  | Dashboard/SSE port; default `18800`.                                                    |
| `DK_MCP_PORT`                        | daemon HTTP MCP port; default `18801`.                                                  |
| `DK_NO_DASHBOARD`                    | Any non-empty value disables the dashboard listener.                                    |
| `OPENCLAW_URL`                       | Optional `doctor` health probe for an externally managed OpenClaw gateway.              |

`.dark-kitchen/.env` is a convention only; the process manager or shell must load it. Keep it out of Git.
