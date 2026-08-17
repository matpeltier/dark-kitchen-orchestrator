# Dark Kitchen Orchestrator

Dark Kitchen is a standalone TypeScript control plane for autonomous software teams.

The repository is a small pnpm workspace with two initial boundaries:

- `packages/core` — framework-neutral domain and port contracts.
- `apps/api` — the future HTTP control-plane composition boundary.

Architecture decisions and invariants are documented in [docs/architecture.md](docs/architecture.md).

## Development

Requires Node.js >= 22.13 and the pinned pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm validate
```

The bootstrap intentionally does not implement tracker adapters, workflow execution, ACP/acpx,
notifications, or MCP tools.
