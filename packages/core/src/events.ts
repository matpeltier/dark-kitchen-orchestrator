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
    readonly state: Extract<AgentSessionState, 'completed' | 'failed' | 'stopped' | 'interrupted'>;
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
  | InterventionCreatedEvent
  | InterventionStateChangedEvent
  | PullRequestStateChangedEvent
  | CheckStateChangedEvent
  | ConfigurationChangedEvent;

export type DomainEventType = DomainEvent['type'];
export type DomainEventOfType<Type extends DomainEventType> = Extract<DomainEvent, { type: Type }>;
export type DomainEventPayload<Type extends DomainEventType> = DomainEventOfType<Type>['payload'];
