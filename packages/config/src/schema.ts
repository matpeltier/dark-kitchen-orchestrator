import { z } from 'zod';

// ─── Primitive helpers ────────────────────────────────────────────────────────

const nonEmptyString = z.string().min(1);

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

export const VerificationProfileSchema = z.object({
  id: nonEmptyString,
  verifierRoleId: nonEmptyString.optional(),
  requiredCapabilities: z.array(nonEmptyString).optional(),
  skills: z.array(nonEmptyString).optional(),
  mcpServers: z.array(nonEmptyString).optional(),
  tools: z.array(nonEmptyString).optional(),
  environmentSetup: z.array(nonEmptyString).optional(),
  environmentTeardown: z.array(nonEmptyString).optional(),
  environmentHealthcheck: z.array(nonEmptyString).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  retryPolicy: RetryPolicySchema.optional(),
  evidencePolicy: EvidencePolicySchema.optional(),
  blocking: z.boolean().default(true),
});
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>;

// ─── Workflows ────────────────────────────────────────────────────────────────

export const WorkflowConfigSchema = z.object({
  id: nonEmptyString,
  file: nonEmptyString,
  description: nonEmptyString.optional(),
  roles: z.array(nonEmptyString).optional(),
  verificationProfiles: z.array(nonEmptyString).optional(),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// ─── Channels ─────────────────────────────────────────────────────────────────

export const ChannelKindSchema = z.enum(['openclaw', 'slack', 'webhook']);
export const ChannelConfigSchema = z.object({
  id: nonEmptyString,
  kind: ChannelKindSchema,
  url: nonEmptyString.optional(),
  tokenEnv: nonEmptyString.optional(),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

// ─── Concurrency ─────────────────────────────────────────────────────────────

export const ConcurrencyConfigSchema = z.object({
  maxParallelTasks: z.number().int().min(1).default(4),
  maxParallelWorkflows: z.number().int().min(1).default(2),
});
export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

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
