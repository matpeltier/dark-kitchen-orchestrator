import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AgentSession,
  AgentSessionId,
  AgentSessionRuntimeBinding,
  ChannelAddress,
  ChannelInboundReceipt,
  ChannelMessageCorrelation,
  ChannelMessageId,
  Configuration,
  ConfigurationId,
  DomainEvent,
  EventId,
  ExecutionNode,
  ExecutionNodeId,
  Intervention,
  InterventionId,
  Project,
  ProjectId,
  RepositoryId,
  Run,
  RunId,
  RuntimeStore,
  Task,
  TaskGraph,
  TaskGraphId,
  TaskId,
  Workspace,
  WorkspaceId,
  WorkflowRun,
  WorkflowRunId,
} from '@dark-kitchen/core';
import { runMigrations, getSchemaVersion } from './migrations.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSync = any;

export interface SqliteRuntimeStoreOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  readonly databasePath: string;
}

export interface DiagnosticInfo {
  readonly schemaVersion: number;
  readonly counts: Record<string, number>;
  readonly integrityCheck: string;
}

/**
 * SQLite-backed implementation of the `RuntimeStore` port.
 * Uses WAL mode for crash-safe concurrent access.
 */
export class SqliteRuntimeStore implements RuntimeStore {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  private constructor(db: DatabaseSync, databasePath: string) {
    this.db = db;
    this.databasePath = databasePath;
  }

  /** Open (and migrate) a database at the given path. Creates directories if needed. */
  public static async open(options: SqliteRuntimeStoreOptions): Promise<SqliteRuntimeStore> {
    const { databasePath } = options;
    if (databasePath !== ':memory:') {
      await mkdir(dirname(databasePath), { recursive: true });
    }
    // Use createRequire to bypass Vite/vitest module resolution for node:sqlite
    // (experimental built-in not recognized by Vite's resolver).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createRequire } = (await import('node:module')) as any;
    const req = createRequire(import.meta.url);

    const { DatabaseSync: DS } = req('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };
    const db: DatabaseSync = new DS(databasePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return new SqliteRuntimeStore(db, databasePath);
  }

  public close(): void {
    this.db.close();
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  public async getProject(projectId: ProjectId): Promise<Project | undefined> {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | ProjectRow
      | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  public async saveProject(project: Project): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO projects (id, name, tracker_provider, tracker_id, tracker_url, repository_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tracker_provider = excluded.tracker_provider,
        tracker_id = excluded.tracker_id,
        tracker_url = excluded.tracker_url,
        repository_id = excluded.repository_id,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        project.id,
        project.name,
        project.trackerReference?.provider ?? null,
        project.trackerReference?.id ?? null,
        project.trackerReference?.url ?? null,
        project.repositoryId ?? null,
        project.createdAt,
        project.updatedAt,
      );
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  public async getTask(taskId: TaskId): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  public async saveTask(task: Task): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO tasks (id, project_id, title, description, labels_json, status, tracker_provider, tracker_id, tracker_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        labels_json = excluded.labels_json,
        status = excluded.status,
        tracker_provider = excluded.tracker_provider,
        tracker_id = excluded.tracker_id,
        tracker_url = excluded.tracker_url,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.description ?? null,
        task.labels ? JSON.stringify(task.labels) : null,
        task.status,
        task.trackerReference?.provider ?? null,
        task.trackerReference?.id ?? null,
        task.trackerReference?.url ?? null,
        task.createdAt,
        task.updatedAt,
      );
  }

  // ─── TaskGraphs ────────────────────────────────────────────────────────────

  public async getTaskGraph(taskGraphId: TaskGraphId): Promise<TaskGraph | undefined> {
    const row = this.db.prepare('SELECT * FROM task_graphs WHERE id = ?').get(taskGraphId) as
      | TaskGraphRow
      | undefined;
    if (!row) return undefined;

    const taskIds = (
      this.db
        .prepare('SELECT task_id FROM task_graph_tasks WHERE task_graph_id = ?')
        .all(taskGraphId) as { task_id: string }[]
    ).map((r) => r.task_id as TaskId);

    const deps = this.db
      .prepare(
        'SELECT id, task_id, depends_on_task_id, kind FROM task_dependencies WHERE task_id IN (SELECT task_id FROM task_graph_tasks WHERE task_graph_id = ?)',
      )
      .all(taskGraphId) as DepRow[];

    return {
      id: row.id as TaskGraphId,
      projectId: row.project_id as ProjectId,
      taskIds,
      dependencies: deps.map(depFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public async saveTaskGraph(taskGraph: TaskGraph): Promise<void> {
    const save = () => {
      this.db
        .prepare(
          `
        INSERT INTO task_graphs (id, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `,
        )
        .run(taskGraph.id, taskGraph.projectId, taskGraph.createdAt, taskGraph.updatedAt);

      this.db.prepare('DELETE FROM task_graph_tasks WHERE task_graph_id = ?').run(taskGraph.id);
      for (const taskId of taskGraph.taskIds) {
        this.db
          .prepare('INSERT OR IGNORE INTO task_graph_tasks (task_graph_id, task_id) VALUES (?, ?)')
          .run(taskGraph.id, taskId);
      }

      this.db
        .prepare(
          'DELETE FROM task_dependencies WHERE task_id IN (SELECT task_id FROM task_graph_tasks WHERE task_graph_id = ?)',
        )
        .run(taskGraph.id);
      for (const dep of taskGraph.dependencies) {
        this.db
          .prepare(
            `
          INSERT OR IGNORE INTO task_dependencies (id, task_id, depends_on_task_id, kind)
          VALUES (?, ?, ?, ?)
        `,
          )
          .run(dep.id, dep.taskId, dep.dependsOnTaskId, dep.kind);
      }
    };
    this.runInTransaction(save);
  }

  // ─── ExecutionNodes ────────────────────────────────────────────────────────

  public async getExecutionNode(
    executionNodeId: ExecutionNodeId,
  ): Promise<ExecutionNode | undefined> {
    const row = this.db
      .prepare('SELECT * FROM execution_nodes WHERE id = ?')
      .get(executionNodeId) as ExecutionNodeRow | undefined;
    return row ? executionNodeFromRow(row) : undefined;
  }

  public async saveExecutionNode(node: ExecutionNode): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO execution_nodes (id, run_id, task_id, state, agent_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        agent_session_id = excluded.agent_session_id,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        node.id,
        node.runId,
        node.taskId,
        node.state,
        node.agentSessionId ?? null,
        node.createdAt,
        node.updatedAt,
      );
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  public async getRun(runId: RunId): Promise<Run | undefined> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) return undefined;

    const nodeIds = (
      this.db
        .prepare('SELECT execution_node_id FROM run_execution_nodes WHERE run_id = ?')
        .all(runId) as { execution_node_id: string }[]
    ).map((r) => r.execution_node_id as ExecutionNodeId);

    return runFromRow(row, nodeIds);
  }

  public async listRuns(): Promise<Run[]> {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at ASC').all() as RunRow[];
    return rows.map((row) =>
      runFromRow(
        row,
        (
          this.db
            .prepare('SELECT execution_node_id FROM run_execution_nodes WHERE run_id = ?')
            .all(row.id) as { execution_node_id: string }[]
        ).map((r) => r.execution_node_id as ExecutionNodeId),
      ),
    );
  }

  public async saveRun(run: Run): Promise<void> {
    const save = () => {
      this.db
        .prepare(
          `
        INSERT INTO runs (id, project_id, task_id, workflow_run_id, state, workspace_id, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          workspace_id = excluded.workspace_id,
          workflow_run_id = excluded.workflow_run_id,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `,
        )
        .run(
          run.id,
          run.projectId,
          run.taskId,
          run.workflowRunId ?? null,
          run.state,
          run.workspaceId ?? null,
          run.createdAt,
          run.updatedAt,
          run.completedAt ?? null,
        );

      this.db.prepare('DELETE FROM run_execution_nodes WHERE run_id = ?').run(run.id);
      for (const nodeId of run.executionNodeIds) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO run_execution_nodes (run_id, execution_node_id) VALUES (?, ?)',
          )
          .run(run.id, nodeId);
      }
    };
    this.runInTransaction(save);
  }

  // ─── WorkflowRuns ──────────────────────────────────────────────────────────

  public async getWorkflowRun(workflowRunId: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(workflowRunId) as
      | WorkflowRunRow
      | undefined;
    if (!row) return undefined;

    const runIds = (
      this.db
        .prepare('SELECT run_id FROM workflow_run_runs WHERE workflow_run_id = ?')
        .all(workflowRunId) as { run_id: string }[]
    ).map((r) => r.run_id as RunId);

    return workflowRunFromRow(row, runIds);
  }

  public async listWorkflowRuns(): Promise<WorkflowRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM workflow_runs ORDER BY created_at ASC')
      .all() as WorkflowRunRow[];
    return rows.map((row) =>
      workflowRunFromRow(
        row,
        (
          this.db
            .prepare('SELECT run_id FROM workflow_run_runs WHERE workflow_run_id = ?')
            .all(row.id) as { run_id: string }[]
        ).map((r) => r.run_id as RunId),
      ),
    );
  }

  public async saveWorkflowRun(workflowRun: WorkflowRun): Promise<void> {
    const save = () => {
      this.db
        .prepare(
          `
        INSERT INTO workflow_runs (id, project_id, task_graph_id, state, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `,
        )
        .run(
          workflowRun.id,
          workflowRun.projectId,
          workflowRun.taskGraphId,
          workflowRun.state,
          workflowRun.createdAt,
          workflowRun.updatedAt,
          workflowRun.completedAt ?? null,
        );

      this.db
        .prepare('DELETE FROM workflow_run_runs WHERE workflow_run_id = ?')
        .run(workflowRun.id);
      for (const runId of workflowRun.runIds) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO workflow_run_runs (workflow_run_id, run_id) VALUES (?, ?)',
          )
          .run(workflowRun.id, runId);
      }
    };
    this.runInTransaction(save);
  }

  // ─── AgentSessions ────────────────────────────────────────────────────────

  public async getAgentSession(agentSessionId: AgentSessionId): Promise<AgentSession | undefined> {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(agentSessionId) as
      | AgentSessionRow
      | undefined;
    return row ? agentSessionFromRow(row) : undefined;
  }

  public async listAgentSessions(): Promise<AgentSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions ORDER BY created_at ASC')
      .all() as AgentSessionRow[];
    return rows.map(agentSessionFromRow);
  }

  public async saveAgentSession(session: AgentSession): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO agent_sessions (id, run_id, task_id, execution_node_id, workspace_id, state, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `,
      )
      .run(
        session.id,
        session.runId,
        session.taskId,
        session.executionNodeId,
        session.workspaceId,
        session.state,
        session.createdAt,
        session.updatedAt,
        session.completedAt ?? null,
      );
  }

  public async getAgentSessionRuntimeBinding(
    agentSessionId: AgentSessionId,
  ): Promise<AgentSessionRuntimeBinding | undefined> {
    const row = this.db
      .prepare('SELECT * FROM agent_session_runtime_bindings WHERE session_id = ?')
      .get(agentSessionId) as AgentSessionRuntimeBindingRow | undefined;
    return row ? agentSessionRuntimeBindingFromRow(row) : undefined;
  }

  public async saveAgentSessionRuntimeBinding(binding: AgentSessionRuntimeBinding): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO agent_session_runtime_bindings (
        session_id, runtime_id, runtime_kind, profile_id, profile_snapshot,
        initial_prompt, role_id, model, reasoning, last_activity_at, last_error,
        usage, source_session_id, source_action, control_request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        runtime_id = excluded.runtime_id,
        runtime_kind = excluded.runtime_kind,
        profile_id = excluded.profile_id,
        profile_snapshot = excluded.profile_snapshot,
        initial_prompt = excluded.initial_prompt,
        role_id = excluded.role_id,
        model = excluded.model,
        reasoning = excluded.reasoning,
        last_activity_at = excluded.last_activity_at,
        last_error = excluded.last_error,
        usage = excluded.usage,
        source_session_id = excluded.source_session_id,
        source_action = excluded.source_action,
        control_request_id = excluded.control_request_id,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        binding.sessionId,
        binding.runtimeId,
        binding.runtimeKind,
        binding.profileId,
        JSON.stringify(binding.profileSnapshot),
        redactStoredPrompt(binding.initialPrompt),
        binding.roleId ?? null,
        binding.model ?? null,
        binding.reasoning ?? null,
        binding.lastActivityAt,
        binding.lastError ?? null,
        binding.usage ? JSON.stringify(binding.usage) : null,
        binding.sourceSessionId ?? null,
        binding.sourceAction ?? null,
        binding.controlRequestId ?? null,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  public async listAgentSessionRuntimeBindings(options?: {
    readonly sourceSessionId?: AgentSessionId;
    readonly controlRequestId?: string;
  }): Promise<AgentSessionRuntimeBinding[]> {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (options?.sourceSessionId) {
      clauses.push('source_session_id = ?');
      parameters.push(options.sourceSessionId);
    }
    if (options?.controlRequestId) {
      clauses.push('control_request_id = ?');
      parameters.push(options.controlRequestId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM agent_session_runtime_bindings${where} ORDER BY created_at ASC`)
      .all(...parameters) as AgentSessionRuntimeBindingRow[];
    return rows.map(agentSessionRuntimeBindingFromRow);
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  public async getWorkspace(workspaceId: WorkspaceId): Promise<Workspace | undefined> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      | WorkspaceRow
      | undefined;
    return row ? workspaceFromRow(row) : undefined;
  }

  public async listWorkspaces(): Promise<Workspace[]> {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at ASC')
      .all() as WorkspaceRow[];
    return rows.map(workspaceFromRow);
  }

  public async saveWorkspace(workspace: Workspace): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO workspaces (id, project_id, task_id, repository_id, kind, state, path, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        path = excluded.path,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        workspace.id,
        workspace.projectId,
        workspace.taskId,
        workspace.repositoryId,
        workspace.kind,
        workspace.state,
        workspace.path,
        workspace.revision ?? null,
        workspace.createdAt,
        workspace.updatedAt,
      );
  }

  // ─── Interventions ────────────────────────────────────────────────────────

  public async getIntervention(interventionId: InterventionId): Promise<Intervention | undefined> {
    const row = this.db.prepare('SELECT * FROM interventions WHERE id = ?').get(interventionId) as
      | InterventionRow
      | undefined;
    return row ? interventionFromRow(row) : undefined;
  }

  public async listInterventions(): Promise<Intervention[]> {
    const rows = this.db
      .prepare('SELECT * FROM interventions ORDER BY created_at ASC')
      .all() as InterventionRow[];
    return rows.map(interventionFromRow);
  }

  public async saveIntervention(intervention: Intervention): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO interventions (id, scope, target_id, kind, status, summary, details, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        details = excluded.details,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `,
      )
      .run(
        intervention.id,
        intervention.scope,
        intervention.targetId,
        intervention.kind,
        intervention.status,
        intervention.summary,
        intervention.details ?? null,
        intervention.createdAt,
        intervention.updatedAt,
        intervention.resolvedAt ?? null,
      );
  }

  // ─── Configurations ───────────────────────────────────────────────────────

  public async getConfiguration(
    configurationId: ConfigurationId,
  ): Promise<Configuration | undefined> {
    const row = this.db
      .prepare('SELECT * FROM configurations WHERE id = ?')
      .get(configurationId) as ConfigRow | undefined;
    return row ? configFromRow(row) : undefined;
  }

  public async saveConfiguration(configuration: Configuration): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO configurations (id, project_id, key, value, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        version = excluded.version,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        configuration.id,
        configuration.projectId ?? null,
        configuration.key,
        JSON.stringify(configuration.value),
        configuration.version,
        configuration.updatedAt,
      );
  }

  // ─── Channel correlations ────────────────────────────────────────────────

  public async saveChannelMessageCorrelation(
    correlation: ChannelMessageCorrelation,
  ): Promise<void> {
    const id = channelCorrelationKey(
      correlation.transportId,
      correlation.address,
      correlation.messageId,
    );
    this.db
      .prepare(
        `
      INSERT INTO channel_message_correlations (
        id, channel, conversation_id, intervention_id, sent_at,
        transport_id, message_id, code, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport_id, channel, conversation_id, message_id) DO UPDATE SET
        intervention_id = excluded.intervention_id,
        sent_at = excluded.sent_at,
        code = excluded.code,
        active = excluded.active
    `,
      )
      .run(
        id,
        correlation.address.channel,
        correlation.address.conversationId,
        correlation.interventionId,
        correlation.sentAt,
        correlation.transportId,
        correlation.messageId,
        correlation.code,
        correlation.active ? 1 : 0,
      );
  }

  public async getActiveChannelMessageCorrelation(
    transportId: string,
    address: ChannelAddress,
    messageId: ChannelMessageId,
  ): Promise<ChannelMessageCorrelation | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM channel_message_correlations
         WHERE transport_id = ? AND channel = ? AND conversation_id = ?
           AND message_id = ? AND active = 1`,
      )
      .get(transportId, address.channel, address.conversationId, messageId) as
      | ChannelMessageCorrelationRow
      | undefined;
    return row ? channelMessageCorrelationFromRow(row) : undefined;
  }

  public async listActiveChannelMessageCorrelations(options?: {
    readonly transportId?: string;
    readonly address?: ChannelAddress;
    readonly interventionId?: InterventionId;
    readonly code?: string;
  }): Promise<ChannelMessageCorrelation[]> {
    const clauses = ['active = 1'];
    const parameters: string[] = [];
    if (options?.transportId) {
      clauses.push('transport_id = ?');
      parameters.push(options.transportId);
    }
    if (options?.address) {
      clauses.push('channel = ?', 'conversation_id = ?');
      parameters.push(options.address.channel, options.address.conversationId);
    }
    if (options?.interventionId) {
      clauses.push('intervention_id = ?');
      parameters.push(options.interventionId);
    }
    if (options?.code) {
      clauses.push('LOWER(code) = LOWER(?)');
      parameters.push(options.code.trim());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_message_correlations
         WHERE ${clauses.join(' AND ')} ORDER BY sent_at ASC, id ASC`,
      )
      .all(...parameters) as ChannelMessageCorrelationRow[];
    return rows.map(channelMessageCorrelationFromRow);
  }

  public async deactivateChannelMessageCorrelations(interventionId: InterventionId): Promise<void> {
    this.db
      .prepare('UPDATE channel_message_correlations SET active = 0 WHERE intervention_id = ?')
      .run(interventionId);
  }

  public async hasProcessedChannelInbound(
    receipt: Omit<ChannelInboundReceipt, 'processedAt'>,
  ): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM channel_inbound_receipts
         WHERE transport_id = ? AND channel = ? AND conversation_id = ? AND message_id = ?`,
      )
      .get(
        receipt.transportId,
        receipt.address.channel,
        receipt.address.conversationId,
        receipt.messageId,
      ) as { found: number } | undefined;
    return row?.found === 1;
  }

  public async saveProcessedChannelInbound(receipt: ChannelInboundReceipt): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_inbound_receipts (
          transport_id, channel, conversation_id, message_id, processed_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.transportId,
        receipt.address.channel,
        receipt.address.conversationId,
        receipt.messageId,
        receipt.processedAt,
      );
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  public async appendEvent(event: DomainEvent): Promise<void> {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO events (id, type, occurred_at, payload)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(event.id, event.type, event.occurredAt, JSON.stringify(event.payload));
  }

  public async getEvent(eventId: EventId): Promise<DomainEvent | undefined> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as
      | EventRow
      | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  public async listEvents(options?: {
    type?: string;
    limit?: number;
    afterSeq?: number;
  }): Promise<DomainEvent[]> {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params: (string | number)[] = [];
    if (options?.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }
    if (options?.afterSeq !== undefined) {
      sql += ' AND seq > ?';
      params.push(options.afterSeq);
    }
    sql += ' ORDER BY seq ASC';
    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(eventFromRow);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  public getDiagnostics(): DiagnosticInfo {
    const schemaVersion = getSchemaVersion(this.db);
    const tables = [
      'projects',
      'tasks',
      'runs',
      'workflow_runs',
      'agent_sessions',
      'agent_session_runtime_bindings',
      'workspaces',
      'interventions',
      'channel_message_correlations',
      'channel_inbound_receipts',
      'events',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      counts[table] = row.c;
    }
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    return {
      schemaVersion,
      counts,
      integrityCheck: integrity.integrity_check,
    };
  }

  /** Backup the database to a destination path (using SQLite backup API). */
  public backup(destinationPath: string): void {
    this.db.exec(`VACUUM INTO '${destinationPath.replace(/'/g, "''")}'`);
  }

  // ─── Transaction helper ───────────────────────────────────────────────────

  private runInTransaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ─── Row types & mappers ──────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  tracker_provider: string | null;
  tracker_id: string | null;
  tracker_url: string | null;
  repository_id: string | null;
  created_at: string;
  updated_at: string;
}

function projectFromRow(r: ProjectRow): Project {
  const base: Project = {
    id: r.id as ProjectId,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.tracker_provider && r.tracker_id) {
    const ref: Project['trackerReference'] = r.tracker_url
      ? { provider: r.tracker_provider, id: r.tracker_id, url: r.tracker_url }
      : { provider: r.tracker_provider, id: r.tracker_id };
    Object.assign(base, { trackerReference: ref });
  }
  if (r.repository_id) Object.assign(base, { repositoryId: r.repository_id as RepositoryId });
  return base;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  labels_json: string | null;
  status: string;
  tracker_provider: string | null;
  tracker_id: string | null;
  tracker_url: string | null;
  created_at: string;
  updated_at: string;
}

function taskFromRow(r: TaskRow): Task {
  const base: Task = {
    id: r.id as TaskId,
    projectId: r.project_id as ProjectId,
    title: r.title,
    status: r.status as Task['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.description) Object.assign(base, { description: r.description });
  if (r.labels_json) {
    const labels = JSON.parse(r.labels_json) as unknown;
    if (Array.isArray(labels) && labels.every((label) => typeof label === 'string')) {
      Object.assign(base, { labels });
    }
  }
  if (r.tracker_provider && r.tracker_id) {
    const ref: Task['trackerReference'] = r.tracker_url
      ? { provider: r.tracker_provider, id: r.tracker_id, url: r.tracker_url }
      : { provider: r.tracker_provider, id: r.tracker_id };
    Object.assign(base, { trackerReference: ref });
  }
  return base;
}

interface TaskGraphRow {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}
interface DepRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  kind: string;
}

function depFromRow(r: DepRow): TaskGraph['dependencies'][number] {
  return {
    id: r.id as TaskGraph['dependencies'][number]['id'],
    taskId: r.task_id as TaskId,
    dependsOnTaskId: r.depends_on_task_id as TaskId,
    kind: r.kind as 'blocks' | 'related',
  };
}

interface ExecutionNodeRow {
  id: string;
  run_id: string;
  task_id: string;
  state: string;
  agent_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function executionNodeFromRow(r: ExecutionNodeRow): ExecutionNode {
  const base: ExecutionNode = {
    id: r.id as ExecutionNodeId,
    runId: r.run_id as RunId,
    taskId: r.task_id as TaskId,
    state: r.state as ExecutionNode['state'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.agent_session_id)
    Object.assign(base, { agentSessionId: r.agent_session_id as AgentSessionId });
  return base;
}

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  workflow_run_id: string | null;
  state: string;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function runFromRow(r: RunRow, executionNodeIds: ExecutionNodeId[]): Run {
  const base: Run = {
    id: r.id as RunId,
    projectId: r.project_id as ProjectId,
    taskId: r.task_id as TaskId,
    state: r.state as Run['state'],
    executionNodeIds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.workflow_run_id) Object.assign(base, { workflowRunId: r.workflow_run_id as WorkflowRunId });
  if (r.workspace_id) Object.assign(base, { workspaceId: r.workspace_id as WorkspaceId });
  if (r.completed_at) Object.assign(base, { completedAt: r.completed_at });
  return base;
}

interface WorkflowRunRow {
  id: string;
  project_id: string;
  task_graph_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function workflowRunFromRow(r: WorkflowRunRow, runIds: RunId[]): WorkflowRun {
  const base: WorkflowRun = {
    id: r.id as WorkflowRunId,
    projectId: r.project_id as ProjectId,
    taskGraphId: r.task_graph_id as TaskGraphId,
    state: r.state as WorkflowRun['state'],
    runIds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.completed_at) Object.assign(base, { completedAt: r.completed_at });
  return base;
}

interface AgentSessionRow {
  id: string;
  run_id: string;
  task_id: string;
  execution_node_id: string;
  workspace_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function agentSessionFromRow(r: AgentSessionRow): AgentSession {
  const base: AgentSession = {
    id: r.id as AgentSessionId,
    runId: r.run_id as RunId,
    taskId: r.task_id as TaskId,
    executionNodeId: r.execution_node_id as ExecutionNodeId,
    workspaceId: r.workspace_id as WorkspaceId,
    state: r.state as AgentSession['state'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.completed_at) Object.assign(base, { completedAt: r.completed_at });
  return base;
}

interface AgentSessionRuntimeBindingRow {
  session_id: string;
  runtime_id: string;
  runtime_kind: string;
  profile_id: string;
  profile_snapshot: string;
  initial_prompt: string;
  role_id: string | null;
  model: string | null;
  reasoning: string | null;
  last_activity_at: string;
  last_error: string | null;
  usage: string | null;
  source_session_id: string | null;
  source_action: string | null;
  control_request_id: string | null;
  created_at: string;
  updated_at: string;
}

function agentSessionRuntimeBindingFromRow(
  r: AgentSessionRuntimeBindingRow,
): AgentSessionRuntimeBinding {
  const binding: AgentSessionRuntimeBinding = {
    sessionId: r.session_id as AgentSessionId,
    runtimeId: r.runtime_id,
    runtimeKind: r.runtime_kind,
    profileId: r.profile_id,
    profileSnapshot: JSON.parse(r.profile_snapshot) as unknown,
    initialPrompt: r.initial_prompt,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.role_id) Object.assign(binding, { roleId: r.role_id });
  if (r.model) Object.assign(binding, { model: r.model });
  if (r.reasoning) Object.assign(binding, { reasoning: r.reasoning });
  if (r.last_error) Object.assign(binding, { lastError: r.last_error });
  if (r.usage) {
    Object.assign(binding, { usage: JSON.parse(r.usage) as Readonly<Record<string, number>> });
  }
  if (r.source_session_id) {
    Object.assign(binding, { sourceSessionId: r.source_session_id as AgentSessionId });
  }
  if (r.source_action) {
    Object.assign(binding, {
      sourceAction: r.source_action as AgentSessionRuntimeBinding['sourceAction'],
    });
  }
  if (r.control_request_id) Object.assign(binding, { controlRequestId: r.control_request_id });
  return binding;
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  task_id: string;
  repository_id: string;
  kind: string;
  state: string;
  path: string;
  revision: string | null;
  created_at: string;
  updated_at: string;
}

function workspaceFromRow(r: WorkspaceRow): Workspace {
  const base: Workspace = {
    id: r.id as WorkspaceId,
    projectId: r.project_id as ProjectId,
    taskId: r.task_id as TaskId,
    repositoryId: r.repository_id as RepositoryId,
    kind: r.kind as Workspace['kind'],
    state: r.state as Workspace['state'],
    path: r.path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.revision) Object.assign(base, { revision: r.revision });
  return base;
}

interface InterventionRow {
  id: string;
  scope: string;
  target_id: string;
  kind: string;
  status: string;
  summary: string;
  details: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function makeInterventionBase(r: InterventionRow) {
  const base = {
    id: r.id as InterventionId,
    kind: r.kind as Intervention['kind'],
    status: r.status as Intervention['status'],
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  } as const;
  if (r.details) Object.assign(base, { details: r.details });
  if (r.resolved_at) Object.assign(base, { resolvedAt: r.resolved_at });
  return base;
}

function interventionFromRow(r: InterventionRow): Intervention {
  const base = makeInterventionBase(r);
  const scope = r.scope as Intervention['scope'];
  if (scope === 'task') return { ...base, scope, targetId: r.target_id as TaskId } as Intervention;
  if (scope === 'run') return { ...base, scope, targetId: r.target_id as RunId } as Intervention;
  return {
    ...base,
    scope: 'agent' as const,
    targetId: r.target_id as AgentSessionId,
  } as Intervention;
}

interface ConfigRow {
  id: string;
  project_id: string | null;
  key: string;
  value: string;
  version: number;
  updated_at: string;
}

function configFromRow(r: ConfigRow): Configuration {
  const base: Configuration = {
    id: r.id as ConfigurationId,
    key: r.key,
    value: JSON.parse(r.value) as unknown,
    version: r.version,
    updatedAt: r.updated_at,
  };
  if (r.project_id) Object.assign(base, { projectId: r.project_id as ProjectId });
  return base;
}

interface ChannelMessageCorrelationRow {
  transport_id: string;
  message_id: string;
  channel: string;
  conversation_id: string;
  intervention_id: string;
  code: string;
  sent_at: string;
  active: number;
}

function channelMessageCorrelationFromRow(
  r: ChannelMessageCorrelationRow,
): ChannelMessageCorrelation {
  return {
    transportId: r.transport_id,
    messageId: r.message_id as ChannelMessageId,
    address: { channel: r.channel, conversationId: r.conversation_id },
    interventionId: r.intervention_id as InterventionId,
    code: r.code,
    sentAt: r.sent_at,
    active: r.active === 1,
  };
}

function channelCorrelationKey(
  transportId: string,
  address: ChannelAddress,
  messageId: ChannelMessageId,
): string {
  return `${transportId}\u0000${address.channel}\u0000${address.conversationId}\u0000${messageId}`;
}

/** Defense-in-depth: no caller may persist an unredacted resumable prompt. */
export function redactStoredPrompt(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, '[REDACTED]')
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/giu, '$1[REDACTED]');
}

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  payload: string;
  seq: number;
}

function eventFromRow(r: EventRow): DomainEvent {
  return {
    id: r.id as EventId,
    type: r.type,
    occurredAt: r.occurred_at,
    payload: JSON.parse(r.payload) as unknown,
  } as DomainEvent;
}
