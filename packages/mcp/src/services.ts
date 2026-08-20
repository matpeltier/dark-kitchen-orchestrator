/**
 * Service boundaries consumed by the MCP adapter.
 *
 * These interfaces deliberately contain no provider or installer logic. The
 * daemon injects implementations; MCP only validates input and delegates.
 */

export interface TrackerGraphResult {
  readonly projectId: string;
  readonly tasks: readonly unknown[];
  readonly dependencies: readonly unknown[];
}

export interface TrackerControlService {
  getGraph(projectId: string): Promise<TrackerGraphResult>;
  listComments(taskId: string): Promise<readonly unknown[]>;
  setAutonomousApproval(taskId: string, approved: boolean): Promise<unknown>;
}

export type ConfigEntitySection =
  | 'trackers'
  | 'repositories'
  | 'workflows'
  | 'roles'
  | 'harnessProfiles'
  | 'verificationProfiles'
  | 'capabilityProviders'
  | 'channels';

export interface RuntimeControlService {
  listAgents(runId?: string): Promise<readonly unknown[]>;
  getAgent(sessionId: string): Promise<unknown | undefined>;
  restartAgent(sessionId: string): Promise<unknown>;
  retryAgent(sessionId: string): Promise<unknown>;
  switchAgentProfile(sessionId: string, harnessProfileId: string): Promise<unknown>;
  pauseRun(runId: string): Promise<unknown>;
  resumeRun(runId: string): Promise<unknown>;
  retryRun(runId: string): Promise<unknown>;
}

export interface InterventionResolutionControlService {
  apply(input: {
    readonly scope: 'task' | 'run' | 'agent';
    readonly targetId: string;
    readonly kind: string;
    readonly details?: string;
    readonly action: 'retry' | 'switch-harness' | 'approve' | 'stop' | 'free-text';
    readonly answer?: string;
  }): Promise<void>;
}

export interface VerificationControlService {
  inspectTaskRequirements(taskId: string): Promise<unknown>;
  listRuns(taskId?: string): Promise<readonly unknown[]>;
  getRun(runId: string): Promise<unknown | undefined>;
  getEvidence(runId: string, criterionName?: string): Promise<readonly unknown[]>;
  request(input: { readonly taskId: string; readonly profileId?: string }): Promise<unknown>;
  retry(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
}

export interface CapabilityControlService {
  listCatalog(): Promise<unknown>;
  inspect(input: { readonly capabilityId: string; readonly nodeId?: string }): Promise<unknown>;
  planProvisioning(input: {
    readonly capabilityId: string;
    readonly nodeId?: string;
  }): Promise<unknown>;
  ensureManaged(input: { readonly planId: string; readonly approvalId: string }): Promise<unknown>;
  validate(input: { readonly capabilityId: string; readonly nodeId?: string }): Promise<unknown>;
}
