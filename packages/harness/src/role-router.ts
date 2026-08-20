import type { HarnessProfile, ResolvedRole } from './contracts.js';
import { UnsupportedCapabilityError, type HarnessCapability } from './capabilities.js';
import type { HarnessRuntime } from './contracts.js';

export interface RoleDefinition {
  readonly roleId: string;
  readonly profileId: string;
  readonly modelOverride?: string;
  readonly reasoningOverride?: string;
  readonly instructionsOverride?: string;
  readonly skillsOverride?: readonly string[];
  readonly mcpServersOverride?: readonly string[];
  readonly pluginsOverride?: readonly string[];
  readonly requiredCapabilities?: readonly HarnessCapability[];
}

export interface RoleRouterOptions {
  readonly roles: readonly RoleDefinition[];
  readonly profiles: readonly HarnessProfile[];
  readonly runtimes: readonly HarnessRuntime[];
}

export class RoleNotFoundError extends Error {
  public constructor(roleId: string) {
    super(`No role definition found for role "${roleId}"`);
    this.name = 'RoleNotFoundError';
  }
}

export class ProfileNotFoundError extends Error {
  public constructor(profileId: string) {
    super(`No harness profile found for id "${profileId}"`);
    this.name = 'ProfileNotFoundError';
  }
}

export class RuntimeNotFoundError extends Error {
  public constructor(kind: string) {
    super(`No harness runtime registered for kind "${kind}"`);
    this.name = 'RuntimeNotFoundError';
  }
}

export class DuplicateRuntimeKindError extends Error {
  public constructor(kind: string) {
    super(`Multiple harness runtimes are registered for kind "${kind}"`);
    this.name = 'DuplicateRuntimeKindError';
  }
}

/**
 * Routes semantic workflow roles to harness profiles and execution nodes.
 * Validates capability requirements before returning a resolved role.
 */
export class RoleRouter {
  private readonly roles: ReadonlyMap<string, RoleDefinition>;
  private readonly profiles: ReadonlyMap<string, HarnessProfile>;
  private readonly runtimes: ReadonlyMap<string, HarnessRuntime>;

  public constructor(options: RoleRouterOptions) {
    this.roles = new Map(options.roles.map((r) => [r.roleId, r]));
    this.profiles = new Map(options.profiles.map((p) => [p.id, p]));
    const runtimes = new Map<string, HarnessRuntime>();
    for (const runtime of options.runtimes) {
      if (runtimes.has(runtime.kind)) throw new DuplicateRuntimeKindError(runtime.kind);
      runtimes.set(runtime.kind, runtime);
    }
    this.runtimes = runtimes;
  }

  /**
   * Resolve a semantic role to its harness profile + overrides.
   * Throws if the role is unknown, profile is missing, or capability is unsupported.
   */
  public resolve(roleId: string): ResolvedRole {
    const roleDef = this.roles.get(roleId);
    if (!roleDef) throw new RoleNotFoundError(roleId);

    const profile = this.profiles.get(roleDef.profileId);
    if (!profile) throw new ProfileNotFoundError(roleDef.profileId);

    // Validate overrides are only used with managed profiles
    if (
      profile.managed === false &&
      (roleDef.modelOverride ??
        roleDef.reasoningOverride ??
        roleDef.instructionsOverride ??
        roleDef.skillsOverride ??
        roleDef.mcpServersOverride ??
        roleDef.pluginsOverride)
    ) {
      throw new Error(
        `Role "${roleId}" declares overrides but harness profile "${profile.id}" is user-managed (overrides not supported)`,
      );
    }

    const runtime = this.runtimes.get(profile.kind);
    if (!runtime) throw new RuntimeNotFoundError(profile.kind);

    // Validate explicit requirements and every managed profile/role option
    // whose application depends on a negotiated runtime capability.
    const requiredCapabilities = new Set(roleDef.requiredCapabilities ?? []);
    if (profile.managed) {
      if (roleDef.modelOverride ?? profile.model) requiredCapabilities.add('model.selection');
      if (roleDef.reasoningOverride ?? profile.reasoning) {
        requiredCapabilities.add('reasoning.selection');
      }
      if ((roleDef.skillsOverride?.length ?? profile.skills?.length ?? 0) > 0) {
        requiredCapabilities.add('skills.custom');
      }
      if ((roleDef.mcpServersOverride?.length ?? profile.mcpServers?.length ?? 0) > 0) {
        requiredCapabilities.add('skills.mcp');
      }
      if ((roleDef.pluginsOverride?.length ?? profile.plugins?.length ?? 0) > 0) {
        requiredCapabilities.add('skills.plugins');
      }
    }
    for (const cap of requiredCapabilities) {
      if (!runtime.capabilities.supported.has(cap)) {
        throw new UnsupportedCapabilityError(cap, profile.id);
      }
    }

    const resolved: ResolvedRole = { roleId, profile, runtime };
    if (roleDef.modelOverride) Object.assign(resolved, { modelOverride: roleDef.modelOverride });
    if (roleDef.reasoningOverride)
      Object.assign(resolved, { reasoningOverride: roleDef.reasoningOverride });
    if (roleDef.instructionsOverride)
      Object.assign(resolved, { instructionsOverride: roleDef.instructionsOverride });
    if (roleDef.skillsOverride)
      Object.assign(resolved, { skillsOverride: [...roleDef.skillsOverride] });
    if (roleDef.mcpServersOverride)
      Object.assign(resolved, { mcpServersOverride: [...roleDef.mcpServersOverride] });
    if (roleDef.pluginsOverride)
      Object.assign(resolved, { pluginsOverride: [...roleDef.pluginsOverride] });
    return resolved;
  }

  /** Get the runtime for a profile kind. */
  public getRuntime(kind: string): HarnessRuntime | undefined {
    return this.runtimes.get(kind);
  }

  /** Validate all role/capability combinations before launching a run. */
  public validateAll(): string[] {
    const errors: string[] = [];
    for (const [roleId] of this.roles) {
      try {
        this.resolve(roleId);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return errors;
  }
}
