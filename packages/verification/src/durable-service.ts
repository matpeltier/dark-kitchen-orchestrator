import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskId } from '@dark-kitchen/core';
import { createTaskId } from '@dark-kitchen/core';
import type { VerificationProfile } from '@dark-kitchen/config';
import type {
  VerificationEvidence,
  VerificationRequirement,
  VerificationRun,
  VerificationRunState,
  VerificationScenario,
} from './domain.js';

export interface DurableVerificationServiceOptions {
  readonly statePath: string;
  readonly profiles?: readonly VerificationProfile[];
  readonly getTaskDescription?: (taskId: TaskId) => Promise<string | undefined>;
}

export interface VerificationGateResult {
  readonly passed: boolean;
  readonly blockingProfiles: readonly string[];
  readonly failedProfiles: readonly string[];
  readonly evidenceRefs: readonly string[];
}

interface VerificationStateFile {
  readonly version: 1;
  readonly runs: readonly VerificationRun[];
}

/**
 * Durable verification control-plane service.
 *
 * Provider execution remains outside this boundary. Verifiers record their
 * normalized criterion verdicts and artifact references here, while MCP and
 * the PR lifecycle consume the same durable state.
 */
export class DurableVerificationService {
  private readonly statePath: string;
  private readonly profiles: readonly VerificationProfile[];
  private readonly getTaskDescription:
    | ((taskId: TaskId) => Promise<string | undefined>)
    | undefined;
  private readonly runs = new Map<string, VerificationRun>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: DurableVerificationServiceOptions) {
    this.statePath = options.statePath;
    this.profiles = options.profiles ?? [];
    this.getTaskDescription = options.getTaskDescription;
  }

  public async inspectTaskRequirements(taskId: string): Promise<{
    readonly taskId: string;
    readonly requirements: readonly VerificationRequirement[];
    readonly profiles: readonly VerificationProfile[];
  }> {
    const id = createTaskId(taskId);
    const body = (await this.getTaskDescription?.(id)) ?? '';
    const requirements = parseVerificationRequirements(body);
    const requestedIds = new Set(requirements.map((requirement) => requirement.profileId));
    return {
      taskId,
      requirements,
      profiles: this.profiles.filter((profile) => requestedIds.has(profile.id)),
    };
  }

  public async listRuns(taskId?: string): Promise<readonly VerificationRun[]> {
    await this.load();
    const all = [...this.runs.values()].sort(compareRuns);
    return taskId ? all.filter((run) => run.taskId === taskId) : all;
  }

  public async getRun(runId: string): Promise<VerificationRun | undefined> {
    await this.load();
    return this.runs.get(runId);
  }

  public async getEvidence(
    runId: string,
    criterionName?: string,
  ): Promise<readonly VerificationEvidence[]> {
    const run = await this.getRun(runId);
    if (!run) return [];
    return run.criterionResults
      .filter((criterion) => !criterionName || criterion.criterionName === criterionName)
      .flatMap((criterion) => criterion.evidence ?? []);
  }

  public async request(input: {
    readonly taskId: string;
    readonly profileId?: string;
  }): Promise<VerificationRun> {
    await this.load();
    const taskId = createTaskId(input.taskId);
    const inspected = await this.inspectTaskRequirements(input.taskId);
    const profileId = input.profileId ?? inspected.requirements[0]?.profileId;
    if (!profileId) {
      throw new Error(`Task ${input.taskId} has no verification profile requirement.`);
    }
    this.requireProfile(profileId);

    // Network retries and daemon restarts must not create duplicate work. A
    // completed passing run is also reusable until an explicit retry is asked.
    const existing = [...this.runs.values()]
      .filter((run) => run.taskId === taskId && run.profileId === profileId)
      .sort(compareRuns)
      .at(-1);
    if (existing && ['pending', 'running', 'passed'].includes(existing.state)) return existing;

    const run = createRun(taskId, profileId, 1);
    this.runs.set(run.id, run);
    await this.save();
    return run;
  }

  public async retry(runId: string): Promise<VerificationRun> {
    await this.load();
    const prior = this.requireRun(runId);
    if (!['failed', 'blocked', 'cancelled'].includes(prior.state)) {
      throw new Error(`Verification run ${runId} cannot be retried from ${prior.state}.`);
    }
    const profile = this.requireProfile(prior.profileId);
    const maxAttempts = profile.retryPolicy?.maxAttempts ?? 1;
    if (prior.attempt >= maxAttempts) {
      throw new Error(
        `Verification ${prior.profileId} exhausted its bounded ${String(maxAttempts)} attempts.`,
      );
    }
    const next = createRun(prior.taskId, prior.profileId, prior.attempt + 1);
    this.runs.set(next.id, next);
    await this.save();
    return next;
  }

  public async cancel(runId: string): Promise<VerificationRun> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Verification run ${runId} not found.`);
    if (isTerminal(run.state)) return run;
    return this.update(runId, {
      state: 'cancelled',
      completedAt: new Date().toISOString(),
    });
  }

  public async markRunning(runId: string): Promise<VerificationRun> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Verification run ${runId} not found.`);
    if (run.state === 'running') return run;
    if (run.state !== 'pending') {
      throw new Error(`Verification run ${runId} cannot start from ${run.state}.`);
    }
    return this.update(runId, { state: 'running' });
  }

  public async complete(
    runId: string,
    input: Pick<VerificationRun, 'state' | 'criterionResults'> & { readonly errorMessage?: string },
  ): Promise<VerificationRun> {
    if (!['passed', 'failed', 'blocked'].includes(input.state)) {
      throw new Error(`Verification cannot complete with state ${input.state}.`);
    }
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Verification run ${runId} not found.`);
    if (isTerminal(run.state)) return run;
    if (
      input.state === 'passed' &&
      input.criterionResults.some((result) => result.status !== 'pass')
    ) {
      throw new Error('A passing verification run cannot contain non-passing criteria.');
    }
    return this.update(runId, {
      state: input.state,
      criterionResults: input.criterionResults,
      completedAt: new Date().toISOString(),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
  }

  public async gate(taskId: string): Promise<VerificationGateResult> {
    const inspected = await this.inspectTaskRequirements(taskId);
    const required = inspected.requirements
      .map((requirement) => this.profiles.find((profile) => profile.id === requirement.profileId))
      .filter((profile): profile is VerificationProfile => profile?.blocking !== false);
    const runs = await this.listRuns(taskId);
    const failedProfiles: string[] = [];
    const evidenceRefs: string[] = [];
    for (const profile of required) {
      const latest = runs.filter((run) => run.profileId === profile.id).at(-1);
      if (!latest || latest.state !== 'passed') {
        failedProfiles.push(profile.id);
        continue;
      }
      evidenceRefs.push(
        ...latest.criterionResults.flatMap((criterion) =>
          (criterion.evidence ?? []).map((evidence) => evidence.artifactRef),
        ),
      );
    }
    return {
      passed: failedProfiles.length === 0,
      blockingProfiles: required.map((profile) => profile.id),
      failedProfiles,
      evidenceRefs,
    };
  }

  private async update(
    runId: string,
    patch: Partial<
      Pick<VerificationRun, 'state' | 'criterionResults' | 'completedAt' | 'errorMessage'>
    >,
  ): Promise<VerificationRun> {
    await this.load();
    const run = this.requireRun(runId);
    const updated = { ...run, ...patch };
    this.runs.set(runId, updated);
    await this.save();
    return updated;
  }

  private requireProfile(profileId: string): VerificationProfile {
    const profile = this.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Verification profile ${profileId} is not configured.`);
    return profile;
  }

  private requireRun(runId: string): VerificationRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Verification run ${runId} not found.`);
    return run;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(await readFile(this.statePath, 'utf8')) as VerificationStateFile;
      for (const run of stored.runs) this.runs.set(run.id, run);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      const state: VerificationStateFile = { version: 1, runs: [...this.runs.values()] };
      await writeFile(temporary, JSON.stringify(state, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.statePath);
    });
    await this.writeQueue;
  }
}

/**
 * Portable tracker-body convention:
 *
 * ## Verification
 * Profile: web-e2e
 * Evidence: screenshot, trace
 * ### Scenario: User signs in
 * Expect: The dashboard is visible and no console error is emitted.
 */
export function parseVerificationRequirements(body: string): readonly VerificationRequirement[] {
  const header = /^##\s+Verification\s*\r?$/imu.exec(body);
  if (!header) return [];
  const remainder = body.slice(header.index + header[0].length).replace(/^\r?\n/u, '');
  const nextSection = remainder.search(/^##\s+/mu);
  const section = nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
  const profileMatches = [...section.matchAll(/^Profile:\s*([^\n]+)$/gimu)];
  if (profileMatches.length === 0) return [];
  const requestedEvidence = section
    .match(/^Evidence:\s*([^\n]+)$/imu)?.[1]
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const scenarios = parseScenarios(section);
  return profileMatches.map((match) => ({
    profileId: match[1]!.trim(),
    scenarios,
    ...(requestedEvidence?.length ? { requestedEvidence } : {}),
  }));
}

function parseScenarios(section: string): readonly VerificationScenario[] {
  const headings = [...section.matchAll(/^###\s+Scenario:\s*([^\n]+)$/gimu)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? section.length;
    const block = section.slice(start, end).trim();
    const expected = block.match(/^Expect(?:ed)?:\s*([^\n]+)$/imu)?.[1]?.trim();
    return {
      name: heading[1]!.trim(),
      description: block,
      expectedOutcome: expected ?? block,
    };
  });
}

function createRun(taskId: TaskId, profileId: string, attempt: number): VerificationRun {
  return {
    id: `vrun-${randomUUID()}`,
    taskId,
    profileId,
    state: 'pending',
    criterionResults: [],
    startedAt: new Date().toISOString(),
    attempt,
  };
}

function isTerminal(state: VerificationRunState): boolean {
  return ['passed', 'failed', 'blocked', 'cancelled'].includes(state);
}

function compareRuns(left: VerificationRun, right: VerificationRun): number {
  const time = left.startedAt.localeCompare(right.startedAt);
  return time !== 0 ? time : left.id.localeCompare(right.id);
}
