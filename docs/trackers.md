# Trackers and SCM

Dark Kitchen has two separate provider boundaries:

- **Tracker:** projects, tasks, descriptions, comments, normalized status, and dependency edges.
- **SCM:** repositories, branches, commits, pull requests, checks, merge, and branch cleanup.

GitHub may provide both GitHub Issues and GitHub SCM, but the contracts and policy are still separate. Linear or Jira work can produce a GitHub PR without leaking provider-specific task semantics into the SCM lifecycle.

## PM authority rule

A ChatGPT/Cursor PM should use Dark Kitchen MCP for work-management mutations:

- create/update/close tasks;
- add/list/remove dependencies;
- add/read comments;
- mark autonomous approval/readiness;
- inspect and control the normalized runtime.

A separate GitHub connector can inspect repository files/history, commits, PR reviews, checks, and CI logs. It should not bypass Dark Kitchen by changing tracker state or dependency semantics. Dark Kitchen itself owns push, PR creation/reuse, configured gates, merge, task transition, and worktree cleanup.

## Normalized task states

Adapters map provider states into:

| State       | Scheduling meaning                                                     |
| ----------- | ---------------------------------------------------------------------- |
| `backlog`   | Not eligible.                                                          |
| `ready`     | Eligible when every blocker is completed and concurrency is available. |
| `active`    | In progress; not scheduled again.                                      |
| `blocked`   | Paused pending an intervention or prerequisite.                        |
| `completed` | Satisfies downstream dependency edges.                                 |
| `cancelled` | Terminal without completion.                                           |

Only `ready` tasks launch. An active task cannot be launched twice by the same supervisor. A dependency cycle fails validation rather than being silently scheduled.

## GitHub Issues tracker

```yaml
trackers:
  - id: gh-work
    kind: github-issues
    owner: my-org
    repo: my-project
    tokenEnv: GITHUB_TOKEN
```

Default status labels:

| GitHub issue                | Dark Kitchen |
| --------------------------- | ------------ |
| open, no `dk:*` state label | `backlog`    |
| `dk:ready`                  | `ready`      |
| `dk:active` or `dk:running` | `active`     |
| `dk:blocked`                | `blocked`    |
| closed                      | `completed`  |

When a human replies `retry` to a task intervention, the daemon removes the blocked scheduling state by updating the task to ready; the adapter replaces prior `dk:*` state labels with `dk:ready`. `stop` sets `dk:blocked`.

### Dependency edges

`dk_add_dependency(taskId, dependsOnTaskId)` validates the normalized graph before mutation. The GitHub adapter uses GitHub's native issue-dependency REST relationship (`blocked_by`) and fails if that API is unavailable; it does not rewrite the issue body with hidden dependency markers. PMs must use the MCP dependency tool rather than hand-writing `Depends on #…` prose; prose is not a scheduling edge.

The scheduler reloads task dependencies from provider state so a daemon restart does not intentionally discard blocker semantics. GitHub API availability/token scope can determine whether the native relationship or fallback is visible.

### End-to-end example

1. Through MCP, create `#41 Add OAuth callback` and `#42 Add account page` with explicit acceptance criteria.
2. Add an edge saying `#42` depends on `#41`.
3. Add `dk:ready` to both. Only `#41` is scheduled.
4. Dark Kitchen runs `#41` in its own worktree, opens/reuses one PR, enforces tests/review/verification/CI, and confirms merge.
5. It closes `#41`, releases its worktree, refreshes the graph, then `#42` becomes eligible.

## Linear tracker (experimental)

```yaml
trackers:
  - id: linear-work
    kind: linear
    workspace: ENG
    tokenEnv: LINEAR_API_KEY
repositories:
  - id: github-source
    kind: github
    owner: my-org
    repo: my-project
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN
```

The stock adapter uses the Linear GraphQL API and treats `workspace` as a team key. Default state mapping:

| Linear      | Dark Kitchen |
| ----------- | ------------ |
| Backlog     | `backlog`    |
| Todo        | `ready`      |
| In Progress | `active`     |
| In Review   | `blocked`    |
| Done        | `completed`  |
| Cancelled   | `cancelled`  |

The current adapter does not yet satisfy the required live CRUD/state/dependency round-trip: state-ID resolution and durable dependency behavior remain incomplete. Projects with different state names also need host-level mapping support. Keep automatic execution and merge disabled for Linear until a disposable workspace test passes.

### End-to-end example

1. The PM creates small Linear issues and native blocker relations through Dark Kitchen MCP.
2. Moving an issue to `Todo` makes it ready under the default mapping.
3. Dark Kitchen creates the primary worktree/branch and later the PR in the separately configured GitHub repository.
4. GitHub required checks and approval policy control merge.
5. After GitHub confirms merge, Dark Kitchen moves the Linear issue to `Done`.
6. If the final Linear transition fails, the lifecycle remains `tracker-close-failed`; it does not rerun implementation or create another PR.

## Jira tracker (experimental)

```yaml
trackers:
  - id: jira-work
    kind: jira
    workspace: https://example.atlassian.net
    project: ENG
    tokenEnv: JIRA_TOKEN
```

The Jira schema/composition and adapter do not yet satisfy the required live CRUD/transition/link round-trip; base URL, project key, transition mapping, and blocker-link semantics still need a complete configurable contract. Do not enable Jira autopilot from this revision.

## GitHub SCM

```yaml
repositories:
  - id: source
    kind: github
    owner: my-org
    repo: my-project
    defaultBranch: main
    tokenEnv: GITHUB_TOKEN
```

After a workflow reports a valid result, Dark Kitchen:

1. verifies the result has a non-empty summary, passed repository tests and independent review;
2. enforces clean/no-code and configured verification proof constraints;
3. pushes the task branch without putting the token in argv or a remote URL;
4. creates or reuses one PR for the branch;
5. records the task marker, summary, tests/review, warnings, and evidence references in PR context;
6. waits for every exact `requiredChecks` name;
7. stops at `awaiting-approval` or merges by the configured strategy;
8. asks GitHub to confirm merged state;
9. only then transitions the tracker and releases the worktree/branch.

The lifecycle is deliberately resumable at partial failure points. A check failure cannot merge. A merged PR plus failed tracker transition does not start agents again. A no-code outcome still needs tests, independent review, and any required verification before the tracker closes.

## Token scopes and branch protection

Use the smallest provider permissions that support the configured operations. For GitHub this typically means issue read/write for the tracker plus repository content/PR/check access for SCM; exact fine-grained permissions depend on repository policy. Required checks and branch protection remain authoritative even if `requireApproval` is false.

Use separate environment variables/tokens when tracker and SCM ownership differ. Never put credentials in task descriptions, YAML values, Git URLs, PR bodies, or channel replies.

## Readiness checklist

- Confirm normalized ready/active/blocked/completed states against the real provider workflow.
- Create/list/remove one dependency and restart the daemon to test persistence.
- Verify a dependency cycle is rejected.
- Run one no-code task and one code task.
- Confirm PR reuse after a transient restart/failure.
- Force a required-check failure and verify no merge occurs.
- Force a post-merge tracker failure and verify no agent/PR duplication occurs.
- Keep manual merge approval until all checks pass in the target repository.
