import { z } from 'zod';

// ─── Primitive helpers ────────────────────────────────────────────────────────

const nonEmptyString = z.string().min(1);

/** Trusted configuration for a shell-free process invocation. */
export const StructuredCommandSchema = z.object({
  executable: nonEmptyString.max(4_096),
  args: z.array(nonEmptyString.max(4_096)).max(128).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
});
export type StructuredCommand = z.infer<typeof StructuredCommandSchema>;

// ─── Version ─────────────────────────────────────────────────────────────────

export const CONFIG_VERSION = 1 as const;

// ─── Tracker ─────────────────────────────────────────────────────────────────

export const TrackerKindSchema = z.enum(['github-issues', 'linear', 'jira']);
export type TrackerKind = z.infer<typeof TrackerKindSchema>;

export const TrackerConfigSchema = z.object({
  id: nonEmptyString,
  kind: TrackerKindSchema,
  owner: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  workspace: nonEmptyString.optional(),
  project: nonEmptyString.optional(),
  tokenEnv: nonEmptyString.optional(),
});
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

// ─── SCM ─────────────────────────────────────────────────────────────────────

export const ScmKindSchema = z.enum(['github']);
export type ScmKind = z.infer<typeof ScmKindSchema>;

export const ScmRepositoryConfigSchema = z.object({
  id: nonEmptyString,
  kind: ScmKindSchema,
  owner: nonEmptyString,
  repo: nonEmptyString,
  defaultBranch: nonEmptyString.default('main'),
  tokenEnv: nonEmptyString.optional(),
});
export type ScmRepositoryConfig = z.infer<typeof ScmRepositoryConfigSchema>;

// ─── Capability ───────────────────────────────────────────────────────────────

export const ManagedCapabilityProviderSchema = z.object({
  managed: z.literal(true),
  id: nonEmptyString,
  capability: nonEmptyString,
  version: nonEmptyString.optional(),
});

export const ProjectCapabilityProviderSchema = z.object({
  managed: z.literal(false),
  id: nonEmptyString,
  capability: nonEmptyString,
  description: nonEmptyString.optional(),
  /** Explicit repository-owned command, required before command.exec is available. */
  command: StructuredCommandSchema.optional(),
});

export const ExternalCapabilityProviderSchema = z.object({
  managed: z.literal('external'),
  id: nonEmptyString,
  capability: nonEmptyString,
  description: nonEmptyString.optional(),
});

export const CapabilityProviderSchema = z.discriminatedUnion('managed', [
  ManagedCapabilityProviderSchema,
  ProjectCapabilityProviderSchema,
  ExternalCapabilityProviderSchema,
]);
export type CapabilityProvider = z.infer<typeof CapabilityProviderSchema>;

// ─── Harness profiles ────────────────────────────────────────────────────────

export const ManagedHarnessProfileSchema = z.object({
  managed: z.literal(true),
  id: nonEmptyString,
  kind: nonEmptyString,
  model: nonEmptyString.optional(),
  reasoning: nonEmptyString.optional(),
  instructions: nonEmptyString.optional(),
  skills: z.array(nonEmptyString).optional(),
  mcpServers: z.array(nonEmptyString).optional(),
  plugins: z.array(nonEmptyString).optional(),
  /** Alternative models on the same harness kind, tried in order on quota exhaustion. */
  fallbackModels: z.array(nonEmptyString).optional(),
});

export const CustomHarnessProfileSchema = z.object({
  managed: z.literal(false),
  id: nonEmptyString,
  kind: nonEmptyString,
  description: nonEmptyString.optional(),
});

export const HarnessProfileSchema = z.discriminatedUnion('managed', [
  ManagedHarnessProfileSchema,
  CustomHarnessProfileSchema,
]);
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

// ─── Roles ────────────────────────────────────────────────────────────────────

const HarnessOverridesSchema = z.object({
  model: nonEmptyString.optional(),
  reasoning: nonEmptyString.optional(),
  instructions: nonEmptyString.optional(),
  skills: z.array(nonEmptyString).optional(),
  mcpServers: z.array(nonEmptyString).optional(),
  plugins: z.array(nonEmptyString).optional(),
});

export const RoleConfigSchema = z.object({
  id: nonEmptyString,
  harnessProfileId: nonEmptyString,
  overrides: HarnessOverridesSchema.optional(),
  /** Alternative harnessProfile ids, tried in order when the primary hits a quota error. */
  fallbacks: z.array(nonEmptyString).optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

// ─── Verification profiles ────────────────────────────────────────────────────

export const EvidencePolicySchema = z.object({
  screenshots: z.boolean().optional(),
  logs: z.boolean().optional(),
  reports: z.array(nonEmptyString).optional(),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  delaySeconds: z.number().min(0).default(0),
});

/**
 * Trusted project configuration for a shell-free verification lifecycle
 * command. Runtime task/tracker text is never substituted into these fields.
 */
export const VerificationEnvironmentCommandSchema = StructuredCommandSchema;
export type VerificationEnvironmentCommand = z.infer<typeof VerificationEnvironmentCommandSchema>;

export const VerificationProfileSchema = z.object({
  id: nonEmptyString,
  verifierRoleId: nonEmptyString.optional(),
  requiredCapabilities: z.array(nonEmptyString).optional(),
  skills: z.array(nonEmptyString).optional(),
  mcpServers: z.array(nonEmptyString).optional(),
  tools: z.array(nonEmptyString).optional(),
  environmentSetup: z.array(VerificationEnvironmentCommandSchema).optional(),
  environmentTeardown: z.array(VerificationEnvironmentCommandSchema).optional(),
  environmentHealthcheck: z.array(VerificationEnvironmentCommandSchema).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  retryPolicy: RetryPolicySchema.optional(),
  evidencePolicy: EvidencePolicySchema.optional(),
  blocking: z.boolean().default(true),
});
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>;

// ─── Workflows ────────────────────────────────────────────────────────────────

export const WorkflowTaskSelectorSchema = z
  .object({
    taskIds: z.array(nonEmptyString).optional(),
    statuses: z
      .array(z.enum(['backlog', 'ready', 'active', 'blocked', 'completed', 'cancelled']))
      .optional(),
    labelsAny: z.array(nonEmptyString).optional(),
    labelsAll: z.array(nonEmptyString).optional(),
    titleIncludes: z.array(nonEmptyString).optional(),
    descriptionIncludes: z.array(nonEmptyString).optional(),
    verificationProfilesAny: z.array(nonEmptyString).optional(),
  })
  .refine(
    (selector) => Object.values(selector).some((value) => value !== undefined && value.length > 0),
    'A workflow task selector must define at least one non-empty predicate.',
  );
export type WorkflowTaskSelector = z.infer<typeof WorkflowTaskSelectorSchema>;

export const WorkflowConfigSchema = z
  .object({
    id: nonEmptyString,
    /** Trusted project module, mutually exclusive with a stock built-in template. */
    file: nonEmptyString.optional(),
    builtin: z.enum(['default', 'design-frontend', 'high-risk']).optional(),
    description: nonEmptyString.optional(),
    roles: z.array(nonEmptyString).optional(),
    verificationProfiles: z.array(nonEmptyString).optional(),
    /** Fallback workflow when no task selector matches. At most one may be set. */
    default: z.boolean().optional(),
    /** Higher-priority matching workflows win; declaration order breaks ties. */
    priority: z.number().int().optional(),
    /** Deterministic assignment predicates evaluated against a normalized task. */
    taskSelector: WorkflowTaskSelectorSchema.optional(),
  })
  .refine((workflow) => Boolean(workflow.file) !== Boolean(workflow.builtin), {
    message: 'A workflow must define exactly one of file or builtin.',
  });
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// ─── Channels ─────────────────────────────────────────────────────────────────

export const ChannelKindSchema = z.enum([
  'telegram',
  'discord',
  'slack',
  'imessage',
  'whatsapp',
  'openclaw',
  'webhook',
]);
export const ChannelConfigSchema = z.object({
  id: nonEmptyString,
  kind: ChannelKindSchema,
  url: nonEmptyString.optional(),
  tokenEnv: nonEmptyString.optional(),
  /** Secondary token (e.g. SLACK_APP_TOKEN for Socket Mode). */
  token2Env: nonEmptyString.optional(),
  /** Default chat/user ID to send notifications to. */
  defaultTarget: nonEmptyString.optional(),
  /** Optional provider sender allowlist in addition to the conversation allowlist. */
  allowedSenderIds: z.array(nonEmptyString).optional(),
  /** Telegram polling is the local default; webhook mode must be configured explicitly. */
  telegramMode: z.enum(['polling', 'webhook']).optional(),
  webhookPort: z.number().int().min(1).max(65_535).optional(),
  webhookPath: nonEmptyString.optional(),
  /** Environment variable holding the Telegram webhook secret token. */
  webhookSecretEnv: nonEmptyString.optional(),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

// ─── Concurrency ─────────────────────────────────────────────────────────────

export const ConcurrencyConfigSchema = z.object({
  maxParallelTasks: z.number().int().min(1).default(4),
  maxParallelWorkflows: z.number().int().min(1).default(2),
});
export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

// ─── Scheduler ───────────────────────────────────────────────────────────────

export const SchedulerConfigSchema = z.object({
  /**
   * Promote backlog tasks whose dependencies are all completed to 'ready'
   * (with dk:ready label sync) during each scheduling tick.
   */
  autoPromoteDependents: z.boolean().default(true),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

// ─── Intervention policy ──────────────────────────────────────────────────────

export const InterventionPolicySchema = z.object({
  escalateOnBlockedSeconds: z.number().int().min(0).default(300),
  escalateOnFailedAttempts: z.number().int().min(1).default(3),
  channels: z.array(nonEmptyString).optional(),
});
export type InterventionPolicy = z.infer<typeof InterventionPolicySchema>;

// ─── Merge policy ────────────────────────────────────────────────────────────

export const MergeStrategySchema = z.enum(['squash', 'merge', 'rebase']);
export const MergePolicySchema = z.object({
  strategy: MergeStrategySchema.default('squash'),
  requiredChecks: z.array(nonEmptyString).optional(),
  requireApproval: z.boolean().default(false),
  deleteHeadBranchAfterMerge: z.boolean().default(true),
});
export type MergePolicy = z.infer<typeof MergePolicySchema>;

// ─── Root config ─────────────────────────────────────────────────────────────

export const DarkKitchenConfigSchema = z.object({
  version: z.literal(1),
  trackers: z.array(TrackerConfigSchema).optional(),
  repositories: z.array(ScmRepositoryConfigSchema).optional(),
  concurrency: ConcurrencyConfigSchema.optional(),
  scheduler: SchedulerConfigSchema.optional(),
  workflows: z.array(WorkflowConfigSchema).optional(),
  roles: z.array(RoleConfigSchema).optional(),
  harnessProfiles: z.array(HarnessProfileSchema).optional(),
  verificationProfiles: z.array(VerificationProfileSchema).optional(),
  capabilityProviders: z.array(CapabilityProviderSchema).optional(),
  channels: z.array(ChannelConfigSchema).optional(),
  interventionPolicy: InterventionPolicySchema.optional(),
  mergePolicy: MergePolicySchema.optional(),
});
export type DarkKitchenConfig = z.infer<typeof DarkKitchenConfigSchema>;
