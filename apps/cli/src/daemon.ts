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
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import {
  InterventionService,
  RunSupervisor,
  PrLifecycleOrchestrator,
  DaemonLoop,
  executeWorkflow,
  ADEBridge,
  SseDashboardAdapter,
} from '@dark-kitchen/runtime';
import { ChannelGateway, UnifiedChannelTransport, interventionCode } from '@dark-kitchen/channels';
import type { UnifiedChannelConfig } from '@dark-kitchen/channels';
import { ConfigStore } from '@dark-kitchen/config';
import type { DarkKitchenConfig } from '@dark-kitchen/config';
import { createInterventionId, createTaskId } from '@dark-kitchen/core';
import { CapabilityService } from '@dark-kitchen/capabilities';
import {
  DurableVerificationService,
  parseVerificationRequirements,
} from '@dark-kitchen/verification';

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
  private config?: DarkKitchenConfig;
  private adeBridge?: ADEBridge;
  public dashboardPort?: number;
  private interventionService?: InterventionService;
  private channelGateway?: ChannelGateway;
  private daemonLoop?: DaemonLoop;
  private supervisor?: import('@dark-kitchen/runtime').RunSupervisor;
  private agentControls?: import('@dark-kitchen/runtime').AgentControlService;
  private tracker: import('@dark-kitchen/tracker').FullTrackerAdapter | undefined = undefined;
  private mcpHttpUrl?: string;
  private mcpHttpServer?: import('@dark-kitchen/mcp').McpHttpServer;
  private running = false;
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];
  private readonly runtimeAdapters = new Map<
    string,
    import('@dark-kitchen/harness').HarnessRuntime
  >();

  public constructor(options: DaemonOptions) {
    this.options = options;
    this.dataDir =
      options.dataDir ??
      process.env['DARK_KITCHEN_DATA_DIR'] ??
      join(options.projectRoot, '.dark-kitchen', 'runtime');
  }

  public async start(): Promise<void> {
    if (this.running) throw new Error('Daemon is already running');

    await mkdir(this.dataDir, { recursive: true });

    // Duplicate instance guard
    const lockPath = join(this.dataDir, 'daemon.lock');
    await this.acquireLock(lockPath);

    // 1. Load config
    try {
      const configStore = new ConfigStore({ projectRoot: this.options.projectRoot });
      this.config = await configStore.read();
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

    // Capability installers are deliberately separated from MCP. MCP can only
    // ask this service to plan, validate, or execute a previously approved
    // plan; it never receives direct process access.
    const capabilityService = new CapabilityService({
      statePath: join(this.dataDir, 'capabilities.json'),
      projectCapabilities: Object.fromEntries(
        (this.config?.capabilityProviders ?? [])
          .filter((provider) => provider.managed === false)
          .map((provider) => [
            provider.capability,
            {
              available:
                provider.capability === 'command.exec' ? provider.command !== undefined : true,
            },
          ]),
      ),
      approvalGateway: {
        requestApproval: async ({ planId, capabilityId, summary, details }) => {
          const intervention = await this.interventionService!.create({
            scope: 'task',
            targetId: createTaskId(`capability-plan:${planId}`),
            kind: 'approval',
            summary,
            details: `Plan ${planId} for ${capabilityId}\n${details}`,
            deduplicationKey: `capability-plan:${planId}`,
          });
          return intervention.id;
        },
        isApproved: async (approvalId, planId) => {
          const intervention = await this.interventionService!.get(
            createInterventionId(approvalId),
          );
          return (
            intervention?.status === 'resolved' &&
            intervention.kind === 'approval' &&
            intervention.details?.includes(`Plan ${planId}`) === true &&
            /Resolution \(approve(?:\s+by [^)]+)?\):/u.test(intervention.details)
          );
        },
      },
    });

    // 3b. ADE Bridge — start SSE dashboard on port 18800 (unless disabled)
    if (!process.env['DK_NO_DASHBOARD']) {
      const port = parseInt(process.env['DK_DASHBOARD_PORT'] ?? '18800', 10);
      this.adeBridge = new ADEBridge();
      const dashboard = new SseDashboardAdapter({ port });
      this.adeBridge.register(dashboard);
      dashboard.start();
      this.dashboardPort = port;
    }

    // 4. Channel Gateway — unified-channel (Telegram, Discord, Slack, iMessage, WhatsApp)
    this.channelGateway = new ChannelGateway({ correlationStore: this.store });
    const configuredChannels = this.config?.channels ?? [];
    const ucChannels = configuredChannels
      .filter((ch) => ['telegram', 'discord', 'slack', 'imessage', 'whatsapp'].includes(ch.kind))
      .map((ch) => {
        const ucCfg: UnifiedChannelConfig = { kind: ch.kind as UnifiedChannelConfig['kind'] };
        if (ch.tokenEnv) Object.assign(ucCfg, { tokenEnv: ch.tokenEnv });
        if (ch.token2Env) Object.assign(ucCfg, { token2Env: ch.token2Env });
        if (ch.defaultTarget) Object.assign(ucCfg, { defaultTarget: ch.defaultTarget });
        if (ch.allowedSenderIds) {
          Object.assign(ucCfg, { allowedSenderIds: ch.allowedSenderIds });
        }
        if (ch.telegramMode) Object.assign(ucCfg, { telegramMode: ch.telegramMode });
        if (ch.url) Object.assign(ucCfg, { telegramWebhookUrl: ch.url });
        if (ch.webhookPort) Object.assign(ucCfg, { telegramWebhookPort: ch.webhookPort });
        if (ch.webhookPath) Object.assign(ucCfg, { telegramWebhookPath: ch.webhookPath });
        if (ch.webhookSecretEnv) {
          const secret = process.env[ch.webhookSecretEnv];
          if (secret) Object.assign(ucCfg, { telegramWebhookSecret: secret });
        }
        return ucCfg;
      });

    if (ucChannels.length > 0) {
      const transport = new UnifiedChannelTransport({ id: 'messaging', channels: ucChannels });
      this.channelGateway.addTransport(transport);

      this.channelGateway.onInterventionReply(async (interventionId, reply) => {
        const requestedAction = reply.actionValue ?? reply.body;
        const lower = requestedAction.trim().toLowerCase();
        const switchMatch = /^switch-harness(?::|\s)+([^\s]+)$/u.exec(lower);
        const action =
          lower === 'stop' || lower === 'cancel'
            ? 'stop'
            : lower === 'retry'
              ? 'retry'
              : lower === 'approve'
                ? 'approve'
                : switchMatch
                  ? 'switch-harness'
                  : 'free-text';

        const resolveInput: Parameters<NonNullable<typeof this.interventionService>['resolve']>[0] =
          { interventionId, action, answer: reply.body };
        if (reply.senderId) Object.assign(resolveInput, { resolvedBy: reply.senderId });

        let resolved:
          | Awaited<ReturnType<NonNullable<typeof this.interventionService>['resolve']>>
          | undefined;
        try {
          resolved = await this.interventionService?.resolve(resolveInput);
        } catch (err) {
          // Already resolved/dismissed (e.g. a spurious extra reply) — ignore.
          this.log('warn', `Could not resolve intervention ${interventionId}: ${String(err)}`);
        }

        try {
          if (resolved) {
            await this.applyInterventionResolution({
              scope: resolved.scope,
              targetId: resolved.targetId,
              kind: resolved.kind,
              ...(resolved.details ? { details: resolved.details } : {}),
              action,
              answer: switchMatch?.[1] ?? reply.body,
            });
          }
        } catch (error) {
          this.log(
            'warn',
            `Intervention ${interventionId} resolved but runtime control failed: ${String(error)}`,
          );
          if (resolved) {
            await this.interventionService?.create({
              scope: resolved.scope,
              targetId: resolved.targetId,
              kind: 'agent-failure',
              summary: `The requested ${action} control could not be applied: ${String(error)}`,
              deduplicationKey: `control-failed:${interventionId}:${action}`,
            });
          }
        }
      });

      // Notify every configured channel when an intervention is created.
      this.interventionService.subscribe(async (event) => {
        if (event.type !== 'intervention.created') return;
        const intervention = await this.interventionService?.get(event.payload.interventionId);
        if (!intervention) return;
        for (const ch of configuredChannels) {
          await this.channelGateway?.notify({
            address: { channel: ch.kind, conversationId: ch.defaultTarget ?? '' },
            body: formatInterventionNotification(intervention),
            actions: interventionActions(intervention),
            interventionId: intervention.id,
          });
        }
      });

      transport.start().catch((err: unknown) => {
        this.log('warn', `Channel transport start failed: ${String(err)}`);
      });
      this.log('info', `Channels: ${ucChannels.map((c) => c.kind).join(', ')}`);
    }

    // 5. Tracker adapter
    const trackerConfig = this.config?.trackers?.[0];
    let tracker: import('@dark-kitchen/tracker').FullTrackerAdapter | undefined;
    if (trackerConfig) {
      tracker = await this.buildTrackerAdapter(trackerConfig);
    }
    this.tracker = tracker;

    const trackerControls = tracker
      ? {
          getGraph: async (requestedProjectId: string) => {
            const tasks = await tracker.listTasks(
              requestedProjectId as import('@dark-kitchen/core').ProjectId,
            );
            const dependencies: import('@dark-kitchen/core').TaskDependency[] = [];
            for (const task of tasks) {
              dependencies.push(...(await tracker.listDependencies(task.id)));
            }
            return { projectId: requestedProjectId, tasks, dependencies };
          },
          listComments: async (taskId: string) => tracker.listComments(createTaskId(taskId)),
          setAutonomousApproval: async (taskId: string, approved: boolean) =>
            tracker.setAutonomousApproval(createTaskId(taskId), approved),
        }
      : undefined;

    const verificationService = new DurableVerificationService({
      statePath: join(this.dataDir, 'verification.json'),
      profiles: this.config?.verificationProfiles ?? [],
      ...(tracker
        ? {
            getTaskDescription: async (taskId: import('@dark-kitchen/core').TaskId) =>
              (await tracker.getTaskById(taskId))?.description,
          }
        : {}),
    });

    // 5b. Control-plane services (supervisor + agent controls) are created
    //     here — BEFORE the MCP server — because the PM MCP tools (stop,
    //     restart, pause, instruct agents) need them. The harness adapters
    //     they operate on are registered lazily by the role resolver below.
    const projectId = `default-project` as import('@dark-kitchen/core').ProjectId;
    const supervisor = new RunSupervisor(
      {
        maxParallelTasks: this.config?.concurrency?.maxParallelTasks ?? 4,
        projectId,
      },
      async (taskId: import('@dark-kitchen/core').TaskId) => {
        return `run-${taskId}-${Date.now()}` as import('@dark-kitchen/core').RunId;
      },
    );
    this.supervisor = supervisor;

    const { DefaultAgentControlService } = await import('@dark-kitchen/runtime');
    this.agentControls = new DefaultAgentControlService({
      store: this.store,
      resolveRuntime: (runtimeId) =>
        [...this.runtimeAdapters.values()].find((runtime) => runtime.id === runtimeId),
      resolveProfile: (profileId) => {
        const profile = this.config?.harnessProfiles?.find(
          (candidate) => candidate.id === profileId,
        );
        const runtime = profile
          ? [...this.runtimeAdapters.values()].find((candidate) => candidate.kind === profile.kind)
          : undefined;
        if (!profile || !runtime) return undefined;
        return {
          profile: profile as import('@dark-kitchen/harness').HarnessProfile,
          runtime,
          ...(profile.managed && profile.model ? { model: profile.model } : {}),
          ...(profile.managed && profile.reasoning ? { reasoning: profile.reasoning } : {}),
        };
      },
      reportRuntimeFailure: async (failure) => {
        await this.interventionService?.create({
          scope: 'agent',
          targetId: failure.sessionId,
          kind: failure.kind,
          summary: failure.summary,
          deduplicationKey: `runtime-failure:${failure.sessionId}:${failure.kind}`,
        });
      },
    });

    // 5c. MCP server (Streamable HTTP) so coding agents can call `dk_ask_human`
    //     and the PM (chatgpt-pm) can manage tasks, runs, and agents through
    //     the control plane. Runs in-process so it can reach the intervention
    //     service, tracker, channels, supervisor, and agent controls.
    {
      const { startMcpHttpServer } = await import('@dark-kitchen/mcp');
      this.mcpHttpServer = await startMcpHttpServer(
        {
          interventionService: this.interventionService,
          ...(tracker ? { tracker } : {}),
          ...(this.config ? { config: this.config } : {}),
          configPath: join(this.options.projectRoot, '.dark-kitchen', 'config.yaml'),
          ...(this.store ? { store: this.store } : {}),
          ...(supervisor ? { supervisor } : {}),
          ...(this.agentControls ? { agentControls: this.agentControls } : {}),
          ...(this.agentControls ? { runtimeControls: this.agentControls } : {}),
          interventionResolutionControls: {
            apply: (input) => this.applyInterventionResolution(input),
          },
          ...(trackerControls ? { trackerControls } : {}),
          capabilities: capabilityService,
          verification: verificationService,
        },
        { port: parseInt(process.env['DK_MCP_PORT'] ?? '18801', 10) },
      );
      this.mcpHttpUrl = this.mcpHttpServer.url;
      this.log('info', `MCP (agents + PM): ${this.mcpHttpUrl}`);
    }

    // 6. SCM adapter
    const scmConfig = this.config?.repositories?.[0];
    let scm: import('@dark-kitchen/scm').FullScmAdapter | undefined;
    if (scmConfig && scmConfig.kind === 'github') {
      scm = await this.buildScmAdapter(scmConfig);
    }

    // 7. Harness runtime (acpx)
    const harnessProfile = this.config?.harnessProfiles?.find((h) => h.managed === true);
    const roleResolver = await this.buildRoleResolver(harnessProfile);

    // 8. Workspace manager
    const { GitWorktreeManager } = await import('@dark-kitchen/workspace-manager');
    const worktreesBaseDir = join(this.dataDir, 'worktrees');
    const workspaceManager = new GitWorktreeManager({
      repositoryPath: this.options.projectRoot,
      worktreesBaseDir,
    });

    // 9/10. Workflow selection happens per normalized task below. Supervisor
    //       and agent controls are already available to MCP before execution.

    // 10. (Moved above — supervisor + agent controls are built before the MCP
    //     server so the PM control-plane tools can use them.)

    // 11. PR lifecycle orchestrator
    if (tracker && scm) {
      const lifecycleOrchestrator = new PrLifecycleOrchestrator(scm, tracker);
      const repoId =
        `github:${scmConfig?.owner}/${scmConfig?.repo}` as import('@dark-kitchen/core').RepositoryId;

      // The token is passed to git through the child environment by the
      // workflow executor. It never appears in a remote URL or argv.
      const scmToken = scmConfig?.tokenEnv ? (process.env[scmConfig.tokenEnv] ?? '') : '';

      // 12. Main daemon polling loop
      this.daemonLoop = new DaemonLoop(
        {
          pollIntervalMs: 30_000,
          projectId,
          repositoryId: repoId,
          targetBranch: scmConfig?.defaultBranch ?? 'main',
          requiredChecks: this.config?.mergePolicy?.requiredChecks ?? [],
          autoMerge:
            this.config?.mergePolicy !== undefined &&
            this.config?.mergePolicy?.requireApproval !== true,
          deleteHeadBranchAfterMerge: this.config?.mergePolicy?.deleteHeadBranchAfterMerge ?? true,
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
            task: import('@dark-kitchen/core').Task,
            runId: import('@dark-kitchen/core').RunId,
          ) => {
            const priorRun = await this.store?.getRun(runId);
            const run = await this.recordRun(runId, task, 'running', priorRun);
            const workflowsPackage = await import('@dark-kitchen/workflows');
            try {
              const verificationRequirements = parseVerificationRequirements(
                task.description ?? '',
              );
              if (verificationRequirements.length > 1) {
                throw new Error(
                  'The built-in workflow currently accepts one Verification profile per task.',
                );
              }
              const verificationProfileId = verificationRequirements[0]?.profileId;
              const verificationProfile = this.config?.verificationProfiles?.find(
                (profile) => profile.id === verificationProfileId,
              );
              if (verificationProfileId && !verificationProfile) {
                throw new Error(
                  `Task requests unconfigured verification profile ${verificationProfileId}.`,
                );
              }
              const capabilityStates: unknown[] = [];
              const requiredCapabilityIds = new Set([
                ...(verificationProfile?.requiredCapabilities ?? []),
                ...(verificationProfile?.tools ?? []),
              ]);
              for (const capabilityReference of requiredCapabilityIds) {
                const capability = await capabilityService.inspect({
                  capabilityId: capabilityReference,
                });
                capabilityStates.push(capability);
                if (capability.state !== 'available') {
                  throw new Error(
                    `Verification capability ${capability.capabilityId} is ${capability.state}: ${capability.message}`,
                  );
                }
              }
              const projectVerificationCommands = [...requiredCapabilityIds].flatMap(
                (capabilityId) => {
                  const provider = this.config?.capabilityProviders?.find(
                    (candidate) =>
                      candidate.managed === false &&
                      candidate.capability === capabilityId &&
                      candidate.command !== undefined,
                  );
                  return provider?.managed === false && provider.command ? [provider.command] : [];
                },
              );
              const selectedWorkflowConfig = workflowsPackage.selectWorkflowForTask(
                this.config?.workflows ?? [],
                {
                  id: String(task.id),
                  title: task.title,
                  ...(task.description ? { description: task.description } : {}),
                  ...(task.labels ? { labels: task.labels } : {}),
                  status: task.status,
                  verificationProfileIds: verificationRequirements.map(
                    (requirement) => requirement.profileId,
                  ),
                },
              );
              const loadedWorkflow = await this.loadWorkflow(selectedWorkflowConfig);
              let selectedWorkflow = loadedWorkflow.workflow;
              if (selectedWorkflowConfig?.builtin === 'design-frontend') {
                selectedWorkflow = workflowsPackage.createDesignFrontendWorkflow({
                  task: {
                    id: String(task.id),
                    title: task.title,
                    ...(task.description ? { description: task.description } : {}),
                  },
                  ...(verificationProfileId ? { verificationProfileId } : {}),
                  ...(verificationProfile?.retryPolicy
                    ? {
                        maxVerificationFixCycles: Math.max(
                          0,
                          verificationProfile.retryPolicy.maxAttempts - 1,
                        ),
                        verificationRetryDelayMs:
                          verificationProfile.retryPolicy.delaySeconds * 1000,
                      }
                    : {}),
                }) as never;
              } else if (selectedWorkflowConfig?.builtin === 'high-risk') {
                selectedWorkflow = workflowsPackage.createHighRiskWorkflow({
                  task: {
                    id: String(task.id),
                    title: task.title,
                    ...(task.description ? { description: task.description } : {}),
                  },
                  approvalGate: {
                    request: async (request) => {
                      const intervention = await this.interventionService!.create({
                        scope: 'task',
                        targetId: task.id,
                        kind:
                          request.kind === 'destructive-change-approval'
                            ? 'destructive-action'
                            : 'approval',
                        summary: request.summary,
                        details: [
                          `Workflow gate ${request.gateId}`,
                          request.details,
                          `Requested actions: ${request.requestedActions.join('; ')}`,
                        ].join('\n'),
                        deduplicationKey: `workflow-gate:${request.gateId}`,
                      });
                      if (
                        intervention.status === 'open' ||
                        intervention.status === 'acknowledged'
                      ) {
                        return { status: 'pending' as const, interventionId: intervention.id };
                      }
                      const details = intervention.details ?? '';
                      const approved = /Resolution \(approve(?:\s+by [^)]+)?\):/u.test(details);
                      const resolvedBy = /Resolution \([^)]*\sby ([^)]+)\):/u.exec(details)?.[1];
                      return approved
                        ? {
                            status: 'approved' as const,
                            interventionId: intervention.id,
                            ...(resolvedBy ? { resolvedBy } : {}),
                          }
                        : {
                            status: 'rejected' as const,
                            interventionId: intervention.id,
                            ...(resolvedBy ? { resolvedBy } : {}),
                            note: 'The human did not approve this high-risk workflow gate.',
                          };
                    },
                  },
                  ...(verificationProfileId ? { verificationProfileId } : {}),
                  ...(verificationProfile?.retryPolicy
                    ? {
                        maxVerificationFixCycles: Math.max(
                          0,
                          verificationProfile.retryPolicy.maxAttempts - 1,
                        ),
                        verificationRetryDelayMs:
                          verificationProfile.retryPolicy.delaySeconds * 1000,
                      }
                    : {}),
                }) as never;
              } else if (verificationProfileId && !loadedWorkflow.custom) {
                selectedWorkflow = workflowsPackage.createWorkflowWithVerification({
                  ...(verificationProfile?.retryPolicy
                    ? {
                        maxVerificationFixCycles: Math.max(
                          0,
                          verificationProfile.retryPolicy.maxAttempts - 1,
                        ),
                        verificationRetryDelayMs:
                          verificationProfile.retryPolicy.delaySeconds * 1000,
                      }
                    : {}),
                }) as never;
              }
              const output = await executeWorkflow(
                {
                  id: task.id,
                  title: task.title,
                  ...(task.description ? { description: task.description } : {}),
                },
                runId,
                {
                  databasePath: join(this.dataDir, 'store.db'),
                  worktreesBaseDir,
                  repositoryPath: this.options.projectRoot,
                  repositoryId: repoId,
                  targetBranch: scmConfig?.defaultBranch ?? 'main',
                  ...(scmToken ? { pushToken: scmToken } : {}),
                  ...(verificationProfileId ? { verificationProfileId } : {}),
                  ...(verificationProfile?.verifierRoleId
                    ? { verificationRoleId: verificationProfile.verifierRoleId }
                    : {}),
                  ...(verificationProfile
                    ? {
                        verificationBlocking: verificationProfile.blocking,
                        verificationResources: {
                          ...(verificationProfile.skills
                            ? { skills: verificationProfile.skills }
                            : {}),
                          ...(verificationProfile.mcpServers
                            ? { mcpServers: verificationProfile.mcpServers }
                            : {}),
                          ...(verificationProfile.tools
                            ? { tools: verificationProfile.tools }
                            : {}),
                        },
                        verificationEnvironment: {
                          ...(verificationProfile.environmentSetup
                            ? { setup: verificationProfile.environmentSetup }
                            : {}),
                          ...(verificationProfile.environmentHealthcheck
                            ? {
                                healthcheck: [
                                  ...verificationProfile.environmentHealthcheck,
                                  ...projectVerificationCommands,
                                ],
                              }
                            : projectVerificationCommands.length > 0
                              ? { healthcheck: projectVerificationCommands }
                              : {}),
                          ...(verificationProfile.environmentTeardown
                            ? { teardown: verificationProfile.environmentTeardown }
                            : {}),
                          ...(verificationProfile.timeoutSeconds
                            ? {
                                defaultCommandTimeoutMs: verificationProfile.timeoutSeconds * 1000,
                              }
                            : {}),
                        },
                        ...(verificationProfile.timeoutSeconds
                          ? { verificationTimeoutMs: verificationProfile.timeoutSeconds * 1000 }
                          : {}),
                      }
                    : {}),
                  ...(verificationProfile && verificationRequirements[0]
                    ? {
                        verificationContext: {
                          requirement: verificationRequirements[0],
                          profile: verificationProfile,
                          capabilityStates,
                        },
                      }
                    : {}),
                },
                {
                  workspaceManager,
                  roleResolver,
                  workflow: selectedWorkflow as never,
                },
              );
              for (const proof of output.verificationResults ?? []) {
                const verificationRun = await verificationService.request({
                  taskId: task.id,
                  profileId: proof.profileId,
                });
                const activeRun =
                  verificationRun.state === 'pending'
                    ? await verificationService.markRunning(verificationRun.id)
                    : verificationRun;
                if (activeRun.state === 'running') {
                  await verificationService.complete(activeRun.id, {
                    state:
                      proof.status === 'passed'
                        ? 'passed'
                        : proof.status === 'failed'
                          ? 'failed'
                          : 'blocked',
                    criterionResults: [
                      {
                        criterionName: 'workflow-verifier',
                        status:
                          proof.status === 'passed'
                            ? 'pass'
                            : proof.status === 'failed'
                              ? 'fail'
                              : 'blocked',
                        ...(proof.summary ? { message: proof.summary } : {}),
                        ...(proof.evidenceRefs.length > 0
                          ? {
                              evidence: proof.evidenceRefs.map((artifactRef, index) => ({
                                id: `${activeRun.id}-evidence-${String(index + 1)}`,
                                kind: 'artifact' as const,
                                name: `verification-evidence-${String(index + 1)}`,
                                artifactRef,
                                capturedAt: new Date().toISOString(),
                              })),
                            }
                          : {}),
                      },
                    ],
                  });
                }
              }
              await this.recordRun(runId, task, output.success ? 'completed' : 'failed', run);
              return output;
            } catch (err) {
              if (err instanceof workflowsPackage.WorkflowInterventionRequired) {
                await this.recordRun(runId, task, 'waiting', run);
                throw err;
              }
              await this.recordRun(runId, task, 'failed', run);
              throw err;
            }
          },
          lifecycleOrchestrator,
          interventionService: this.interventionService,
          releaseWorktree: async (taskId) => {
            const workspace = await workspaceManager.getPrimaryWorktree(taskId);
            if (!workspace) return;
            workspaceManager.markCompleted(workspace.id);
            await workspaceManager.releaseWorkspace(workspace.id);
          },
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

  // ─── Run / session persistence helpers ────────────────────────────────────

  private async applyInterventionResolution(input: {
    readonly scope: 'task' | 'run' | 'agent';
    readonly targetId: string;
    readonly kind: string;
    readonly details?: string;
    readonly action: 'retry' | 'switch-harness' | 'approve' | 'stop' | 'free-text';
    readonly answer?: string;
  }): Promise<void> {
    if (input.scope === 'task') {
      // Capability-plan approvals are consumed by ensureManaged(planId,
      // approvalId). They are not scheduler tasks.
      if (input.targetId.startsWith('capability-plan:')) return;
      // A live askHuman call polls the durable intervention and continues with
      // the answer itself. Its synthetic task id must never be sent upstream.
      if (input.targetId.startsWith('manual-ask-')) return;
      const taskId = input.targetId as import('@dark-kitchen/core').TaskId;
      if (
        input.action === 'retry' ||
        input.action === 'free-text' ||
        (input.action === 'approve' && input.details?.includes('Workflow gate'))
      ) {
        this.supervisor?.retryTask(taskId);
        await this.tracker?.updateTask(taskId, { status: 'ready' });
      } else if (input.action === 'stop') {
        this.supervisor?.stopTask(taskId);
        await this.tracker?.setBlocked(taskId);
      }
      return;
    }

    if (!this.agentControls) {
      throw new Error('Agent control service is unavailable.');
    }
    if (input.scope === 'agent') {
      const sessionId = input.targetId as import('@dark-kitchen/core').AgentSessionId;
      if (input.action === 'retry') {
        await this.agentControls.retrySession(sessionId);
      } else if (input.action === 'stop') {
        await this.agentControls.stopSession(sessionId);
      } else if (input.action === 'switch-harness') {
        const profileId = input.answer?.replace(/^switch-harness(?::|\s)+/iu, '').trim();
        if (!profileId) throw new Error('switch-harness requires a harness profile ID.');
        await this.agentControls.switchAgentProfile(sessionId, profileId);
      } else if (input.answer?.trim()) {
        await this.agentControls.sendInstruction(sessionId, input.answer.trim());
      }
      return;
    }

    if (input.action === 'retry') {
      await this.agentControls.retryRun(input.targetId);
    } else if (input.action === 'stop') {
      await this.agentControls.pauseRun(input.targetId);
    } else if (input.action === 'approve' || input.action === 'free-text') {
      await this.agentControls.resumeRun(input.targetId);
    }
  }

  private async recordRun(
    runId: import('@dark-kitchen/core').RunId,
    task: import('@dark-kitchen/core').Task,
    state: import('@dark-kitchen/core').RunState,
    prior?: import('@dark-kitchen/core').Run,
  ): Promise<import('@dark-kitchen/core').Run> {
    const now = new Date().toISOString();
    const runBase = {
      id: runId,
      projectId: `default-project` as import('@dark-kitchen/core').ProjectId,
      taskId: task.id,
      state,
      executionNodeIds: prior?.executionNodeIds ?? [],
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    const run: import('@dark-kitchen/core').Run = {
      ...runBase,
      ...(prior?.workspaceId ? { workspaceId: prior.workspaceId } : {}),
      ...(state === 'completed' || state === 'failed' ? { completedAt: now } : {}),
    };
    await this.store?.saveRun(run).catch(() => {});
    this.log('info', `Run ${runId} → ${state}`);

    if (state === 'running') {
      const workflowRunId =
        `workflow-run-${task.id}-${Date.now()}` as import('@dark-kitchen/core').WorkflowRunId;
      const graphId = `task-graph-${task.id}` as import('@dark-kitchen/core').TaskGraphId;
      await this.store
        ?.saveWorkflowRun({
          id: workflowRunId,
          projectId: `default-project` as import('@dark-kitchen/core').ProjectId,
          taskGraphId: graphId,
          state: 'running',
          runIds: [runId],
          createdAt: now,
          updatedAt: now,
        })
        .catch(() => {});
    }
    return run;
  }

  private async updateSessionState(
    sessionId: import('@dark-kitchen/core').AgentSessionId,
    state: import('@dark-kitchen/core').AgentSessionState,
  ): Promise<void> {
    const existing = await this.store?.getAgentSession(sessionId);
    if (!existing) return;
    const now = new Date().toISOString();
    await this.store
      ?.saveAgentSession({
        ...existing,
        state,
        updatedAt: now,
        ...(state === 'completed' || state === 'failed' || state === 'stopped'
          ? { completedAt: now }
          : {}),
      })
      .catch(() => {});
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.log('info', 'Daemon shutting down gracefully');
    this.running = false;

    this.daemonLoop?.stop();
    this.channelGateway?.destroy();
    await this.adeBridge?.destroy();
    await this.mcpHttpServer?.close();
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

  /**
   * Load the workflow to execute. Uses `workflows[0].file` from config when
   * present (a `.ts`/`.js` module exporting a workflow function as `default`,
   * `workflow`, or `defaultWorkflow`), otherwise the built-in default.
   */
  private async loadWorkflow(
    workflowConfig?: NonNullable<DarkKitchenConfig['workflows']>[number],
  ): Promise<{
    readonly workflow: import('@dark-kitchen/workflow-engine').WorkflowFn<never>;
    readonly custom: boolean;
  }> {
    const { defaultWorkflow } = await import('@dark-kitchen/workflows');

    if (workflowConfig?.builtin === 'default') {
      return { workflow: defaultWorkflow as never, custom: false };
    }
    const workflowFile = workflowConfig?.file;
    if (!workflowFile) return { workflow: defaultWorkflow as never, custom: false };

    const workflowRoot = resolve(this.options.projectRoot, '.dark-kitchen', 'workflows');
    const filePath = resolve(this.options.projectRoot, workflowFile);
    if (filePath !== workflowRoot && !filePath.startsWith(`${workflowRoot}${sep}`)) {
      throw new Error(`Workflow file must stay inside ${workflowRoot}: ${workflowFile}`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { createJiti } = (await import('jiti')) as any;
        const jiti = createJiti(import.meta.url);
        mod = await jiti.import(filePath);
      } else {
        mod = await import(pathToFileURL(filePath).href);
      }
      const fn = mod?.default ?? mod?.workflow ?? mod?.defaultWorkflow;
      if (typeof fn === 'function') {
        this.log('info', `Workflow: ${workflowFile}`);
        return { workflow: fn as never, custom: true };
      }
      throw new Error(`Workflow file ${workflowFile} does not export a workflow function`);
    } catch (err) {
      throw new Error(`Failed to load configured workflow ${workflowFile}`, { cause: err });
    }
  }

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
    _harnessProfile: NonNullable<DarkKitchenConfig['harnessProfiles']>[number] | undefined,
  ): Promise<import('@dark-kitchen/workflow-engine').RoleResolver> {
    void _harnessProfile;
    const { AcpxRuntimeAdapter, RoleRouter, UnsupportedCapabilityError } = await import(
      '@dark-kitchen/harness'
    );

    const allProfiles = this.config?.harnessProfiles ?? [];
    const allRoles = this.config?.roles ?? [];
    const allVerificationProfiles = this.config?.verificationProfiles ?? [];

    // Always inject Dark Kitchen's own MCP server so agents can call
    // `dk_ask_human` (and other control-plane tools).
    const daemonMcpServers = this.mcpHttpUrl
      ? [
          {
            name: 'dark-kitchen',
            url: this.mcpHttpUrl,
            type: 'http' as const,
            always: true,
          },
        ]
      : [];

    const runtimes: import('@dark-kitchen/harness').HarnessRuntime[] = [];
    for (const kind of new Set(allProfiles.map((profile) => profile.kind))) {
      const profilesForKind = allProfiles.filter((profile) => profile.kind === kind);
      let runtime: import('@dark-kitchen/harness').HarnessRuntime;
      if (kind === 'deepseek-harness') {
        if (profilesForKind.some((profile) => profile.managed)) {
          throw new Error(
            'deepseek-harness must use a user-managed profile; Dark Kitchen preserves DSH_HOME, plugins, credentials, and profile configuration.',
          );
        }
        // A literal first-party import is intentional: it is bundled into the
        // public CLI. Arbitrary third-party plugins still go through the
        // explicit allowlist loader in @dark-kitchen/harness.
        const { harnessPlugin } = await import('@dark-kitchen/harness-deepseek');
        runtime = harnessPlugin.create({
          id: 'deepseek-harness',
          kind: 'deepseek-harness',
          executable: process.env['DSH_EXECUTABLE'] ?? 'dsh',
        });
      } else {
        const configuredMcpServers = profilesForKind.flatMap((profile) =>
          profile.managed ? (profile.mcpServers ?? []) : [],
        );
        for (const role of allRoles) {
          if (profilesForKind.some((profile) => profile.id === role.harnessProfileId)) {
            configuredMcpServers.push(...(role.overrides?.mcpServers ?? []));
          }
        }
        for (const verificationProfile of allVerificationProfiles) {
          const verifierRoleId = verificationProfile.verifierRoleId ?? 'verifier';
          const verifierRole = allRoles.find((role) => role.id === verifierRoleId);
          const verifierHarnessProfile = profilesForKind.find(
            (profile) => profile.id === verifierRole?.harnessProfileId,
          );
          if (verifierHarnessProfile?.managed) {
            configuredMcpServers.push(...(verificationProfile.mcpServers ?? []));
          }
        }
        const uniqueMcpServers = [...new Set(configuredMcpServers)].map((url, index) => ({
          name: `configured-${String(index + 1)}`,
          url,
          type: 'http' as const,
        }));
        runtime = new AcpxRuntimeAdapter({
          id: `acpx:${kind}`,
          agent: kind,
          sessionStoreDir: join(this.dataDir, 'acpx-sessions'),
          permissionMode: 'auto',
          mcpServers: [...daemonMcpServers, ...uniqueMcpServers],
        });
      }
      runtimes.push(runtime);
      this.runtimeAdapters.set(kind, runtime);
    }

    const roleDefinitions = allRoles.map((role) => {
      const definition: import('@dark-kitchen/harness').RoleDefinition = {
        roleId: role.id,
        profileId: role.harnessProfileId,
      };
      if (role.overrides?.model) Object.assign(definition, { modelOverride: role.overrides.model });
      if (role.overrides?.reasoning) {
        Object.assign(definition, { reasoningOverride: role.overrides.reasoning });
      }
      if (role.overrides?.instructions) {
        Object.assign(definition, { instructionsOverride: role.overrides.instructions });
      }
      if (role.overrides?.skills) {
        Object.assign(definition, { skillsOverride: role.overrides.skills });
      }
      if (role.overrides?.mcpServers) {
        Object.assign(definition, { mcpServersOverride: role.overrides.mcpServers });
      }
      if (role.overrides?.plugins) {
        Object.assign(definition, { pluginsOverride: role.overrides.plugins });
      }
      return definition;
    });
    const router = new RoleRouter({
      roles: roleDefinitions,
      profiles: allProfiles as readonly import('@dark-kitchen/harness').HarnessProfile[],
      runtimes,
    });
    const routingErrors = router.validateAll();
    for (const verificationProfile of allVerificationProfiles) {
      try {
        const verifier = router.resolve(verificationProfile.verifierRoleId ?? 'verifier');
        if (
          (verificationProfile.skills?.length ?? 0) > 0 &&
          !verifier.runtime.capabilities.supported.has('skills.custom')
        ) {
          throw new UnsupportedCapabilityError('skills.custom', verifier.runtime.id);
        }
        if (
          (verificationProfile.mcpServers?.length ?? 0) > 0 &&
          !verifier.runtime.capabilities.supported.has('skills.mcp')
        ) {
          throw new UnsupportedCapabilityError('skills.mcp', verifier.runtime.id);
        }
      } catch (error) {
        routingErrors.push(
          `Verification profile "${verificationProfile.id}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (routingErrors.length > 0) {
      throw new Error(`Invalid harness routing:\n- ${routingErrors.join('\n- ')}`);
    }

    // Resolver: semantic workflows never inspect model/provider identifiers.
    // Missing roles and unsupported overrides fail before starting an agent.
    return (role: string) => {
      const resolved = router.resolve(role);
      return async (
        input: {
          prompt: string;
          context?: Record<string, unknown>;
          workspacePath?: string;
          runId?: string;
          taskId?: string;
          runtimeResources?: {
            skills?: readonly string[];
            mcpServers?: readonly string[];
            tools?: readonly string[];
          };
        },
        signal: AbortSignal,
      ) => {
        if (signal.aborted) throw new Error('cancelled');
        const runtime = resolved.runtime;
        const managedProfile = resolved.profile.managed ? resolved.profile : undefined;
        const instructions = resolved.instructionsOverride ?? managedProfile?.instructions;
        const model = resolved.modelOverride ?? managedProfile?.model;
        const reasoning = resolved.reasoningOverride ?? managedProfile?.reasoning;
        const resources = {
          skills: [
            ...new Set([
              ...(resolved.skillsOverride ?? managedProfile?.skills ?? []),
              ...(input.runtimeResources?.skills ?? []),
            ]),
          ],
          mcpServers: [
            ...new Set([
              ...(resolved.mcpServersOverride ?? managedProfile?.mcpServers ?? []),
              ...(input.runtimeResources?.mcpServers ?? []),
            ]),
          ],
          tools: [...new Set(input.runtimeResources?.tools ?? [])],
        };
        if (
          resolved.profile.managed === false &&
          (resources.skills.length > 0 || resources.mcpServers.length > 0)
        ) {
          throw new Error(
            `Role "${role}" uses user-managed harness profile "${resolved.profile.id}"; ` +
              'verification skills/MCP must be configured in that harness rather than injected by Dark Kitchen.',
          );
        }
        if (
          resources.skills.length > 0 &&
          !resolved.runtime.capabilities.supported.has('skills.custom')
        ) {
          throw new UnsupportedCapabilityError('skills.custom', resolved.runtime.id);
        }
        if (
          resources.mcpServers.length > 0 &&
          !resolved.runtime.capabilities.supported.has('skills.mcp')
        ) {
          throw new UnsupportedCapabilityError('skills.mcp', resolved.runtime.id);
        }
        const sessionInput: import('@dark-kitchen/harness').StartSessionInput = {
          runId: (input.runId ?? 'daemon-run') as import('@dark-kitchen/core').RunId,
          taskId: (input.taskId ?? role) as import('@dark-kitchen/core').TaskId,
          workspaceId: (input.workspacePath ??
            process.cwd()) as import('@dark-kitchen/core').WorkspaceId,
          profile: resolved.profile,
          prompt: [
            input.prompt,
            input.context ? `Context: ${JSON.stringify(input.context)}` : undefined,
          ]
            .filter(Boolean)
            .join('\n\n'),
          ...(model ? { model } : {}),
          ...(reasoning ? { reasoning } : {}),
          resources,
        };
        if (instructions) Object.assign(sessionInput, { instructions });

        // Start the session first so we can subscribe to the *returned* session
        // id (the adapter generates its own id internally). Subscribing to a
        // pre-guessed id would never receive any events.
        const session = await runtime.startSession(sessionInput);

        // Persist the session record so the PM control plane can list it.
        const sessionId = session.id as import('@dark-kitchen/core').AgentSessionId;
        const execTaskId = (input.taskId ?? role) as import('@dark-kitchen/core').TaskId;
        const executionNodeId =
          `exec-node-${input.runId ?? 'daemon-run'}-${execTaskId}` as import('@dark-kitchen/core').ExecutionNodeId;
        const sessionRecord: import('@dark-kitchen/core').AgentSession = {
          id: sessionId,
          runId: (input.runId ?? 'daemon-run') as import('@dark-kitchen/core').RunId,
          taskId: execTaskId,
          executionNodeId,
          workspaceId: (input.workspacePath ??
            process.cwd()) as import('@dark-kitchen/core').WorkspaceId,
          state: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (!this.agentControls) {
          await runtime.stopSession(sessionId).catch(() => undefined);
          throw new Error('Agent control service is unavailable; refusing an untracked session.');
        }
        try {
          await this.agentControls.registerSession({
            session: sessionRecord,
            runtime,
            profile: resolved.profile,
            initialPrompt: sessionInput.prompt,
            roleId: role,
            ...(model ? { model } : {}),
            ...(reasoning ? { reasoning } : {}),
          });
        } catch (error) {
          await runtime.stopSession(sessionId).catch(() => undefined);
          throw error;
        }

        return new Promise<string>((resolvePromise, reject) => {
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
          };

          runtime.subscribe(
            session.id as never,
            (event: { state: string; output?: string; error?: unknown }) => {
              if (event.state === 'completed') {
                void this.updateSessionState(sessionId, 'completed');
                settle(() => resolvePromise(event.output ?? ''));
              }
              if (event.state === 'failed') {
                void this.updateSessionState(sessionId, 'failed');
                settle(() =>
                  reject(
                    (event.error as Error | undefined) ??
                      new Error(`${resolved.profile.kind} failed`),
                  ),
                );
              }
              if (event.state === 'cancelled') {
                void this.updateSessionState(sessionId, 'stopped');
                settle(() => reject(new Error('cancelled')));
              }
            },
          );

          signal.addEventListener(
            'abort',
            () => {
              runtime.cancelSession(session.id as never).catch(() => {});
              settle(() => reject(new Error('cancelled')));
            },
            { once: true },
          );
        });
      };
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

function formatInterventionNotification(
  intervention: import('@dark-kitchen/core').Intervention,
): string {
  const code = interventionCode(intervention.id);
  const lines = [
    '🍳 Dark Kitchen — Intervention',
    '',
    `Code: ${code}`,
    `Kind: ${intervention.kind}`,
    `Summary: ${intervention.summary}`,
  ];
  if (intervention.details) lines.push('', `Details: ${intervention.details}`);
  lines.push(
    '',
    'How to respond (reply to THIS message, or quote the Code):',
    '  • your answer → route it to this question',
    '  • retry → resume the task',
    '  • approve → approve a pending gate',
    '  • stop → block the task',
    '  • switch-harness <profile-id> → restart a failed agent with that configured profile',
    `  • or give Code ${code} to the MCP operator (dk_resolve_intervention) to unblock`,
  );
  return lines.join('\n');
}

function interventionActions(
  intervention: import('@dark-kitchen/core').Intervention,
): readonly import('@dark-kitchen/channels').MessageAction[] {
  if (intervention.kind === 'approval' || intervention.kind === 'destructive-action') {
    return [
      { id: 'approve', label: 'Approve', value: 'approve' },
      { id: 'stop', label: 'Stop', value: 'stop' },
    ];
  }
  if (
    intervention.kind === 'agent-failure' ||
    intervention.kind === 'stuck-agent' ||
    intervention.kind === 'auth' ||
    intervention.kind === 'quota' ||
    intervention.kind === 'rate-limit'
  ) {
    return [
      { id: 'retry', label: 'Retry', value: 'retry' },
      { id: 'stop', label: 'Stop', value: 'stop' },
    ];
  }
  return [];
}
