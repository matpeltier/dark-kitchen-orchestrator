# Contributing to Dark Kitchen

Thank you for considering a contribution to Dark Kitchen!

## Development Setup

```sh
# Requires Node.js >= 22.13 and pnpm >= 10.14
git clone https://github.com/matpeltier/dark-kitchen-orchestrator.git
cd dark-kitchen-orchestrator
pnpm install --frozen-lockfile
pnpm validate   # lint + format + typecheck + test + build
```

## Running Tests

```sh
pnpm test               # all tests
pnpm test packages/core # specific package
```

## Adding a Package

1. Create `packages/<name>/package.json` and `tsconfig.json` following existing patterns
2. Add `{ "path": "./packages/<name>" }` to the root `tsconfig.json` references
3. Add tests in `packages/<name>/src/<name>.test.ts`
4. Run `pnpm validate`

## Adding a Tracker Adapter

Implement `FullTrackerAdapter` from `@dark-kitchen/tracker/src/contracts.ts`. See the `MockTrackerAdapter` for the full contract.

## Adding a Harness Adapter

1. Implement `HarnessRuntime` from `@dark-kitchen/harness`
2. Register via `registerHarnessPlugin` if it should be loadable by kind string
3. See `@dark-kitchen/harness-deepseek` for an example

## Code Style

- TypeScript strict mode with `exactOptionalPropertyTypes`
- No inline secrets in config/tests
- No `shell: true` in process spawning
- Payload data travels through stdin/IPC/file, never through argv
- Tests must not require live LLM calls or real browser credentials for default CI

## Pull Request Process

1. Branch from `main`: `git checkout -b feat/my-feature`
2. `pnpm validate` must pass
3. Include tests for new behavior
4. Reference any related GitHub Issues in the PR body using `dk:task-id:` (not `Closes #N`)

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
