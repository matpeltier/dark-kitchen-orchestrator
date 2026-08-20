// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSync = any;

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          tracker_provider TEXT,
          tracker_id TEXT,
          tracker_url TEXT,
          repository_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          scm_provider TEXT NOT NULL,
          scm_id TEXT NOT NULL,
          scm_url TEXT,
          default_branch TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          tracker_provider TEXT,
          tracker_id TEXT,
          tracker_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        CREATE TABLE IF NOT EXISTS task_dependencies (
          id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL,
          depends_on_task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
        );

        CREATE TABLE IF NOT EXISTS task_graphs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_graph_tasks (
          task_graph_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          PRIMARY KEY (task_graph_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS execution_nodes (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          state TEXT NOT NULL,
          agent_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          workflow_run_id TEXT,
          state TEXT NOT NULL,
          workspace_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS run_execution_nodes (
          run_id TEXT NOT NULL,
          execution_node_id TEXT NOT NULL,
          PRIMARY KEY (run_id, execution_node_id)
        );

        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          task_graph_id TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS workflow_run_runs (
          workflow_run_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          PRIMARY KEY (workflow_run_id, run_id)
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          execution_node_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          path TEXT NOT NULL,
          revision TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interventions (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          target_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS configurations (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channel_message_correlations (
          id TEXT PRIMARY KEY NOT NULL,
          channel TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          run_id TEXT,
          intervention_id TEXT,
          sent_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_run ON agent_sessions(run_id);
        CREATE INDEX IF NOT EXISTS idx_workspaces_task ON workspaces(task_id);
        CREATE INDEX IF NOT EXISTS idx_interventions_target ON interventions(target_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
      `);
    },
  },
  {
    version: 2,
    name: 'durable-session-ownership-and-channel-correlation',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_session_runtime_bindings (
          session_id TEXT PRIMARY KEY NOT NULL,
          runtime_id TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          profile_snapshot TEXT NOT NULL,
          initial_prompt TEXT NOT NULL,
          role_id TEXT,
          model TEXT,
          reasoning TEXT,
          last_activity_at TEXT NOT NULL,
          last_error TEXT,
          usage TEXT,
          source_session_id TEXT,
          source_action TEXT,
          control_request_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_binding_replacement
          ON agent_session_runtime_bindings(source_session_id, source_action, profile_id)
          WHERE source_session_id IS NOT NULL AND source_action IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_binding_control_request
          ON agent_session_runtime_bindings(control_request_id)
          WHERE control_request_id IS NOT NULL;

        ALTER TABLE channel_message_correlations
          ADD COLUMN transport_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE channel_message_correlations ADD COLUMN message_id TEXT;
        ALTER TABLE channel_message_correlations ADD COLUMN code TEXT;
        ALTER TABLE channel_message_correlations ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
        UPDATE channel_message_correlations SET message_id = id WHERE message_id IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_correlation_lookup
          ON channel_message_correlations(transport_id, channel, conversation_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_channel_correlation_intervention
          ON channel_message_correlations(intervention_id, active);
        CREATE INDEX IF NOT EXISTS idx_channel_correlation_conversation
          ON channel_message_correlations(transport_id, channel, conversation_id, active);

        CREATE TABLE IF NOT EXISTS channel_inbound_receipts (
          transport_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          PRIMARY KEY (transport_id, channel, conversation_id, message_id)
        );
      `);
    },
  },
  {
    version: 3,
    name: 'normalized-task-labels',
    up(db) {
      db.exec(`ALTER TABLE tasks ADD COLUMN labels_json TEXT;`);
    },
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      migration.up(db);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  }
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}
