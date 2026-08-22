import {
  DomainValidationError,
  canTransitionAgentSession,
  canTransitionRun,
  isTerminalRuntimeState,
} from './domain.js';
import type {
  AgentSessionId,
  AgentSessionState,
  CheckId,
  CheckStatus,
  ConfigurationId,
  EventId,
  Intervention,
  InterventionId,
  InterventionStatus,
  PullRequest,
  PullRequestId,
  PullRequestStatus,
  RunId,
  RunState,
  TaskId,
  TaskStatus,
  WorkflowRunId,
} from './domain.js';

export interface TypedDomainEvent<Type extends string, Payload> {
  readonly id: EventId;
  readonly type: Type;
  readonly occurredAt: string;
  readonly payload: Payload;
}

export type TaskReadyEvent = TypedDomainEvent<
  'task.ready',
  { readonly taskId: TaskId; readonly previousStatus?: TaskStatus }
>;

export type TaskStatusChangedEvent = TypedDomainEvent<
  'task.status-changed',
  { readonly taskId: TaskId; readonly status: TaskStatus; readonly previousStatus: TaskStatus }
>;

export type RunCreatedEvent = TypedDomainEvent<
  'run.created',
  { readonly runId: RunId; readonly taskId: TaskId; readonly workflowRunId?: WorkflowRunId }
>;

export type RunStateChangedEvent = TypedDomainEvent<
  'run.state-changed',
  { readonly runId: RunId; readonly state: RunState; readonly previousState: RunState }
>;

export type RunCompletedEvent = TypedDomainEvent<
  'run.completed',
  { readonly runId: RunId; readonly state: Extract<RunState, 'completed' | 'failed' | 'stopped'> }
>;

export type AgentSessionStartedEvent = TypedDomainEvent<
  'agent.started',
  { readonly agentSessionId: AgentSessionId; readonly taskId: TaskId; readonly runId: RunId }
>;

export type AgentSessionStateChangedEvent = TypedDomainEvent<
  'agent.state-changed',
  {
    readonly agentSessionId: AgentSessionId;
    readonly state: AgentSessionState;
    readonly previousState: AgentSessionState;
  }
>;

export type AgentSessionCompletedEvent = TypedDomainEvent<
  'agent.completed',
  {
    readonly agentSessionId: AgentSessionId;
    readonly state: Extract<AgentSessionState, 'completed' | 'failed' | 'stopped'>;
  }
>;

/** Immutable audit record for a manual agent/run control operation. */
export type AgentControlEvent = TypedDomainEvent<
  'agent.control',
  {
    readonly requestId: string;
    readonly action:
      | 'send-instruction'
      | 'interrupt-and-send'
      | 'stop'
      | 'restart'
      | 'retry'
      | 'switch-profile'
      | 'pause-run'
      | 'resume-run'
      | 'retry-run';
    readonly sessionId?: AgentSessionId;
    readonly resultingSessionId?: AgentSessionId;
    readonly runId: RunId;
    readonly runtimeId?: string;
    readonly profileId?: string;
  }
>;

export type InterventionCreatedEvent = TypedDomainEvent<
  'intervention.created',
  { readonly intervention: Intervention }
>;

export type InterventionStateChangedEvent = TypedDomainEvent<
  'intervention.state-changed',
  {
    readonly interventionId: InterventionId;
    readonly status: InterventionStatus;
    readonly previousStatus: InterventionStatus;
  }
>;

export type TaskLifecycleEvent = TypedDomainEvent<
  'task.lifecycle',
  {
    readonly taskId: TaskId;
    readonly state: string;
    readonly errorMessage?: string;
    readonly pullRequestId?: PullRequestId;
    readonly pullRequestUrl?: string;
    readonly sourceBranch?: string;
  }
>;

export type PullRequestStateChangedEvent = TypedDomainEvent<
  'pull-request.state-changed',
  {
    readonly pullRequestId: PullRequestId;
    readonly status: PullRequestStatus;
    readonly previousStatus: PullRequestStatus;
    readonly pullRequest?: PullRequest;
  }
>;

export type CheckStateChangedEvent = TypedDomainEvent<
  'check.state-changed',
  {
    readonly checkId: CheckId;
    readonly status: CheckStatus;
    readonly previousStatus: CheckStatus;
  }
>;

export type ConfigurationChangedEvent = TypedDomainEvent<
  'configuration.changed',
  {
    readonly configurationId: ConfigurationId;
    readonly key: string;
    readonly version: number;
  }
>;

export type DomainEvent =
  | TaskReadyEvent
  | TaskStatusChangedEvent
  | RunCreatedEvent
  | RunStateChangedEvent
  | RunCompletedEvent
  | AgentSessionStartedEvent
  | AgentSessionStateChangedEvent
  | AgentSessionCompletedEvent
  | AgentControlEvent
  | InterventionCreatedEvent
  | InterventionStateChangedEvent
  | TaskLifecycleEvent
  | PullRequestStateChangedEvent
  | CheckStateChangedEvent
  | ConfigurationChangedEvent;

export type DomainEventType = DomainEvent['type'];
export type DomainEventOfType<Type extends DomainEventType> = Extract<DomainEvent, { type: Type }>;
export type DomainEventPayload<Type extends DomainEventType> = DomainEventOfType<Type>['payload'];

/** Validates runtime invariants that cannot be expressed by event discriminants alone. */
export function validateDomainEvent(event: DomainEvent): void {
  if (event.id.trim().length === 0 || event.occurredAt.trim().length === 0) {
    throw new DomainValidationError('Domain events require an ID and occurrence timestamp.');
  }

  switch (event.type) {
    case 'agent.state-changed':
      if (!canTransitionAgentSession(event.payload.previousState, event.payload.state)) {
        throw new DomainValidationError(
          `Agent session events must describe legal state transitions: ${event.payload.previousState} -> ${event.payload.state}.`,
        );
      }
      return;
    case 'agent.completed':
    case 'run.completed':
      if (!isTerminalRuntimeState(event.payload.state)) {
        throw new DomainValidationError(
          `${event.type} events must describe a terminal runtime state, not ${event.payload.state}.`,
        );
      }
      return;
    case 'run.state-changed':
      if (!canTransitionRun(event.payload.previousState, event.payload.state)) {
        throw new DomainValidationError(
          `Run events must describe legal state transitions: ${event.payload.previousState} -> ${event.payload.state}.`,
        );
      }
      return;
    default:
      return;
  }
}
