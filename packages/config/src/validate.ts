import { ZodError } from 'zod';
import type { DarkKitchenConfig } from './schema.js';
import { DarkKitchenConfigSchema } from './schema.js';

export class ConfigValidationError extends Error {
  public readonly issues: readonly string[];
  public constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/** Checks for secrets that appear to be inline values rather than env-var references. */
function detectInlineSecrets(config: DarkKitchenConfig): string[] {
  const findings: string[] = [];

  const secretPattern = /^(ghp_|gh[su]_|gho_|ghr_|sk-|xoxb-|xoxp-|xoxa-)/i;
  const looksLikeSecret = (v: string): boolean =>
    secretPattern.test(v) || (v.length > 20 && /[A-Za-z0-9+/=]{20,}/.test(v) && !/[._-]/.test(v));

  const checkTokenField = (value: string | undefined, label: string): void => {
    if (value !== undefined && looksLikeSecret(value)) {
      findings.push(`${label}: looks like an inline secret. Use an env-var name instead.`);
    }
  };

  for (const tracker of config.trackers ?? []) {
    checkTokenField(tracker.tokenEnv, `tracker[${tracker.id}].tokenEnv`);
  }
  for (const repo of config.repositories ?? []) {
    checkTokenField(repo.tokenEnv, `repository[${repo.id}].tokenEnv`);
  }
  for (const channel of config.channels ?? []) {
    checkTokenField(channel.tokenEnv, `channel[${channel.id}].tokenEnv`);
  }

  return findings;
}

function collectDuplicates<T>(items: T[] | undefined, key: (item: T) => string, label: string): string[] {
  if (!items) return [];
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) dupes.push(`Duplicate ${label} id: "${k}"`);
    seen.add(k);
  }
  return dupes;
}

function validateReferences(config: DarkKitchenConfig): string[] {
  const errors: string[] = [];

  const trackerIds = new Set((config.trackers ?? []).map((t) => t.id));
  const repoIds = new Set((config.repositories ?? []).map((r) => r.id));
  const roleIds = new Set((config.roles ?? []).map((r) => r.id));
  const harnessProfileIds = new Set((config.harnessProfiles ?? []).map((h) => h.id));
  const verificationProfileIds = new Set((config.verificationProfiles ?? []).map((v) => v.id));
  const capabilityIds = new Set((config.capabilityProviders ?? []).map((c) => c.id));
  const channelIds = new Set((config.channels ?? []).map((c) => c.id));
  const workflowIds = new Set((config.workflows ?? []).map((w) => w.id));

  // Roles must reference existing harness profiles
  for (const role of config.roles ?? []) {
    if (!harnessProfileIds.has(role.harnessProfileId)) {
      errors.push(`Role "${role.id}" references unknown harnessProfileId "${role.harnessProfileId}"`);
    }
    // Overrides are only meaningful for managed harness profiles
    if (role.overrides) {
      const hp = (config.harnessProfiles ?? []).find((h) => h.id === role.harnessProfileId);
      if (hp && hp.managed === false) {
        errors.push(
          `Role "${role.id}" declares overrides but harness profile "${role.harnessProfileId}" is user-managed (overrides not supported)`,
        );
      }
    }
  }

  // Verification profiles: requiredCapabilities must reference known providers
  for (const vp of config.verificationProfiles ?? []) {
    for (const capRef of vp.requiredCapabilities ?? []) {
      if (!capabilityIds.has(capRef)) {
        errors.push(
          `VerificationProfile "${vp.id}" requires unknown capability provider "${capRef}"`,
        );
      }
    }
    if (vp.verifierRoleId && !roleIds.has(vp.verifierRoleId)) {
      errors.push(
        `VerificationProfile "${vp.id}" references unknown verifierRoleId "${vp.verifierRoleId}"`,
      );
    }
  }

  // Workflows: referenced roles and verification profiles must exist
  for (const wf of config.workflows ?? []) {
    for (const roleRef of wf.roles ?? []) {
      if (!roleIds.has(roleRef)) {
        errors.push(`Workflow "${wf.id}" references unknown role "${roleRef}"`);
      }
    }
    for (const vpRef of wf.verificationProfiles ?? []) {
      if (!verificationProfileIds.has(vpRef)) {
        errors.push(`Workflow "${wf.id}" references unknown verificationProfile "${vpRef}"`);
      }
    }
  }

  // Intervention policy: channels must be known
  for (const ch of config.interventionPolicy?.channels ?? []) {
    if (!channelIds.has(ch)) {
      errors.push(`interventionPolicy references unknown channel "${ch}"`);
    }
  }

  void trackerIds;
  void repoIds;
  void workflowIds;

  return errors;
}

/**
 * Validates a parsed config object. Returns the coerced/defaulted config on
 * success, throws `ConfigValidationError` on failure.
 */
export function validateConfig(raw: unknown): DarkKitchenConfig {
  let parsed: DarkKitchenConfig;
  try {
    parsed = DarkKitchenConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map(
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
      );
      throw new ConfigValidationError(
        `Config schema validation failed:\n${issues.join('\n')}`,
        issues,
      );
    }
    throw err;
  }

  const referenceErrors = validateReferences(parsed);
  const secretErrors = detectInlineSecrets(parsed);

  const duplicateErrors = [
    ...collectDuplicates(parsed.trackers, (t) => t.id, 'tracker'),
    ...collectDuplicates(parsed.repositories, (r) => r.id, 'repository'),
    ...collectDuplicates(parsed.roles, (r) => r.id, 'role'),
    ...collectDuplicates(parsed.harnessProfiles, (h) => h.id, 'harnessProfile'),
    ...collectDuplicates(parsed.verificationProfiles, (v) => v.id, 'verificationProfile'),
    ...collectDuplicates(parsed.capabilityProviders, (c) => c.id, 'capabilityProvider'),
    ...collectDuplicates(parsed.channels, (c) => c.id, 'channel'),
    ...collectDuplicates(parsed.workflows, (w) => w.id, 'workflow'),
  ];

  const allErrors = [...duplicateErrors, ...referenceErrors, ...secretErrors];

  if (allErrors.length > 0) {
    throw new ConfigValidationError(
      `Config validation failed:\n${allErrors.join('\n')}`,
      allErrors,
    );
  }

  return parsed;
}
