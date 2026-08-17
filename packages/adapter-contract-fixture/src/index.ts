import type {
  AgentSession,
  AgentSessionId,
  ChannelAddress,
  ChannelGateway,
  ChannelMessage,
  ChannelMessageHandler,
  Check,
  Configuration,
  ConfigurationId,
  CreatePullRequestInput,
  DomainEvent,
  DomainEventBus,
  DomainEventHandler,
  DomainEventOfType,
  DomainEventType,
  EventId,
  EventSubscription,
  HarnessInput,
  HarnessRuntime,
  Intervention,
  InterventionId,
  PrimaryWorktreeRequest,
  Project,
  ProjectId,
  PullRequest,
  PullRequestId,
  Repository,
  RepositoryId,
  Run,
  RunId,
  RuntimeStore,
  ScmAdapter,
  ScmReference,
  StartAgentSessionInput,
  Task,
  TaskGraph,
  TaskGraphId,
  TaskId,
  TaskUpdate,
  TrackerAdapter,
  TrackerReference,
  WorkflowRun,
  WorkflowRunId,
  Workspace,
  WorkspaceId,
  WorkspaceManager,
} from '@dark-kitchen/core';

function unavailable(operation: string, ...argumentsToIgnore: readonly unknown[]): never {
  void argumentsToIgnore;
  throw new Error(`Contract fixture operation is not implemented: ${operation}`);
}

const eventSubscription: EventSubscription = {
  unsubscribe: () => undefined,
};

export class ContractTrackerAdapter implements TrackerAdapter {
  public readonly provider = 'contract-fixture';

  public async getProject(_reference: TrackerReference): Promise<Project> {
    return unavailable('tracker.getProject', _reference);
  }

  public async getTask(_reference: TrackerReference): Promise<Task> {
    return unavailable('tracker.getTask', _reference);
  }

  public async listTasks(_projectId: ProjectId): Promise<readonly Task[]> {
    return unavailable('tracker.listTasks', _projectId);
  }

  public async updateTask(_taskId: TaskId, _update: TaskUpdate): Promise<Task> {
    return unavailable('tracker.updateTask', _taskId, _update);
  }
}

export class ContractScmAdapter implements ScmAdapter {
  public readonly provider = 'contract-fixture';

  public async getRepository(_reference: ScmReference): Promise<Repository> {
    return unavailable('scm.getRepository', _reference);
  }

  public async getPullRequest(
    _repositoryId: RepositoryId,
    _pullRequestId: PullRequestId,
  ): Promise<PullRequest> {
    return unavailable('scm.getPullRequest', _repositoryId, _pullRequestId);
  }

  public async createPullRequest(_input: CreatePullRequestInput): Promise<PullRequest> {
    return unavailable('scm.createPullRequest', _input);
  }

  public async listChecks(_pullRequestId: PullRequestId): Promise<readonly Check[]> {
    return unavailable('scm.listChecks', _pullRequestId);
  }
}

export class ContractWorkspaceManager implements WorkspaceManager {
  public async allocatePrimaryWorktree(_request: PrimaryWorktreeRequest): Promise<Workspace> {
    return unavailable('workspace.allocatePrimaryWorktree', _request);
  }

  public async getWorkspace(_workspaceId: WorkspaceId): Promise<Workspace | undefined> {
    return unavailable('workspace.getWorkspace', _workspaceId);
  }

  public async getPrimaryWorktree(_taskId: TaskId): Promise<Workspace | undefined> {
    return unavailable('workspace.getPrimaryWorktree', _taskId);
  }

  public async releaseWorkspace(_workspaceId: WorkspaceId): Promise<void> {
    return unavailable('workspace.releaseWorkspace', _workspaceId);
  }
}

export class ContractHarnessRuntime implements HarnessRuntime {
  public async startSession(_input: StartAgentSessionInput): Promise<AgentSession> {
    return unavailable('harness.startSession', _input);
  }

  public async getSession(_sessionId: AgentSessionId): Promise<AgentSession | undefined> {
    return unavailable('harness.getSession', _sessionId);
  }

  public async sendInput(_input: HarnessInput): Promise<void> {
    return unavailable('harness.sendInput', _input);
  }

  public async interruptSession(_sessionId: AgentSessionId): Promise<void> {
    return unavailable('harness.interruptSession', _sessionId);
  }

  public async stopSession(_sessionId: AgentSessionId): Promise<void> {
    return unavailable('harness.stopSession', _sessionId);
  }
}

export class ContractChannelGateway implements ChannelGateway {
  public async sendMessage(_address: ChannelAddress, _body: string): Promise<ChannelMessage> {
    return unavailable('channel.sendMessage', _address, _body);
  }

  public async subscribe(
    _address: ChannelAddress,
    _handler: ChannelMessageHandler,
  ): Promise<EventSubscription> {
    void _address;
    void _handler;
    return eventSubscription;
  }
}

export class ContractEventBus implements DomainEventBus {
  public async publish(_event: DomainEvent): Promise<void> {
    void _event;
    return undefined;
  }

  public async subscribe<Type extends DomainEventType>(
    _type: Type,
    _handler: DomainEventHandler<DomainEventOfType<Type>>,
  ): Promise<EventSubscription> {
    void _type;
    void _handler;
    return eventSubscription;
  }
}

export class ContractRuntimeStore implements RuntimeStore {
  public async getProject(_projectId: ProjectId): Promise<Project | undefined> {
    void _projectId;
    return undefined;
  }

  public async saveProject(_project: Project): Promise<void> {
    void _project;
    return undefined;
  }

  public async getTask(_taskId: TaskId): Promise<Task | undefined> {
    void _taskId;
    return undefined;
  }

  public async saveTask(_task: Task): Promise<void> {
    void _task;
    return undefined;
  }

  public async getTaskGraph(_taskGraphId: TaskGraphId): Promise<TaskGraph | undefined> {
    void _taskGraphId;
    return undefined;
  }

  public async saveTaskGraph(_taskGraph: TaskGraph): Promise<void> {
    void _taskGraph;
    return undefined;
  }

  public async getRun(_runId: RunId): Promise<Run | undefined> {
    void _runId;
    return undefined;
  }

  public async saveRun(_run: Run): Promise<void> {
    void _run;
    return undefined;
  }

  public async getWorkflowRun(_workflowRunId: WorkflowRunId): Promise<WorkflowRun | undefined> {
    void _workflowRunId;
    return undefined;
  }

  public async saveWorkflowRun(_workflowRun: WorkflowRun): Promise<void> {
    void _workflowRun;
    return undefined;
  }

  public async getAgentSession(_agentSessionId: AgentSessionId): Promise<AgentSession | undefined> {
    void _agentSessionId;
    return undefined;
  }

  public async saveAgentSession(_agentSession: AgentSession): Promise<void> {
    void _agentSession;
    return undefined;
  }

  public async getWorkspace(_workspaceId: WorkspaceId): Promise<Workspace | undefined> {
    void _workspaceId;
    return undefined;
  }

  public async saveWorkspace(_workspace: Workspace): Promise<void> {
    void _workspace;
    return undefined;
  }

  public async getIntervention(_interventionId: InterventionId): Promise<Intervention | undefined> {
    void _interventionId;
    return undefined;
  }

  public async saveIntervention(_intervention: Intervention): Promise<void> {
    void _intervention;
    return undefined;
  }

  public async getConfiguration(
    _configurationId: ConfigurationId,
  ): Promise<Configuration | undefined> {
    void _configurationId;
    return undefined;
  }

  public async saveConfiguration(_configuration: Configuration): Promise<void> {
    void _configuration;
    return undefined;
  }

  public async appendEvent(_event: DomainEvent): Promise<void> {
    void _event;
    return undefined;
  }

  public async getEvent(_eventId: EventId): Promise<DomainEvent | undefined> {
    void _eventId;
    return undefined;
  }
}

export const contractPorts = {
  channel: new ContractChannelGateway(),
  eventBus: new ContractEventBus(),
  harness: new ContractHarnessRuntime(),
  runtimeStore: new ContractRuntimeStore(),
  scm: new ContractScmAdapter(),
  tracker: new ContractTrackerAdapter(),
  workspace: new ContractWorkspaceManager(),
};

export type ContractPortName = keyof typeof contractPorts;
