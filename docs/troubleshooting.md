# Troubleshooting

Start from the project root and keep the daemon in the foreground while diagnosing:

```sh
dark-kitchen doctor
dark-kitchen start --foreground
```

Use `--json` for structured daemon logs. Common secret patterns are redacted, but do not paste credentials into task bodies, prompts, replies, or diagnostic commands.

## `doctor` reports Node or SQLite errors

Dark Kitchen requires Node 22.13 or later. Confirm the service manager/container is using the same binary as your shell:

```sh
command -v node
node --version
node -e "import('node:sqlite').then(() => console.log('sqlite ok'))"
```

An nvm/fnm installation visible to an interactive shell is often absent from systemd/launchd. Use an absolute binary path in the service definition.

## Config missing or invalid

Run from the managed Git repository root. `dark-kitchen init` creates the template only if absent.

Typical validation failures:

- duplicate IDs across a config entity family;
- a role references an unknown harness profile;
- a workflow references an unknown role or verification profile;
- a workflow defines both/neither `file` and `builtin`, more than one default exists, or a selector is empty;
- an intervention policy references an unknown channel;
- a verification profile references an unknown capability provider;
- a literal credential was put in YAML instead of an environment-variable name;
- a numeric chat ID was not quoted and YAML changed its type.

Use `dark-kitchen config get` to inspect the exact file the CLI sees. Config version 0 migrates to version 1 on read; future unknown versions should not be forced manually.

## Daemon says it is already running

Runtime state lives under `.dark-kitchen/runtime`. First inspect:

```sh
dark-kitchen status
ps -p "$(node -e "const f=require('fs');const s=JSON.parse(f.readFileSync('.dark-kitchen/runtime/daemon.state.json'));process.stdout.write(String(s.pid))")"
```

Use `dark-kitchen stop` for a live process. Remove a lock/state file only after proving its PID is gone and no service manager is restarting it. Never delete the runtime directory to solve an ordinary lock problem; it contains durable state and journals.

## Dashboard or MCP port is busy

Defaults are `18800` (dashboard/SSE) and `18801` (HTTP MCP):

```sh
DK_DASHBOARD_PORT=28800 DK_MCP_PORT=28801 dark-kitchen start --foreground
```

Set `DK_NO_DASHBOARD=1` for a headless daemon. The HTTP MCP listener still starts. Keep it on loopback; remote exposure requires the authentication/host/origin policy described in [MCP](mcp.md).

## No tasks start

Check in this order:

1. The daemon has a configured tracker and SCM; without both it can expose control services but does not run the autonomous PR loop.
2. The tracker token is present in the daemon's environment, not only your shell.
3. The task normalizes to `ready` (`dk:ready` for GitHub Issues, commonly `Todo` for Linear).
4. Every blocker edge points to a `completed` task.
5. The task is not manually paused or already active/completed in supervisor state.
6. `maxParallelTasks` has capacity.
7. The daemon completed a polling tick (30 seconds by default).

A cycle in dependencies fails scheduling. Fix it through the MCP dependency tools instead of editing prose markers.

## The wrong workflow is selected

Selection is deterministic. Inspect the normalized task ID, status, labels, title/description, and `## Verification` profile, then compare every configured selector group:

- groups are combined with AND, not OR;
- `labelsAny`/text/verification groups need one match, while `labelsAll` needs all values;
- a larger `priority` wins; declaration order breaks a tie;
- if nothing matches, `default: true` wins, otherwise the first entry is the compatibility fallback.

Tracker labels are preserved and matched case-insensitively after Unicode normalization. A selected custom `file` that cannot load fails the task and creates an intervention; it does not fall back to a different workflow. Fix the trusted module/export and retry the same task so the existing worktree/journal remain authoritative.

## Worktree creation/reuse fails

Inspect Git directly without deleting anything:

```sh
git status --short
git worktree list --porcelain
git branch --list 'dk/*'
git remote -v
```

Common causes are a manually deleted worktree directory, externally modified Git metadata, an existing conflicting branch, permissions on `.dark-kitchen/runtime/worktrees`, or a repository without a usable `HEAD`. Retries are supposed to reuse the same primary worktree; do not allocate a second one by hand.

Worktree release is intentionally refused while its state is active. Preserve the directory for evidence/recovery until merge and tracker transition are confirmed.

## acpx cannot load or an agent is unavailable

The current release line expects the pinned `acpx` 0.13.x runtime API. Check the package/CLI visible to the actual service user:

```sh
acpx --version
dark-kitchen doctor
```

Then test the selected agent (`codex`, `opencode`, or another ACP registry name) with its own authentication and a trivial prompt. Distinguish:

- `compatibility`: installed acpx/protocol does not match the adapter;
- `auth`: authenticate out-of-band;
- `quota`/`rate-limit`: restore capacity or use an audited profile switch;
- `tool`/`process`: inspect bounded stderr and executable availability;
- `stuck`: cancel/intervene rather than launching duplicates.

The daemon injects its local MCP endpoint into ACP sessions. If agent startup fails only when MCP is present, confirm `http://127.0.0.1:18801/mcp` is reachable from that execution environment and no duplicate/malformed profile URL is configured.

## DeepSeek Harness fails

The optional DSH adapter accepts only `@deepseek-ai/dsh` developer previews listed by `DSH_SUPPORTED_VERSIONS` (currently rc.7/rc.8). Run:

```sh
dsh --version
```

A clean rc.8 dependency resolution currently fails because upstream requests unpublished `@smithy/core@^3.33.3`. The temporary tested workaround is an isolated pnpm installation with an exact `pnpm.overrides` entry for `@smithy/core: 3.33.2`; see [harnesses](harnesses.md). Point `DSH_EXECUTABLE` at that reviewed local binary and remove the override once upstream resolves the range. Do not silently override dependencies in an unrelated application repository.

The adapter uses an existing headless profile and does not configure `$DSH_HOME`, credentials, model, plugins, skills, or MCP servers. Missing auth/config must be fixed in the user-owned DSH setup. Configure a `managed: false`, `kind: deepseek-harness` profile; managed DSH profiles fail closed. DSH does not receive automatic per-run MCP injection, so its existing profile must already expose any required Dark Kitchen MCP access. A version probe is not an authenticated prompt test.

## Repository tester says passed but CI fails

The repository-tester is a semantic agent role and returns a JSON verdict. That output is not a substitute for independent CI. Keep the exact check names in `mergePolicy.requiredChecks`; a missing or failed check must block merge.

Inspect the PR check suite through GitHub. Fix the underlying repository or workflow; do not remove a required check merely to make the lifecycle green.

## PR is not created

The workflow result must have:

- non-empty summary;
- passed repository-test and independent-review verdicts;
- at least one non-empty commit, or a valid explicit no-code outcome;
- no unintended uncommitted changes when clean-state is supplied;
- every required blocking verification proof.

Also check branch push, token permission, remote name, PR body size, and whether an existing PR for the source branch is closed without merge. Dark Kitchen reuses an open/merged PR; it should not create duplicates.

## PR waits forever or never merges

- `requireApproval: true` intentionally leaves `awaiting-approval`.
- `requiredChecks` values must exactly match GitHub check names.
- A queued/in-progress/missing check is not passed.
- Branch protection may require additional approval/status beyond Dark Kitchen config.
- A requested profile must produce a passed structured proof with at least one safe evidence reference; otherwise the stock lifecycle fails closed.

Do not disable branch protection to troubleshoot. Start with a disposable branch and inspect provider state.

## Merge succeeded but tracker task remains open

This is the recoverable `tracker-close-failed` state. Correct tracker credentials/status mapping/API availability and retry the lifecycle transition. Do not rerun agents, force-push, or create another PR—the merged PR is already the source of truth.

## Telegram does not send

Check:

- `tokenEnv` names an environment variable actually present in the daemon;
- `defaultTarget` is the exact chat ID and quoted in YAML;
- the user/group initiated a bot conversation and permits bot messages;
- only one process is polling the bot token;
- foreground logs show `telegram` connected rather than skipped/failed.

Arbitrary intervention text is sent as plain text, so Markdown syntax should not cause rejection. Oversized messages are visibly truncated.

## Telegram sends but replies do not resolve

Reply to the exact bot message or include its `DK-…` code. With two pending questions in one conversation, a plain unquoted response is intentionally ambiguous and ignored. Confirm the reply comes from `defaultTarget` and, when configured, an ID in `allowedSenderIds`.

Provider update IDs, outbound correlations, and inactive/resolved state are persisted. A second reply or a provider replay after daemon restart is ignored. If an upgrade predates durable correlation records, or the original provider message no longer exists, resolve the intervention explicitly through MCP.

## Telegram webhook is rejected

Stock YAML webhook mode requires:

- an HTTPS public URL;
- a non-empty Telegram-compatible secret;
- exact webhook path;
- `X-Telegram-Bot-Api-Secret-Token` match;
- body at most 1 MiB;
- local listener port availability.

Set `telegramMode: webhook`, the public HTTPS `url`, `webhookPort`, `webhookPath`, and an environment-variable name in `webhookSecretEnv`. Keep the listener on loopback behind a TLS proxy. Invalid method/path/secret deliberately returns 404; malformed JSON returns 400; oversized input returns 413. Because the stock listener binds container loopback, ordinary Docker port publishing is insufficient without a same-network-namespace proxy.

## WhatsApp is stuck at QR or misses self replies

- Confirm the compatible optional peer is installed where the daemon can resolve it: `whatsapp-web.js@1.34.7`.
- Pair from the foreground terminal and preserve the local auth directory.
- Ensure Chromium can start in that user/container environment.
- Do not run multiple clients against the same auth state.
- `defaultTarget` should be the self-chat JID when self messaging.
- Leave the daemon running long enough for the polling interval.

The adapter deduplicates event and polling delivery, ignores history from before connection, and suppresses recent outbound echoes. A real new reply with identical text inside the echo window can be suppressed; use distinct text while commissioning.

## Discord or Slack does not connect

The public CLI keeps provider SDKs optional. Install the exact peer beside the CLI used by the daemon:

```sh
npm install --global discord.js@14.27.0       # Discord on a global CLI node
npm install --global @slack/bolt@3.22.0       # Slack on a global CLI node
```

For a project-local CLI, install the same exact package locally instead. Then verify `tokenEnv` for Discord, both `tokenEnv` and `token2Env` for Slack Socket Mode, the destination `defaultTarget`, bot/app permissions, and that the service user resolves the same dependency tree as your shell. One failed adapter does not stop another provider, but zero successful adapters means messaging startup fails.

## Managed capability is missing

Inspect the catalog/state through MCP. State meanings:

- `available`: health probe passed;
- `provisionable`: a trusted managed provider can create a plan;
- `missing`: project/external prerequisite absent or no provider;
- `unhealthy`: installed but the real health probe failed;
- `requires_auth`: external authentication is needed;
- `unsupported`: platform/node cannot host it.

Managed installation is not `dk capabilities ensure <id>` as a blind command. Use MCP to plan, read filesystem/network/process changes, resolve the generated approval intervention, then ensure the exact `planId` + `approvalId`, and validate health.

## Playwright is installed but unhealthy

The provider checks a real headless Chromium launch, not just a package directory. Check filesystem permissions and host libraries, then inspect `~/.dark-kitchen/tools/playwright/1.62.1/browsers`. Re-planning/re-ensuring is idempotent; do not add Playwright to the target project unless the project itself owns that dependency.

## Maestro is installed but missing

Maestro's binary can be installed while the capability still reports missing because no compatible booted Android/iOS device exists. Start/provision the device separately. The provider intentionally does not install Android Studio, Xcode, simulators, emulators, or OS images.

## Verification never runs or does not block merge

Confirm all five layers:

1. task body contains an exact `## Verification` section and known `Profile:`;
2. config defines that profile and its required capability;
3. every referenced capability reports `available` before the workflow starts;
4. the verifier role returns valid JSON with a pass and at least one safe, durable evidence reference;
5. the PR lifecycle receives the required profile ID and structured proof.

The stock daemon automatically selects the built-in verification workflow for one requested profile, executes its trusted structured environment lifecycle, capability-negotiates verifier resources, records the normalized result, and forwards it to the PR lifecycle. It does not verify that an artifact reference resolves to untampered content. Keep required CI/approval enabled, inspect the verifier harness resources, and treat the first commissioning run as evidence of integration—not the deterministic unit suite alone.

## npm installation fails with `workspace:*`

This indicates a bad published tarball containing monorepo-only runtime dependencies. Do not work around it with pnpm in the consumer. The release pipeline must bundle internal packages or rewrite the publish manifest, then install the exact `npm pack` tarball in an empty npm project before publishing.

## Container exits immediately

```sh
docker logs dark-kitchen
docker inspect dark-kitchen --format '{{.State.ExitCode}}'
```

Mount the actual Git checkout at `/workspace`, make it writable, preserve `.dark-kitchen/runtime`, and ensure service credentials are provided at runtime. `DK_NO_DASHBOARD=1` avoids a dashboard port conflict. Harness executables/auth inside the container are separate prerequisites; a healthy control-plane process does not imply the coding agent is installed.

## Safe diagnostic bundle

Collect only non-secret state:

```sh
node --version
git --version
acpx --version
dark-kitchen doctor
git status --short
git worktree list --porcelain
```

Before sharing logs or config, remove environment values, URLs containing query credentials, chat/user identifiers, repository-private task text, and artifact contents. Preserve original SQLite/journal files privately for recovery instead of modifying them during diagnosis.
