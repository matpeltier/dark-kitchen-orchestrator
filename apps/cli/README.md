# dark-kitchen

The npm CLI for [Dark Kitchen](https://github.com/matpeltier/dark-kitchen-orchestrator), a self-hosted control plane that turns tracker tasks into isolated agent workflows, verified GitHub pull requests, and durable human interventions.

Dark Kitchen is pre-1.0. Pin a reviewed version, keep GitHub required checks/approval enabled during commissioning, and run a live smoke with your exact tracker, harness, model, and messaging credentials before unattended use.

## Requirements

- Node.js 22.13 or later and Git.
- An existing Git repository with an `origin` remote.
- Tracker and GitHub SCM credentials in environment variables.
- An installed/authenticated ACP agent such as Codex or OpenCode. The compatible acpx runtime is included.

## Quick start

From the existing project root:

```sh
npm install --save-dev --save-exact dark-kitchen@0.1.1
npx dark-kitchen init
```

Edit `.dark-kitchen/config.yaml`, then:

```sh
export GITHUB_TOKEN='...'
npx dark-kitchen doctor
npx dark-kitchen start --foreground
```

`init` creates the config only when it is absent and does not replace unrelated files. The built-in workflow maps semantic roles (`implementer`, `reviewer`, `fixer`, `repository-tester`, optional `verifier`) to your selected harness profiles and keeps one primary Git worktree per active task.

Human messaging is optional. Telegram is included and iMessage uses the macOS host. Discord, Slack, and WhatsApp are opt-in peers: install `discord.js@14.27.0`, `@slack/bolt@3.22.0`, or `whatsapp-web.js@1.34.7` beside this package only when enabling that channel. WhatsApp additionally needs QR pairing. DeepSeek Harness is user-managed and currently has an upstream rc.8 dependency-resolution caveat documented in the repository.

## Security and operations

- Put token environment-variable names in YAML, never token values.
- Keep the daemon MCP endpoint on loopback unless an authenticated/allowlisted HTTPS boundary is configured.
- Treat project workflow files, harness plugins, and injected MCP servers as executable authority.
- Keep branch protection and exact required check names enabled.
- Back up `.dark-kitchen/runtime` and managed tool state before upgrades.

Full documentation:

- [README and architecture](https://github.com/matpeltier/dark-kitchen-orchestrator#readme)
- [Installation and service operation](https://github.com/matpeltier/dark-kitchen-orchestrator/blob/main/docs/installation.md)
- [Configuration](https://github.com/matpeltier/dark-kitchen-orchestrator/blob/main/docs/configuration.md)
- [Harnesses](https://github.com/matpeltier/dark-kitchen-orchestrator/blob/main/docs/harnesses.md)
- [Interventions and Telegram/WhatsApp edge cases](https://github.com/matpeltier/dark-kitchen-orchestrator/blob/main/docs/interventions.md)
- [Security policy](https://github.com/matpeltier/dark-kitchen-orchestrator/blob/main/SECURITY.md)
