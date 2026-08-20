# Installation and operation

Dark Kitchen runs beside an existing Git repository. It needs write access to that checkout, its Git metadata, `.dark-kitchen/runtime`, and any Dark Kitchen-owned managed-tool directory.

## Prerequisites

### Core

| Requirement           | Supported                       | Why                                          |
| --------------------- | ------------------------------- | -------------------------------------------- |
| Node.js               | `>=22.13`                       | ESM and `node:sqlite` runtime                |
| Git                   | current supported release       | branches, worktrees, push, repository checks |
| Repository            | existing checkout with `origin` | one primary worktree per active task         |
| Tracker credential    | provider-specific               | task graph, state, comments, dependencies    |
| GitHub SCM credential | repository access               | branch push, PR/check/merge lifecycle        |

pnpm 10.14 is required only when building the monorepo from source.

### Harness

The npm distribution includes the compatible `acpx` runtime dependency (`0.13.x` for the current release line), but the selected ACP agent must be installed/available and authenticated. Codex and OpenCode adapter boundaries are covered by tests; run a live smoke with your exact agent/model before enabling autopilot.

DeepSeek Harness is optional and is not installed by the core package. The stock daemon selects it only for a user-managed `kind: deepseek-harness` profile; it rejects managed DSH profiles so existing credentials and configuration remain user-owned. A fresh rc.8 install currently needs the reviewed, isolated `@smithy/core` override documented in [harnesses](harnesses.md); do not present DSH as a zero-step prerequisite until the upstream dependency graph is fixed.

### Optional services

- Telegram bot credentials or macOS Messages access.
- Discord requires the explicit optional peer `discord.js@14.27.0` beside the CLI plus a bot credential.
- Slack requires the explicit optional peer `@slack/bolt@3.22.0` beside the CLI plus bot and Socket Mode app credentials.
- WhatsApp requires an explicit compatible peer install (`npm install --global whatsapp-web.js@1.34.7` beside a global CLI, or a project-local exact install beside a local CLI) plus QR pairing; it is intentionally absent from the core npm dependency set.
- A managed or project-provided verification capability only when a task requests that profile.
- OpenClaw only for hosts using the optional gateway adapter; the stock daemon uses direct channel transports.

## npm installation

```sh
npm install --global dark-kitchen
dark-kitchen --help
```

From the existing project root:

```sh
cd /srv/my-project
dark-kitchen init
dark-kitchen doctor
```

`init` is non-interactive and conservative: it creates `.dark-kitchen/config.yaml` if absent, leaves an existing config unchanged, and does not overwrite unrelated files. Edit the placeholders before starting. `dark-kitchen setup` is an interactive alternative and asks before replacing an existing config.

For a version-pinned, repository-local CLI:

```sh
DK_VERSION='replace-with-a-reviewed-release'
npm install --save-dev --save-exact "dark-kitchen@${DK_VERSION}"
npx dark-kitchen init
```

Replace the example version with the release you audited. Production service files should invoke the resolved binary path rather than rely on a mutable global install.

## Credentials

Config contains environment-variable names:

```yaml
trackers:
  - id: work
    kind: github-issues
    owner: my-org
    repo: my-project
    tokenEnv: GITHUB_TOKEN
```

The service environment contains values:

```sh
GITHUB_TOKEN=...
TELEGRAM_BOT_TOKEN=...
```

`.dark-kitchen/.env` is not loaded automatically by the daemon. Load it with your shell/process manager or use an OS secret store. Keep mode `0600`, ensure it is ignored by Git, and never copy credentials into issues, MCP requests, unit files, command-line arguments, or container image layers.

## Preflight and first run

```sh
dark-kitchen doctor
dark-kitchen start --foreground
```

`doctor` currently checks Node, Git, optional pnpm, repository/config presence, known tracker-token environment variables, acpx availability, `node:sqlite`, and an optional `OPENCLAW_URL` health endpoint. Warnings do not make the report unhealthy; errors do. Capability/provider health is available through the capability service/MCP and should be inspected separately before a task requests it.

Keep `mergePolicy.requireApproval: true` for commissioning. Create a disposable issue, run one task, answer one intervention, inspect its PR proof, and confirm tracker closure/worktree release before enabling autonomous merge.

## Storage layout

Default host paths:

```text
<project>/.dark-kitchen/config.yaml        project configuration
<project>/.dark-kitchen/runtime/store.db   runs/sessions/interventions
<project>/.dark-kitchen/runtime/*.db       durable workflow journals
<project>/.dark-kitchen/runtime/worktrees  task worktrees
<project>/.dark-kitchen/runtime/verification.json
<project>/.dark-kitchen/runtime/capabilities.json
~/.dark-kitchen/tools                      managed tool/runtime assets
```

Playwright stores its pinned package and browser assets below `~/.dark-kitchen/tools/playwright/<version>`. Maestro uses `~/.dark-kitchen/tools/maestro/<version>`. They do not add dependencies to the target repository. Deleting those directories is a real uninstall/cache reset; use the capability service so inventory and health remain auditable.

Back up config, runtime state, and managed-tool state together. Runtime databases may use SQLite WAL sidecars while the daemon is running; stop it or use a SQLite-aware snapshot before copying.

## Docker

Build from this repository:

```sh
docker build -t dark-kitchen:local .
```

Run against a host checkout:

```sh
docker run --rm --name dark-kitchen \
  --env-file /secure/dark-kitchen.env \
  -e DK_NO_DASHBOARD=1 \
  -v /srv/my-project:/workspace \
  -v dark-kitchen-runtime:/workspace/.dark-kitchen/runtime \
  -v dark-kitchen-tools:/home/node/.dark-kitchen \
  dark-kitchen:local start --foreground
```

The repository bind mount supplies project files and Git metadata. The `dark-kitchen-runtime` volume explicitly persists SQLite, workflow journals, and worktrees across container replacement; `dark-kitchen-tools` persists managed tools/caches and their versions. Replace either named volume with a reviewed host bind mount when your backup policy needs filesystem-visible state.

The runtime stage installs the exact locally packed npm artifact rather than copying the monorepo and its development dependencies. Discord, Slack, and WhatsApp peers remain absent from the base image. Build a reviewed derivative that installs only the exact peer needed beside `/opt/dark-kitchen-runtime/node_modules/dark-kitchen`; WhatsApp also needs the Chromium libraries required by its peer.

The stock HTTP MCP server binds to container loopback and is intended for in-process agents. Publishing port `18801` alone will not expose it. An embedding deployment must explicitly configure the authenticated non-loopback MCP boundary before placing a reverse proxy in front. The process runs in the foreground as PID 1 and handles SIGTERM for graceful SQLite/channel shutdown.

The example [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) uses the same mounts. Containerized coding agents may need extra host integration, credentials, or sockets; do not mount the Docker socket merely to make a harness work.

## systemd

Copy [`deploy/systemd/dark-kitchen.service`](../deploy/systemd/dark-kitchen.service), then replace:

- `User`/`Group` with the dedicated service account;
- every `/srv/my-project` occurrence with the managed checkout;
- `/etc/dark-kitchen/my-project.env` with a root-owned `0600` environment file;
- `/usr/local/bin/dark-kitchen` with the pinned binary path.

```sh
sudo install -m 0644 deploy/systemd/dark-kitchen.service /etc/systemd/system/dark-kitchen.service
sudo systemctl daemon-reload
sudo systemctl enable --now dark-kitchen.service
sudo systemctl status dark-kitchen.service
journalctl -u dark-kitchen.service -f
```

Run `dark-kitchen doctor` as the service user with the same environment before enabling the unit. The sample hardens the process while allowing writes only to the repository and Dark Kitchen state paths; expand those paths deliberately if a harness needs another location.

## launchd (macOS)

Copy [`deploy/launchd/io.dark-kitchen.daemon.plist`](../deploy/launchd/io.dark-kitchen.daemon.plist) to `~/Library/LaunchAgents/`, replacing `/Users/you/Projects/my-project` and the binary path. launchd does not expand shell variables and does not load your interactive shell profile.

Store secrets in an owner-only wrapper/credential mechanism rather than committing them to the plist. Then:

```sh
plutil -lint ~/Library/LaunchAgents/io.dark-kitchen.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.dark-kitchen.daemon.plist
launchctl kickstart -k gui/$(id -u)/io.dark-kitchen.daemon
tail -f /Users/you/Library/Logs/dark-kitchen.log
```

Unload before changing config or upgrading:

```sh
launchctl bootout gui/$(id -u)/io.dark-kitchen.daemon
```

WhatsApp peer installation/pairing and iMessage privacy permissions require an interactive macOS user session; they are not suitable for a headless system daemon without pre-provisioned access.

## From source

```sh
git clone https://github.com/matpeltier/dark-kitchen-orchestrator.git
cd dark-kitchen-orchestrator
corepack enable
pnpm install --frozen-lockfile
pnpm validate
node apps/cli/dist/cli.js --help
```

Run the built CLI from the **target project's** working directory, not the Dark Kitchen source checkout:

```sh
cd /srv/my-project
node /path/to/dark-kitchen-orchestrator/apps/cli/dist/cli.js init
```

## Upgrades and rollback

1. Read the release notes and confirm the Node/acpx/harness compatibility ranges.
2. Stop the daemon cleanly.
3. Back up config, all runtime SQLite files/WAL sidecars, verification/capability state, and `~/.dark-kitchen` managed tools.
4. Install an exact Dark Kitchen version or pull the signed container tag/digest.
5. Run `dark-kitchen doctor` from the project root.
6. Start in the foreground once; inspect config/runtime migrations and capability health.
7. Restart the service manager and watch one full scheduler poll.

Config version 0 → 1 migration and SQLite schema migrations are automatic on read/open. Managed assets are versioned in their directory paths, so installing a new pinned provider does not overwrite a project dependency. Do not roll back the binary against a newer database/config unless the release notes explicitly permit it; restore the matching backup instead.

## Release integrity

Stable `vMAJOR.MINOR.PATCH` tags are intended to run these gates before publication. On a safe rerun, an already published npm version is skipped only when its registry integrity exactly matches the tested tarball; an integrity mismatch fails the release:

- full monorepo validation;
- documentation link/image checks;
- `npm pack`, installation into a fresh temporary project, `--help`, non-destructive `init`, and `doctor`;
- a production-dependency audit of that clean tarball installation with high-severity findings treated as release failures;
- Docker build plus a foreground-daemon smoke with persistent runtime/tool volumes;
- npm publication from the exact tested tarball;
- GHCR image publication and generated GitHub release notes.

Do not publish directly from an unvalidated workspace. If the tarball contains `workspace:*` runtime dependencies, the clean install smoke must fail and publication must stop.
