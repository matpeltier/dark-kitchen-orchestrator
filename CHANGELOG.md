# Changelog

Notable user-visible changes to Dark Kitchen are documented here. Tagged GitHub releases also use the repository comparison to generate complete release notes.

## 0.3.0 - 2026-08-22

### Added

- Harness fallback chains: roles accept `fallbacks` (alternative harness profiles) and managed profiles accept `fallbackModels` (alternative models). On a quota-classified error the runtime transparently switches to the next candidate and restarts the pending turn there; exhaustion of every candidate raises the quota failure as before.
- Structured failure classification: harness errors carry their nature (`quota`, `auth`, `rate-limit`) through the workflow engine into intervention kinds — no more keyword parsing of summaries.
- Automatic promotion of dependents: backlog tasks whose dependencies are all completed are promoted to `ready` (with `dk:ready` tracker sync) during each scheduling tick. Disable with `scheduler.autoPromoteDependents: false`.
- PR lifecycle re-evaluation: after a checks failure or merge refusal, the lifecycle re-polls a bounded number of times so externally fixed branches merge without an intervention resolution.
- Automatic base-branch merge: on a merge conflict refusal, the task worktree merges the base branch and pushes when trivial; unresolvable conflicts raise a dedicated `merge-conflict` intervention kind.

### Fixed

- Parallel cold starts no longer race on npm's shared npx cache (spawns of the same binary are serialized until warm).
- Channel interventions are coalesced: repeated incidents of the same kind on the same target no longer pile up duplicate open records, while keyed replays stay idempotent and never resurrect terminal records.
- `dk_cancel_intervention` accepts an optional `resolvedBy` for audit parity with resolve.
- `dk init` adds `.dark-kitchen/runtime/` to `.gitignore` so runtime state and worktrees are never committed by accident.

## 0.2.0 - 2026-08-21

### Added

- Startup crash recovery: the daemon reconciles persisted runs, resuming `running`/`interrupted` runs through durable journal replay and re-seeding human-gated `waiting`/`blocked` runs as paused.
- Persistent harness sessions (ACP/acpx) are reattached to the in-flight workflow turn after a daemon restart via restart-safe session checkpoints recorded in the durable journal; retries never replay a restored prompt twice and stale checkpoints are purged on definitive failure or cancellation.
- Free-form channel chat: inbound messages that do not resolve a pending intervention are forwarded to the active PM agent session (with channel authorization and secret redaction), and the origin channel always receives an acknowledgement.
- Per-action resolution acknowledgements are sent back to the origin channel after an intervention is resolved from it.
- Open or acknowledged interventions are re-emitted to all configured channels at daemon startup so a restart does not silently drop pending requests.
- Telegram long polling reconnects automatically with bounded exponential backoff after a transport failure.
- Reused pull requests now get their body refreshed with fresh verification proofs, including `sha256` evidence attestations visible on GitHub.

### Changed

- Graceful shutdown marks in-flight runs `interrupted` so the next start resumes them instead of silently re-scheduling.
- The SSE dashboard now reports a clean "port already in use" error instead of crashing with an unhandled `EADDRINUSE`.
- Readable local verification evidence is recorded with a `sha256` content digest; commit discovery no longer fails on a fresh repository with no commits.
- Codex quota/usage-limit errors are classified as `quota` instead of `generic`.
- Removed the unused `DurableVerificationService.gate()` dead code (the effective merge gate is `validateVerificationProofs`).

## 0.1.1 - 2026-08-20

### Added

- Dynamic semantic-role workflows with durable replay, bounded retry/concurrency, and cancellation.
- Deterministic per-task workflow selection by normalized tracker fields, with explicit default/design/high-risk built-ins and resumable approval gates.
- ACP/acpx harness routing, stock user-managed DeepSeek Harness selection, and optional native/custom adapter contracts.
- Durable runtime, intervention, verification, capability, MCP, PR lifecycle, and direct messaging boundaries.
- SQLite-backed channel correlation/replay protection across daemon restarts and configurable Telegram sender/webhook controls.
- npm tarball and container smoke gates, Docker runtime image, and long-running systemd/launchd examples.
- Public architecture image, configuration/operation guides, security notes, and provider-specific commissioning checklists.
- Explicit opt-in WhatsApp peer installation so the core npm package does not install a browser runtime on every node.
- Explicit opt-in Discord and Slack peers so provider SDKs are installed only on nodes that enable those channels.

### Changed

- Process launches keep trusted executable/control metadata separate from arbitrary stdin/IPC/file payloads.
- Git worktrees and PR lifecycle now preserve explicit recovery states instead of treating workflow completion as sufficient for merge/cleanup.

### Known limitations

- Arbitrary native/custom harness plugins still require explicit host loading and an allowlist.
- Fresh DeepSeek Harness rc.8 resolution currently requires an isolated `@smithy/core` 3.33.2 override until its upstream dependency range is published consistently.
- Verification environment commands and per-session MCP selection are operational. Readable local evidence artifacts are now recorded with a `sha256` digest; unreadable or remote references remain un-attested, so independent required SCM checks stay essential.

## 0.1.0

Initial pre-1.0 npm release of the Dark Kitchen control-plane prototype.
