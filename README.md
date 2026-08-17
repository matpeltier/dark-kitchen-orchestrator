# Dark Kitchen Orchestrator

Dark Kitchen is a standalone TypeScript control plane for autonomous software teams.

The repository is a small pnpm workspace with these boundaries:

- `packages/core` — framework-neutral domain and port contracts.
- `packages/workflow-engine` — Dark Kitchen-owned, provider-neutral code-first workflow
  orchestration with semantic agent roles, nested workflows, retries, concurrency, cancellation,
  progress events, and journal replay.
- `apps/api` — the future HTTP control-plane composition boundary.

Architecture decisions and invariants are documented in [docs/architecture.md](docs/architecture.md).

## Development

Requires Node.js >= 22.13 and the pinned pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm validate
```

The workflow engine uses a caller-supplied `HarnessRunner` (or resolver), so the package has no
dependency on a model provider or agent SDK. ACP/acpx integration, tracker adapters,
notifications, and MCP tools remain outside this package.
