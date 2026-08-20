# Dynamic workflows, review, and proof

Dark Kitchen workflows are TypeScript/JavaScript functions built from semantic agent calls. They know roles, prompts, data dependencies, and bounded control flow; they do not know provider enums, model APIs, tracker vendors, channel transports, or GitHub details.

This separation is what lets the same workflow run through Codex, OpenCode, a native/custom harness, or a mixed role matrix—provided the host has composed runtimes with the declared capabilities.

## Engine primitives

| Primitive                                               | Purpose                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `builder.agent({ role, prompt, context, retryPolicy })` | Resolve one explicit semantic role and run it.                         |
| `builder.phase(name)`                                   | Create a named child scope for stable identities/progress.             |
| `builder.parallel(factories, { concurrency })`          | Run branches concurrently while returning results in input order.      |
| `builder.pipeline(initial, steps)`                      | Pass a value through ordered steps.                                    |
| `builder.workflow(name, fn, options)`                   | Invoke a nested workflow with its own stable scope and optional retry. |

Every `agent()` call requires a non-empty `role`; there is no provider/label fallback. Role resolution may be asynchronous so custom plugins can load lazily.

## Determinism and recovery

The engine derives call identities from the logical workflow path: run, phase/nested invocation, parallel branch position or pipeline step, semantic role, and repeated-call index. It creates parallel child identities before asynchronous work starts, so completion order does not change journal keys.

Before a call, the engine asks the `JournalStore` for its result. Completed calls replay without invoking the harness again. SQLite journals persist per run in `.dark-kitchen/runtime`; an explicit retry with the task's deterministic run ID can recover completed steps. A fully completed task removes its journal so intentionally reopened work starts fresh. Startup reconciliation, in-flight call metadata, workflow/config drift detection, and ACP checkpoint restoration are not implemented yet.

Cancellation races the entire workflow body—including waits outside engine primitives—and prevents a resolver that completes after cancellation from launching a delayed child agent. Parallel concurrency and retries are bounded.

## Built-in default workflow

The default path is:

```text
implementer
  -> reviewer
      -> fixer -> reviewer (up to two fix cycles)
  -> repository-tester
  -> workflow result
```

Reviewer and repository-tester roles must return JSON verdicts:

```json
{ "passed": true }
```

or:

```json
{ "passed": false, "findings": "Concise actionable failures" }
```

Malformed output fails closed. The workflow can extract a JSON object from a plain result, whole JSON string, fenced block, or the first balanced object, but prompts request JSON-only output for audit clarity.

The `repository-tester` role is instructed to execute tests/typecheck/lint and return a verdict. That verdict is agent-produced; it is **not itself cryptographic or machine-independent proof**. Configure real GitHub `requiredChecks` so CI independently executes repository validation before merge.

## Custom workflow

Set a project-relative path:

```yaml
workflows:
  - id: default
    file: .dark-kitchen/workflows/default.ts
    default: true
    roles: [implementer, reviewer, fixer, repository-tester]
```

The module can export `default`, `workflow`, or `defaultWorkflow`. TypeScript is loaded through `jiti`; JavaScript uses native ESM. The resolved path must stay within `.dark-kitchen/workflows/`. A configured module that is missing, cannot load, or exports the wrong shape fails closed and creates the normal task failure/intervention path; it is never silently replaced with another workflow.

Minimal `.dark-kitchen/workflows/default.ts`:

```ts
export default async function workflow(builder: any) {
  const implementation = await builder.phase('implementation').agent({
    role: 'implementer',
    prompt: 'Implement every acceptance criterion and run focused tests.',
  });

  const [review, tests] = await builder.parallel(
    [
      (branch: any) =>
        branch.agent({
          role: 'reviewer',
          prompt: 'Review the worktree independently. Return JSON {"passed":boolean}.',
          context: { implementation: implementation.result },
        }),
      (branch: any) =>
        branch.agent({
          role: 'repository-tester',
          prompt: 'Run repository validation. Return JSON {"passed":boolean}.',
        }),
    ],
    { concurrency: 2 },
  );

  const reviewVerdict = JSON.parse(String(review.result));
  const testVerdict = JSON.parse(String(tests.result));
  return {
    summary: String(implementation.result),
    reviewPassed: reviewVerdict.passed === true,
    repositoryTestsPassed: testVerdict.passed === true,
  };
}
```

Workflow files are trusted executable project code. Review them like build scripts and keep the resolved path inside the repository.

## Deterministic workflow selection

Each entry defines exactly one of `file` or `builtin`. Selectors are evaluated for every normalized task:

```yaml
workflows:
  - id: high-risk
    builtin: high-risk
    priority: 100
    roles: [architect, implementer, security-reviewer, fixer, reviewer, repository-tester, verifier]
    verificationProfiles: [web-e2e]
    taskSelector:
      labelsAny: [security, migration]

  - id: design-frontend
    builtin: design-frontend
    priority: 50
    roles: [designer, implementer, reviewer, fixer, repository-tester, verifier]
    verificationProfiles: [web-e2e]
    taskSelector:
      labelsAny: [frontend, design]

  - id: routine
    builtin: default
    default: true
    roles: [implementer, reviewer, fixer, repository-tester, verifier]
    verificationProfiles: [web-e2e]
```

Available selector groups are `taskIds`, `statuses`, `labelsAny`, `labelsAll`, `titleIncludes`, `descriptionIncludes`, and `verificationProfilesAny`. Every configured group must match (logical AND); an `*Any`/text group needs one matching value, while `labelsAll` needs every label. Labels and text fragments are Unicode-normalized and case-insensitive. The highest `priority` wins, with declaration order as the stable tie-breaker. When nothing matches, the single `default: true` entry wins; without one, the first declaration is the compatibility fallback.

GitHub, Linear, Jira, and test/mock adapters preserve normalized labels/tags into selection and SQLite recovery state. A restart therefore does not change the selected workflow merely because provider ordering or casing changed.

## Built-in specialized workflows

- `builtin: default`: implementer → reviewer/fixer loop → optional verifier/fixer loop → repository-tester.
- `builtin: design-frontend`: designer brief → implementer → reviewer/fixer → optional verifier/fixer → repository-tester.
- `builtin: high-risk`: architect plan → durable human approval gate → implementer → security-reviewer/fixer → reviewer/fixer → optional verifier/fixer → repository-tester.

The high-risk gate uses a stable ID and a durable intervention. Pending approval stops before repository mutation. Resolve it, then retry the same task/run so the journal replays the plan and observes the recorded decision. Workers and verifiers are explicitly told not to change the roadmap or launch other tracker tasks.

## Harness-independent routing

```yaml
harnessProfiles:
  - managed: true
    id: codex-impl
    kind: codex
    model: gpt-5.6-codex
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

No workflow change is needed to swap these mappings. The stock daemon composes ACP kinds and its bundled, user-managed `deepseek-harness` kind. Any other custom/native role is equally valid at the engine layer, but an embedding host must load and allowlist its executable plugin; declaring an arbitrary kind in YAML alone does not authorize code loading.

## Task-level verification requirements

A task asks for observable proof with a portable section:

```markdown
## Verification

Profile: web-e2e
Evidence: screenshot, trace

### Scenario: Checkout succeeds

Expect: The confirmation page shows the order ID and no failed network request is present.

### Scenario: Declined card

Expect: The form remains usable and shows the provider error without creating an order.
```

The reusable parser supports multiple `Profile:` lines, an optional comma-separated `Evidence:` line, and scenario headings. The stock daemon currently accepts exactly one requested profile per task and fails closed on more than one. Machine paths, install commands, credentials, or MCP tool calls do not belong in the task.

Project config supplies the implementation:

```yaml
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
```

The durable verification service normalizes runs as `pending`, `running`, `passed`, `failed`, `blocked`, or `cancelled`; records criterion results and artifact references; reuses pending/running/passed requests idempotently; bounds explicit service retries by the profile; and computes the blocking gate from the latest runs.

Large screenshots/traces/logs live in artifact storage and appear in state/PR context as references. A passing run cannot contain a non-pass criterion.

For a task requesting one configured profile, the stock daemon:

1. inspects each referenced capability and fails before agent launch unless it is available;
2. selects `workflowWithVerification` and routes `verifier` to `verifierRoleId`;
3. passes the parsed requirement, profile, and capability state as verifier context;
4. normalizes the verifier's JSON verdict and evidence references into durable verification state; and
5. passes the required structured proof to the PR lifecycle, which refuses a blocking pass without at least one safe evidence reference.

The stock executor enforces `blocking`, runs trusted structured environment commands with `shell: false`, tears the environment down in `finally`, applies `timeoutSeconds`, and derives verifier/fixer attempts and delays from `retryPolicy`. ACP MCP sets are isolated per session; unsupported skill/MCP requests and injection into user-managed DSH fail before launch. `tools` remain semantic authorized references for the verifier rather than arbitrary commands. Evidence references are syntax/redaction checked, but the referenced artifact is not fetched or cryptographically attested by the PR gate. Required SCM checks remain the strongest independent proof.

## Bounded fix → reverify

`workflowWithVerification` demonstrates:

```text
implement -> review/fix
  -> verifier
      -> fixer -> verifier (bounded)
  -> repository-test
  -> verdict
```

The verifier should use an independent role/profile. A built-in workflow expects one JSON verdict with `passed`, `summary`, and `evidenceRefs`, then runs repository validation after any verifier fixes. `retryPolicy.maxAttempts` bounds its verifier attempts and explicit durable-service retries; neither path retries forever. A failed workflow pauses the task and creates an intervention.

## PR readiness contract

The lifecycle accepts a structured result containing:

- a non-empty, redacted summary;
- `repositoryTestsPassed`;
- `reviewPassed` from an independent role;
- at least one non-empty task commit, or an explicit valid no-code outcome;
- clean-worktree status;
- warnings;
- required verification profile verdicts and durable evidence references.

It refuses PR readiness/merge when a required value is missing or failed. A no-code outcome still needs tests, review, and verification. PR creation is idempotent by source branch, body size is bounded, required checks fail closed, and tracker/worktree cleanup occurs only after merged state is confirmed.

The current CLI executor automatically commits remaining changes, collects commit SHAs, and supplies structured verification proof for its built-in verification path. The configured GitHub checks provide the strongest independent test proof. Commissioning must still exercise the exact profile and evidence path; an absent, failed, blocked, unsafe, or evidence-free required proof blocks the PR lifecycle.

## Proof in the PR

The normalized PR context can include:

```markdown
## Dark Kitchen verification

- Repository tests: passed (agent verdict; CI check `ci` required separately)
- Independent review: passed
- Profile `web-e2e`: passed
- Evidence:
  - artifact://runs/vrun-123/checkout.png
  - artifact://runs/vrun-123/trace.zip
```

Do not commit large or sensitive artifacts merely to make them visible. Artifact references must be durable and access-controlled. Redaction applies to PR titles/bodies, but secrets should never enter agent verdicts or evidence metadata.

## Failure/recovery expectations

| Failure point                        | Recovery invariant                                           |
| ------------------------------------ | ------------------------------------------------------------ |
| Explicit retry after a failed run    | Replay completed call keys; reuse task worktree.             |
| Daemon crash during workflow         | Not yet automatically reconciled; keep autopilot disabled.   |
| Agent/auth/quota failure             | Create a typed intervention; do not discard work/journal.    |
| Review/verification failure          | Bounded fixer loop, then intervention.                       |
| Git push/PR API failure              | Intervention/manual retry; full step reconciliation pending. |
| Required check failure               | Never merge.                                                 |
| Merge confirmed, tracker close fails | State is reported, but automatic startup resume is pending.  |
| Worktree release fails               | Preserve explicit cleanup failure after tracker/merge state. |

## Test strategy

Deterministic CI uses fake role resolvers and provider boundaries to cover:

- stable call keys across async completion order and repeated child workflows;
- parallel limits, retry, journal replay, null/undefined results, and cancellation races;
- Codex, OpenCode, and mixed native routing matrices at the workflow contract;
- bounded reviewer/fixer and verifier/fixer loops;
- PR/check/merge/tracker recovery with fake SCM/tracker adapters;
- durable verification retry/gate/evidence state.

Live LLM, provider credential, browser/device, Telegram, and GitHub checks are separate commissioning smokes. Never infer their health solely from fake tests.
