/**
 * Verification domain concepts (Issue 33).
 *
 * VerificationRequirement: what must be proven (task-level, portable)
 * VerificationProfile: how this installation can prove it (config-level)
 * VerificationRun: an execution of a profile against a task
 * VerificationCriterionResult: per-criterion verdict with evidence
 * VerificationEvidence: artifacts, screenshots, logs, etc.
 */

import type { TaskId } from '@dark-kitchen/core';

// ─── Default profile vocabulary ──────────────────────────────────────────────

/** Built-in profile names. Projects can override or add custom profiles. */
export type DefaultVerificationProfileId = 'web-e2e' | 'mobile-e2e' | 'api-e2e' | 'command-e2e';

/** Default capability provider mappings for built-in profiles. */
export const DEFAULT_PROFILE_PROVIDERS: Readonly<Record<DefaultVerificationProfileId, string>> = {
  'web-e2e': 'browser.playwright',
  'mobile-e2e': 'mobile.maestro',
  'api-e2e': 'api.http',
  'command-e2e': 'command.exec',
};

// ─── Verification requirement (task-body convention) ─────────────────────────

export interface VerificationScenario {
  readonly name: string;
  readonly description: string;
  readonly expectedOutcome: string;
}

export interface VerificationRequirement {
  readonly profileId: string;
  readonly scenarios: readonly VerificationScenario[];
  readonly requestedEvidence?: readonly string[];
  readonly notes?: string;
}

// ─── Verification run and results ─────────────────────────────────────────────

export type VerificationRunState =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type EvidenceKind =
  | 'screenshot'
  | 'trace'
  | 'log'
  | 'console-output'
  | 'network-log'
  | 'command-output'
  | 'http-response'
  | 'recording'
  | 'artifact';

export interface VerificationEvidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly name: string;
  /** Reference to artifact storage (not the actual binary). */
  readonly artifactRef: string;
  readonly capturedAt: string;
  /** Content digest (`sha256:<hex>`) when the artifact was readable at capture time. */
  readonly sha256?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VerificationCriterionResult {
  readonly criterionName: string;
  readonly status: 'pass' | 'fail' | 'blocked' | 'skipped';
  readonly message?: string;
  readonly evidence?: readonly VerificationEvidence[];
}

export interface VerificationRun {
  readonly id: string;
  readonly taskId: TaskId;
  readonly profileId: string;
  readonly state: VerificationRunState;
  readonly criterionResults: readonly VerificationCriterionResult[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly attempt: number;
  readonly errorMessage?: string;
}

// ─── Capability providers (Issue 34) ─────────────────────────────────────────

export type CapabilityProviderKind = 'managed' | 'project-provided' | 'user-managed';

export type CapabilityProviderState =
  | 'healthy'
  | 'degraded'
  | 'failing'
  | 'not-installed'
  | 'provisionable'
  | 'unknown';

export interface CapabilityProviderDescriptor {
  readonly id: string;
  readonly capability: string;
  readonly kind: CapabilityProviderKind;
  readonly version?: string;
  readonly state: CapabilityProviderState;
  readonly notes?: string;
}

/** First-party managed capability providers. */
export const FIRST_PARTY_PROVIDERS: readonly CapabilityProviderDescriptor[] = [
  {
    id: 'playwright',
    capability: 'browser.playwright',
    kind: 'managed',
    state: 'not-installed',
    notes:
      'Chromium-based browser E2E with screenshots/traces. Use dk capabilities ensure playwright.',
  },
  {
    id: 'maestro',
    capability: 'mobile.maestro',
    kind: 'managed',
    state: 'not-installed',
    notes: 'Black-box Android/iOS UI testing. Requires an available emulator/simulator/device.',
  },
  {
    id: 'api-http',
    capability: 'api.http',
    kind: 'managed',
    state: 'not-installed',
    notes: 'Lightweight HTTP/API E2E runner.',
  },
  {
    id: 'command-exec',
    capability: 'command.exec',
    kind: 'project-provided',
    state: 'unknown',
    notes: 'Runs a project-configured command. No install needed; configure in config.yaml.',
  },
];

// ─── Verification service ────────────────────────────────────────────────────

export class VerificationService {
  private readonly runs = new Map<string, VerificationRun>();
  private runSeq = 0;

  public createRun(taskId: TaskId, profileId: string): VerificationRun {
    const id = `vrun-${String(++this.runSeq).padStart(10, '0')}-${Date.now()}`;
    const run: VerificationRun = {
      id,
      taskId,
      profileId,
      state: 'pending',
      criterionResults: [],
      startedAt: new Date().toISOString(),
      attempt: 1,
    };
    this.runs.set(id, run);
    return run;
  }

  public updateRun(
    runId: string,
    patch: Partial<
      Pick<VerificationRun, 'state' | 'criterionResults' | 'completedAt' | 'errorMessage'>
    >,
  ): VerificationRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Verification run ${runId} not found`);
    const updated: VerificationRun = { ...run, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }

  public getRun(runId: string): VerificationRun | undefined {
    return this.runs.get(runId);
  }

  public listRuns(taskId?: TaskId): readonly VerificationRun[] {
    const all = [...this.runs.values()];
    return taskId ? all.filter((r) => r.taskId === taskId) : all;
  }

  public isBlockingVerificationPassed(
    taskId: TaskId,
    requiredProfileIds: readonly string[],
  ): boolean {
    for (const profileId of requiredProfileIds) {
      const runs = this.listRuns(taskId).filter((r) => r.profileId === profileId);
      // Sort by startedAt descending, then by id descending (id includes timestamp)
      const sorted = [...runs].sort((a, b) => {
        const timeDiff = b.startedAt.localeCompare(a.startedAt);
        return timeDiff !== 0 ? timeDiff : b.id.localeCompare(a.id);
      });
      const latest = sorted[0];
      if (!latest || latest.state !== 'passed') return false;
    }
    return true;
  }
}
