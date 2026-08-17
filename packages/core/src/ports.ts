import type {
  AgentSession,
  AgentSessionId,
  ChannelMessageId,
  Check,
  Configuration,
  ConfigurationId,
  EventId,
  ExecutionNode,
  ExecutionNodeId,
  Intervention,
  InterventionId,
  Project,
  ProjectId,
  PullRequest,
  PullRequestId,
  Repository,
  RepositoryId,
  Run,
  RunId,
  ScmReference,
  Task,
  TaskGraph,
  TaskGraphId,
  TaskId,
  TaskStatus,
  TrackerReference,
  WorkflowRun,
  WorkflowRunId,
  Workspace,
  WorkspaceId,
} from './domain.js';
import type {
  DomainEvent,
  DomainEventOfType,
  DomainEventType,
  DomainEventPayload,
} from './events.js';

export interface TaskUpdate {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
}

/** Maps provider-owned tracker references to normalized Dark Kitchen models. */
export interface TrackerAdapter {
  readonly provider: string;
  getProject(reference: TrackerReference): Promise<Project>;
  getTask(reference: TrackerReference): Promise<Task>;
  listTasks(projectId: ProjectId): Promise<readonly Task[]>;
  updateTask(taskId: TaskId, update: TaskUpdate): Promise<Task>;
}

export interface CreatePullRequestInput {
  readonly repositoryId: RepositoryId;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly body?: string;
}

/** Source-control operations use normalized models and provider references only. */
export interface ScmAdapter {
  readonly provider: string;
  getRepository(reference: ScmReference): Promise<Repository>;
  getPullRequest(repositoryId: RepositoryId, pullRequestId: PullRequestId): Promise<PullRequest>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listChecks(pullRequestId: PullRequestId): Promise<readonly Check[]>;
}

export interface PrimaryWorktreeRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly repositoryId: RepositoryId;
  readonly revision?: string;
}

/**
 * Workspace allocation is the boundary that must enforce one primary worktree
 * per active task. Primary worktrees are task-scoped and cannot be shared.
 */
export interface WorkspaceManager {
  allocatePrimaryWorktree(request: PrimaryWorktreeRequest): Promise<Workspace>;
  getWorkspace(workspaceId: WorkspaceId): Promise<Workspace | undefined>;
  getPrimaryWorktree(taskId: TaskId): Promise<Workspace | undefined>;
  releaseWorkspace(workspaceId: WorkspaceId): Promise<void>;
}

export interface StartAgentSessionInput {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly executionNodeId: ExecutionNodeId;
  readonly workspaceId: WorkspaceId;
}

export interface HarnessInput {
  readonly sessionId: AgentSessionId;
  readonly content: string;
}

/** Agent execution is replaceable and does not expose a harness-specific type. */
export interface HarnessRuntime {
  startSession(input: StartAgentSessionInput): Promise<AgentSession>;
  getSession(sessionId: AgentSessionId): Promise<AgentSession | undefined>;
  sendInput(input: HarnessInput): Promise<void>;
  interruptSession(sessionId: AgentSessionId): Promise<void>;
  stopSession(sessionId: AgentSessionId): Promise<void>;
}

export interface ChannelAddress {
  readonly channel: string;
  readonly conversationId: string;
}

export interface ChannelMessage {
  readonly id: ChannelMessageId;
  readonly address: ChannelAddress;
  readonly body: string;
  readonly sentAt: string;
  readonly author?: string;
}

export type ChannelMessageHandler = (message: ChannelMessage) => void | Promise<void>;

/** Human communication and intervention delivery without a concrete channel SDK. */
export interface ChannelGateway {
  sendMessage(address: ChannelAddress, body: string): Promise<ChannelMessage>;
  subscribe(address: ChannelAddress, handler: ChannelMessageHandler): Promise<EventSubscription>;
}

export interface EventSubscription {
  unsubscribe(): void | Promise<void>;
}

export type DomainEventHandler<Event extends DomainEvent = DomainEvent> = (
  event: Event,
) => void | Promise<void>;

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface EventSubscriber {
  subscribe<Type extends DomainEventType>(
    type: Type,
    handler: DomainEventHandler<DomainEventOfType<Type>>,
  ): Promise<EventSubscription>;
}

export type DomainEventBus = EventPublisher & EventSubscriber;

export interface RuntimeStore {
  getProject(projectId: ProjectId): Promise<Project | undefined>;
  saveProject(project: Project): Promise<void>;
  getTask(taskId: TaskId): Promise<Task | undefined>;
  saveTask(task: Task): Promise<void>;
  getTaskGraph(taskGraphId: TaskGraphId): Promise<TaskGraph | undefined>;
  saveTaskGraph(taskGraph: TaskGraph): Promise<void>;
  getExecutionNode(executionNodeId: ExecutionNodeId): Promise<ExecutionNode | undefined>;
  saveExecutionNode(executionNode: ExecutionNode): Promise<void>;
  getRun(runId: RunId): Promise<Run | undefined>;
  saveRun(run: Run): Promise<void>;
  getWorkflowRun(workflowRunId: WorkflowRunId): Promise<WorkflowRun | undefined>;
  saveWorkflowRun(workflowRun: WorkflowRun): Promise<void>;
  getAgentSession(agentSessionId: AgentSessionId): Promise<AgentSession | undefined>;
  saveAgentSession(agentSession: AgentSession): Promise<void>;
  getWorkspace(workspaceId: WorkspaceId): Promise<Workspace | undefined>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  getIntervention(interventionId: InterventionId): Promise<Intervention | undefined>;
  saveIntervention(intervention: Intervention): Promise<void>;
  getConfiguration(configurationId: ConfigurationId): Promise<Configuration | undefined>;
  saveConfiguration(configuration: Configuration): Promise<void>;
  appendEvent(event: DomainEvent): Promise<void>;
  getEvent(eventId: EventId): Promise<DomainEvent | undefined>;
}

export type { DomainEventPayload, DomainEventType, DomainEventOfType };

/** @deprecated Use TrackerAdapter. Kept as a migration alias for the bootstrap API. */
export type Tracker = TrackerAdapter;

/** @deprecated Use ScmAdapter. */
export type Scm = ScmAdapter;

/** @deprecated Use HarnessRuntime. */
export type Runtime = HarnessRuntime;
