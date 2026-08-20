# Harnesses

Dark Kitchen separates workflow meaning from agent execution. A workflow calls a semantic role (`implementer`, `reviewer`, `fixer`, `repository-tester`, `verifier`); the role router selects a `HarnessProfile`, validates the required capabilities, and returns an opaque `HarnessRuntime`.

Changing a model or harness therefore does not change workflow code, tracker behavior, Git isolation, messaging, or PR policy.

## Runtime contract

Every runtime declares a `kind`, an ID, and a capability set, then implements:

- start, inspect, cancel, resume, and stop session operations;
- optional live follow-up prompts;
- lifecycle event subscriptions;
- durable external-session metadata where the provider supports it.

Unsupported operations fail through capability negotiation. Dark Kitchen must not simulate resume, profile switching, MCP injection, or model selection when a runtime cannot provide them.

## ACP/acpx

ACP through `acpx` is the primary daemon integration. The workspace package pins `acpx` to the compatible `0.13.x` range and consumes its programmatic `acpx/runtime` API. The adapter:

- creates persistent ACP sessions keyed to Dark Kitchen runs;
- sends prompts through the programmatic payload field rather than argv;
- streams events and output into normalized session states;
- supports cancellation, resume, live instructions, model selection, and MCP server injection;
- classifies auth, quota, rate-limit, tool, timeout/stuck, compatibility, and process failures for interventions;
- stores ACP state under `<project>/.dark-kitchen/runtime/acpx-sessions` in the stock daemon.

Compatibility boundaries for the `codex` and `opencode` agent names are covered by automated tests. A test proves adapter compatibility, not local authentication: run the selected harness's own login/doctor command and a small live prompt before unattended use.

Example:

```yaml
harnessProfiles:
  - managed: true
    id: codex-impl
    kind: codex
    model: gpt-5.6-codex
    instructions: Implement the complete acceptance criteria and run tests.

  - managed: true
    id: opencode-review
    kind: opencode
    model: anthropic/claude-sonnet-4-5

roles:
  - id: implementer
    harnessProfileId: codex-impl
  - id: reviewer
    harnessProfileId: opencode-review
  - id: fixer
    harnessProfileId: codex-impl
  - id: repository-tester
    harnessProfileId: codex-impl
```

Agent/model identifiers are forwarded to acpx; availability depends on the installed ACP agents and their credentials.

### MCP injection

The daemon starts a local HTTP Dark Kitchen MCP server and injects it into ACP sessions. This lets a coding agent call `dk_ask_human` instead of waiting in a terminal. Profile `mcpServers` add other HTTP endpoints:

```yaml
harnessProfiles:
  - managed: true
    id: codex-with-tools
    kind: codex
    mcpServers:
      - http://127.0.0.1:9000/mcp
```

Treat every injected MCP server as code/data authority granted to the agent. Prefer loopback, authenticated endpoints, and the smallest required tool set.

## Managed versus user-managed profiles

```yaml
harnessProfiles:
  - managed: true
    id: managed-codex
    kind: codex
    model: gpt-5.6-codex

  - managed: false
    id: my-existing-agent
    kind: company-harness
    description: Configured and authenticated by the user
```

Dark Kitchen may apply declared model/instruction/resource overrides only to `managed: true` profiles. `managed: false` means discovery/use only: profile files, plugins, skills, MCP servers, authentication, and home directories remain user-owned. A role with overrides referencing a user-managed profile fails validation instead of silently rewriting it.

The stock daemon composes ACP profiles and the bundled `deepseek-harness` adapter described below. Other native/custom kinds require an embedding host to load an allowlisted plugin and register its runtime before routing them.

## Native process adapter

`NativeHarnessAdapter` is a shell-free, one-shot adapter for trusted executables. It keeps:

- executable path and bounded control arguments in the process definition;
- arbitrary prompts in stdin;
- `shell: false` for every invocation;
- bounded stdout/stderr as result data;
- cancellation through `AbortSignal`.

It does not claim persistent sessions, resume, live prompts, model selection, or profile mutation. Those operations fail unless a different native plugin explicitly implements the capability.

Never construct a native executable or argument list from tracker text. Only trusted installation configuration may define the process; issue bodies remain payload data.

## DeepSeek Harness (DSH)

`@dark-kitchen/harness-deepseek` is the bundled native adapter for the official `@deepseek-ai/dsh` developer preview. DSH itself is not installed by Dark Kitchen. At the time of this release, a clean rc.8 install is blocked upstream because it requests unpublished `@smithy/core@^3.33.3` (the registry currently provides 3.33.2). If you accept that temporary upstream compatibility override, keep it in an isolated user-managed directory:

```json
{
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.8"
  },
  "pnpm": {
    "overrides": {
      "@smithy/core": "3.33.2"
    }
  }
}
```

```sh
pnpm install
./node_modules/.bin/dsh --version
export DSH_EXECUTABLE=/absolute/path/to/that/node_modules/.bin/dsh
```

Commit/review the isolated lockfile and remove the override when DeepSeek publishes a consistent dependency graph. This probe establishes install/version compatibility only; run authentication and a disposable live prompt yourself before unattended work.

Current compatibility:

- package/executable: `@deepseek-ai/dsh` / `dsh`;
- supported versions: `0.1.0-rc.7` and `0.1.0-rc.8`;
- existing profile: `headless` by default;
- capabilities: one-shot execution and active-process cancellation;
- unsupported: resume, live follow-ups, per-run model/reasoning/skill/plugin/MCP overrides.

DSH's headless profile accepts a job through argv. Dark Kitchen instead creates a disposable payload file and transient patch overlay that reads `DARK_KITCHEN_PAYLOAD_FILE`, launches with `shell: false`, then removes both. It does not edit `$DSH_HOME`, profiles, `cordis.patch.yml`, plugins, skills, MCP settings, credentials, or model configuration.

Programmatic host example:

```ts
import { DshHarnessAdapter } from '@dark-kitchen/harness-deepseek';

const runtime = new DshHarnessAdapter({
  id: 'dsh-native',
  profile: 'headless',
  // dshHome: '/existing/user-owned/dsh/home',
});

const health = await runtime.probe();
if (!health.available) throw health.error;
```

The stock daemon selects this adapter only for `managed: false` profiles with `kind: deepseek-harness`:

```yaml
harnessProfiles:
  - managed: false
    id: dsh-existing
    kind: deepseek-harness
    description: Existing authenticated DSH headless profile

roles:
  - id: implementer
    harnessProfileId: dsh-existing
```

`managed: true` is rejected because the daemon will not own or rewrite DSH configuration. Set `DSH_EXECUTABLE` when the service should invoke the reviewed isolated binary above or another allowlisted path. The adapter does not inject the Dark Kitchen MCP server or per-run overrides into DSH; if a DSH agent must call `dk_ask_human`, configure that MCP endpoint in the existing user-owned DSH profile and commission it explicitly.

## Custom plugins

Harness plugins execute with the Dark Kitchen process's OS permissions. Load only explicit package names from trusted sources. The plugin loader:

- rejects package specifiers outside the configured allowlist;
- validates the exported shape and expected kind;
- does not edit the plugin package or its user configuration;
- keeps payload transport behind the normalized runtime contract.

Do not confuse declaring `plugins` in a profile with authorizing Node.js to import arbitrary packages. The host still owns the plugin allowlist and loader call.

## Role-specific configuration

A role may override a managed profile:

```yaml
roles:
  - id: reviewer
    harnessProfileId: codex-main
    overrides:
      model: gpt-5.6-codex
      instructions: Review independently. Do not edit files. Return an auditable verdict.
```

Model selection, instructions, and isolated per-session MCP selection are forwarded by the ACP daemon path. Optional reasoning, skills, plugins, and other overrides remain capability-negotiated: the runtime must explicitly declare and implement them or startup fails closed. The current ACP adapter does not claim `skills.custom`.

## Failure handling

The runtime classifies operational failures so the control plane can choose the right intervention:

| Failure        | Expected response                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- |
| Authentication | Ask the human to authenticate the existing harness; never request a token in issue text.  |
| Quota/billing  | Pause and surface the affected provider/profile.                                          |
| Rate limit     | Apply bounded retry/backoff, then intervene.                                              |
| Compatibility  | Report installed and supported versions; do not guess protocol flags.                     |
| Tool/process   | Preserve bounded diagnostics and keep the task worktree/journal for recovery.             |
| Stuck/timeout  | Cancel the active turn if supported; retry/restart only through audited runtime controls. |

## Commissioning checklist

Before unattended runs:

1. Confirm the exact acpx/DSH compatibility range installed by the release.
2. Run the harness's own authentication check outside Dark Kitchen.
3. Run `dark-kitchen doctor`.
4. Execute a trivial live task in a disposable repository for each configured kind/model.
5. Exercise cancel and human-intervention reply behavior.
6. Verify no prompt or token appears in process arguments, logs, or Git remote URLs.
7. Keep merge approval enabled until the full role matrix has completed successfully.
