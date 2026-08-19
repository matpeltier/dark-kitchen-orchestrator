/**
 * Dark Kitchen Daemon
 *
 * Initialises all services and runs the control plane:
 *  - Config loading (.dark-kitchen/config.yaml)
 *  - SQLite runtime store
 *  - GitHub Issues / Linear / Jira tracker adapter
 *  - GitHub SCM adapter
 *  - acpx harness runtime
 *  - Git worktree workspace manager
 *  - Workflow engine with durable journals
 *  - Task scheduler / supervisor
 *  - PR lifecycle orchestrator
 *  - Intervention service
 *  - OpenClaw Gateway channel transport (optional)
 *  - MCP server (stdio)
 *  - Main daemon polling loop
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import {
  InterventionService,
  RunSupervisor,
  PrLifecycleOrchestrator,
  DaemonLoop,
  executeWorkflow,
} from '@dark-kitchen/runtime';
import { ChannelGateway } from '@dark-kitchen/channels';
import { OpenClawGatewayTransport } from '@dark-kitchen/channels';
import { ConfigStore } from '@dark-kitchen/config';
import type { DarkKitchenConfig } from '@dark-kitchen/config';

export interface DaemonOptions {
  readonly projectRoot: string;
  readonly dataDir?: string;
  readonly foreground?: boolean;
  readonly logFormat?: 'human' | 'json';
}

export interface DaemonState {
  readonly pid: number;
  readonly startedAt: string;
  readonly projectRoot: string;
  readonly databasePath: string;
}

export class DarkKitchenDaemon {
  private readonly options: DaemonOptions;
  private readonly dataDir: string;
  private store?: SqliteRuntimeStore;
  private interventionService?: InterventionService;
  private channelGateway?: ChannelGateway;
  private daemonLoop?: DaemonLoop;
  private running = false;
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];

  public constructor(options: DaemonOptions) {
    this.options = options;
    this.dataDir = options.dataDir ?? join(options.projectRoot, '.dark-kitchen', 'runtime');
  }

  public async start(): Promise<void> {
    if (this.running) throw new Error('Daemon is already running');

    await mkdir(this.dataDir, { recursive: true });

    // Duplicate instance guard
    const lockPath = join(this.dataDir, 'daemon.lock');
    await this.acquireLock(lockPath);

    // 1. Load config
    let config: DarkKitchenConfig | undefined;
    try {
      const configStore = new ConfigStore({ projectRoot: this.options.projectRoot });
      config = await configStore.read();
    } catch {
      this.log(
        'warn',
        'No .dark-kitchen/config.yaml found — starting with empty config. Run `dk init` first.',
      );
    }

    // 2. SQLite runtime store
    const databasePath = join(this.dataDir, 'store.db');
    this.store = await SqliteRuntimeStore.open({ databasePath });

    // 3. Intervention service
    this.interventionService = new InterventionService(this.store);

    // 4. Channel Gateway (OpenClaw — optional)
    this.channelGateway = new ChannelGateway();
    const openclawUrl = process.env['OPENCLAW_GATEWAY_URL'] ?? config?.channels?.[0]?.url;
    if (openclawUrl || process.env['OPENCLAW_GATEWAY_TOKEN']) {
      const transportConfig: import('@dark-kitchen/channels').OpenClawGatewayConfig = {
        id: 'openclaw',
        gatewayUrl: openclawUrl ?? 'ws://localhost:18789',
      };
      const gwToken = process.env['OPENCLAW_GATEWAY_TOKEN'];
      if (gwToken) Object.assign(transportConfig, { authToken: gwToken });
      const transport = new OpenClawGatewayTransport(transportConfig);
      this.channelGateway.addTransport(transport);
      // Route inbound replies to interventions
      this.channelGateway.onInterventionReply(async (interventionId, reply) => {
        const resolveInput: Parameters<NonNullable<typeof this.interventionService>['resolve']>[0] =
          {
            interventionId,
            action: 'free-text',
            answer: reply.body,
          };
        if (reply.senderId) Object.assign(resolveInput, { resolvedBy: reply.senderId });
        await this.interventionService?.resolve(resolveInput);
      });
      // Connect to OpenClaw Gateway (non-blocking)
      transport.connect().catch((err: unknown) => {
        this.log('warn', `OpenClaw Gateway connection failed: ${String(err)}`);
      });
    }

    // 5. Tracker adapter
    const trackerConfig = config?.trackers?.[0];
    let tracker: import('@dark-kitchen/tracker').FullTrackerAdapter | undefined;
    if (trackerConfig) {
      tracker = await this.buildTrackerAdapter(trackerConfig);
    }

    // 6. SCM adapter
    const scmConfig = config?.repositories?.[0];
    let scm: import('@dark-kitchen/scm').FullScmAdapter | undefined;
    if (scmConfig && scmConfig.kind === 'github') {
      scm = await this.buildScmAdapter(scmConfig);
    }

    // 7. Harness runtime (acpx)
    const harnessProfile = config?.harnessProfiles?.find((h) => h.managed === true);
    const roleResolver = await this.buildRoleResolver(harnessProfile);

    // 8. Workspace manager
    const { GitWorktreeManager } = await import('@dark-kitchen/workspace-manager');
    const worktreesBaseDir = join(this.dataDir, 'worktrees');
    const workspaceManager = new GitWorktreeManager({
      repositoryPath: this.options.projectRoot,
      worktreesBaseDir,
    });

    // 9. Default workflow
    const { defaultWorkflow } = await import('@dark-kitchen/workflows');

    // 10. Scheduler supervisor
    const projectId = `default-project` as import('@dark-kitchen/core').ProjectId;
    const supervisor = new RunSupervisor(
      {
        maxParallelTasks: config?.concurrency?.maxParallelTasks ?? 4,
        projectId,
      },
      async (taskId: import('@dark-kitchen/core').TaskId) => {
        return `run-${taskId}-${Date.now()}` as import('@dark-kitchen/core').RunId;
      },
    );

    // 11. PR lifecycle orchestrator
    if (tracker && scm) {
      const lifecycleOrchestrator = new PrLifecycleOrchestrator(scm, tracker);
      const repoId =
        `github:${scmConfig?.owner}/${scmConfig?.repo}` as import('@dark-kitchen/core').RepositoryId;

      // 12. Main daemon polling loop
      this.daemonLoop = new DaemonLoop(
        {
          pollIntervalMs: 30_000,
          projectId,
          repositoryId: repoId,
          targetBranch: scmConfig?.defaultBranch ?? 'main',
          requiredChecks: config?.mergePolicy?.requiredChecks ?? [],
          autoMerge: config?.mergePolicy !== undefined,
        },
        {
          supervisor,
          getTaskGraph: async () => {
            if (!tracker) return { tasks: [], dependencies: [] };
            const ref: import('@dark-kitchen/core').TrackerReference = {
              provider: trackerConfig?.kind ?? 'github-issues',
              id: `${trackerConfig?.owner ?? ''}/${trackerConfig?.repo ?? ''}`,
            };
            const project = await tracker.getProject(ref);
            const tasks = await tracker.listTasks(project.id);
            // Flatten dependencies from each task
            const deps: import('@dark-kitchen/core').TaskDependency[] = [];
            for (const task of tasks) {
              const taskDeps = await tracker.listDependencies(task.id);
              deps.push(...taskDeps);
            }
            return { tasks: [...tasks], dependencies: deps };
          },
          runWorkflowForTask: async (
            taskId: import('@dark-kitchen/core').TaskId,
            runId: import('@dark-kitchen/core').RunId,
          ) => {
            return executeWorkflow(
              taskId,
              runId,
              {
                databasePath: join(this.dataDir, 'store.db'),
                worktreesBaseDir,
                repositoryPath: this.options.projectRoot,
                repositoryId: repoId,
                targetBranch: scmConfig?.defaultBranch ?? 'main',
              },
              {
                workspaceManager,
                roleResolver,
                workflow: defaultWorkflow as never,
              },
            );
          },
          lifecycleOrchestrator,
          interventionService: this.interventionService,
        },
      );

      this.daemonLoop.start();
    }

    this.running = true;
    this.log('info', 'Daemon started', { pid: process.pid, dataDir: this.dataDir });

    // Graceful shutdown
    const shutdown = () => this.stop().catch(() => {});
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    this.shutdownCallbacks.push(() => {
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    });

    await this.writeState(databasePath);
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.log('info', 'Daemon shutting down gracefully');
    this.running = false;

    this.daemonLoop?.stop();
    this.channelGateway?.destroy();
    this.store?.close();

    for (const cb of this.shutdownCallbacks) await cb();
    this.shutdownCallbacks.length = 0;

    const lockPath = join(this.dataDir, 'daemon.lock');
    await rm(lockPath, { force: true }).catch(() => {});
    await rm(join(this.dataDir, 'daemon.state.json'), { force: true }).catch(() => {});

    this.log('info', 'Daemon stopped');
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getStore(): SqliteRuntimeStore | undefined {
    return this.store;
  }
  public getInterventionService(): InterventionService | undefined {
    return this.interventionService;
  }
  public getChannelGateway(): ChannelGateway | undefined {
    return this.channelGateway;
  }

  // ─── Private builders ──────────────────────────────────────────────────────

  private async buildTrackerAdapter(
    trackerConfig: NonNullable<DarkKitchenConfig['trackers']>[number],
  ): Promise<import('@dark-kitchen/tracker').FullTrackerAdapter> {
    const token = trackerConfig.tokenEnv ? (process.env[trackerConfig.tokenEnv] ?? '') : '';

    if (trackerConfig.kind === 'github-issues') {
      const { GitHubIssuesAdapter } = await import('@dark-kitchen/tracker');
      return new GitHubIssuesAdapter({
        owner: trackerConfig.owner ?? '',
        repo: trackerConfig.repo ?? '',
        token,
      });
    }
    if (trackerConfig.kind === 'linear') {
      const { LinearTrackerAdapter } = await import('@dark-kitchen/tracker');
      const linearConfig: import('@dark-kitchen/tracker').LinearAdapterConfig = { apiKey: token };
      if (trackerConfig.workspace)
        Object.assign(linearConfig, { teamKey: trackerConfig.workspace });
      return new LinearTrackerAdapter(linearConfig);
    }
    if (trackerConfig.kind === 'jira') {
      const { JiraTrackerAdapter } = await import('@dark-kitchen/tracker');
      return new JiraTrackerAdapter({
        baseUrl: trackerConfig.project ?? '',
        token,
        email: process.env['JIRA_EMAIL'] ?? '',
        projectKey: trackerConfig.project ?? '',
      });
    }
    throw new Error(`Unsupported tracker kind: ${(trackerConfig as { kind: string }).kind}`);
  }

  private async buildScmAdapter(
    scmConfig: NonNullable<DarkKitchenConfig['repositories']>[number],
  ): Promise<import('@dark-kitchen/scm').FullScmAdapter> {
    const token = scmConfig.tokenEnv ? (process.env[scmConfig.tokenEnv] ?? '') : '';
    const { GitHubScmAdapter } = await import('@dark-kitchen/scm');
    return new GitHubScmAdapter({ owner: scmConfig.owner, repo: scmConfig.repo, token });
  }

  private async buildRoleResolver(
    harnessProfile: NonNullable<DarkKitchenConfig['harnessProfiles']>[number] | undefined,
  ): Promise<import('@dark-kitchen/workflow-engine').RoleResolver> {
    const { AcpxRuntimeAdapter } = await import('@dark-kitchen/harness');

    const agent = harnessProfile?.managed === true ? (harnessProfile.kind ?? 'codex') : 'codex';
    const sessionStoreDir = join(this.dataDir, 'acpx-sessions');

    const runtime = new AcpxRuntimeAdapter({
      id: 'acpx',
      agent,
      sessionStoreDir,
      permissionMode: 'auto',
      timeoutMs: 300_000, // 5 minutes per turn
    });

    // Resolver: every role gets a real acpx call
    return (role: string) =>
      async (input: { prompt: string; context?: Record<string, unknown> }, signal: AbortSignal) => {
        return new Promise<string>((resolvePromise, reject) => {
          const sessionId =
            `acpx-role-${role}-${Date.now()}` as import('@dark-kitchen/core').AgentSessionId;
          let output = '';

          runtime.subscribe(
            sessionId as never,
            (event: { state: string; output?: string; error?: unknown }) => {
              if (event.output) output += event.output;
              if (event.state === 'completed') resolvePromise(output);
              if (event.state === 'failed')
                reject((event.error as Error | undefined) ?? new Error('acpx failed'));
              if (event.state === 'cancelled') reject(new Error('cancelled'));
            },
          );

          signal.addEventListener(
            'abort',
            () => {
              runtime.cancelSession(sessionId as never).catch(() => {});
              reject(new Error('cancelled'));
            },
            { once: true },
          );

          const sessionInput: import('@dark-kitchen/harness').StartSessionInput = {
            runId: 'daemon-run' as import('@dark-kitchen/core').RunId,
            taskId: role as import('@dark-kitchen/core').TaskId,
            workspaceId: process.cwd() as import('@dark-kitchen/core').WorkspaceId,
            profile: { managed: true, id: 'acpx', kind: agent },
            prompt: input.prompt,
          };
          if (input.context)
            Object.assign(sessionInput, { instructions: JSON.stringify(input.context) });
          runtime.startSession(sessionInput).catch(reject);
        });
      };
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private async acquireLock(lockPath: string): Promise<void> {
    try {
      const existing = await readFile(lockPath, 'utf8');
      const lockData = JSON.parse(existing) as { pid: number };
      try {
        process.kill(lockData.pid, 0);
        throw new Error(
          `Another Dark Kitchen daemon is already running (pid ${lockData.pid}). ` +
            `Stop it first with 'dk stop'.`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          // Stale lock
        } else {
          throw e;
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8',
    );
  }

  private async writeState(databasePath: string): Promise<void> {
    const state: DaemonState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectRoot: this.options.projectRoot,
      databasePath,
    };
    await writeFile(
      join(this.dataDir, 'daemon.state.json'),
      JSON.stringify(state, null, 2),
      'utf8',
    );
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const format = this.options.logFormat ?? 'human';
    if (format === 'json') {
      process.stderr.write(
        JSON.stringify({ level, message, ...meta, t: new Date().toISOString() }) + '\n',
      );
    } else {
      const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
      process.stderr.write(`[${level.toUpperCase()}] ${message}${metaStr}\n`);
    }
  }
}
