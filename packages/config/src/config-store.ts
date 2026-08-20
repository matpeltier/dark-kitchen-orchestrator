import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { DarkKitchenConfig } from './schema.js';
import { migrateConfig, type RawConfig } from './migrations.js';
import { validateConfig, ConfigValidationError } from './validate.js';

export { ConfigValidationError };
export type { DarkKitchenConfig };

export const CONFIG_FILENAME = 'config.yaml';
export const CONFIG_DIR = '.dark-kitchen';

export interface ConfigChangedEvent {
  readonly id: string;
  readonly type: 'config-file.changed';
  readonly occurredAt: string;
  readonly payload: {
    readonly configPath: string;
    readonly previousVersion: number;
    readonly newVersion: number;
  };
}

export type ConfigPatch = Partial<Omit<DarkKitchenConfig, 'version'>>;

export interface ConfigStoreOptions {
  /** Root directory of the project (where `.dark-kitchen/` lives). */
  readonly projectRoot: string;
  /** Called after a successful write. */
  readonly onChanged?: (event: ConfigChangedEvent) => void | Promise<void>;
}

/**
 * ConfigStore provides read, validate, patch, and atomic-write operations for
 * `.dark-kitchen/config.yaml`. Migrations run automatically on read.
 */
export class ConfigStore {
  private readonly configPath: string;
  private readonly options: ConfigStoreOptions;

  public constructor(options: ConfigStoreOptions) {
    this.options = options;
    this.configPath = resolve(options.projectRoot, CONFIG_DIR, CONFIG_FILENAME);
  }

  public get path(): string {
    return this.configPath;
  }

  /** Read, migrate, and validate the config from disk. */
  public async read(): Promise<DarkKitchenConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new ConfigValidationError(`Config file not found: ${this.configPath}`);
      }
      throw err;
    }

    const parsed = yamlParse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigValidationError('Config file must be a YAML mapping (object).');
    }

    const migrated = migrateConfig(parsed as RawConfig);
    return validateConfig(migrated);
  }

  /** Validate without touching disk. */
  public validate(raw: unknown): DarkKitchenConfig {
    return validateConfig(raw);
  }

  /**
   * Apply a partial patch to the current config and write atomically.
   * Emits a `configuration.changed` event on success.
   */
  public async patch(updates: ConfigPatch): Promise<DarkKitchenConfig> {
    const current = await this.read();
    const merged: DarkKitchenConfig = mergeConfig(current, updates);
    const validated = validateConfig(merged);
    await this.writeAtomic(validated, current.version, validated.version);
    return validated;
  }

  /**
   * Write a full config object atomically (write to temp file, then rename).
   * The directory is created if it does not yet exist.
   */
  public async write(config: DarkKitchenConfig): Promise<void> {
    const validated = validateConfig(config);
    await this.writeAtomic(validated, config.version, validated.version);
  }

  private async writeAtomic(
    config: DarkKitchenConfig,
    previousVersion: number,
    newVersion: number,
  ): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.tmp`;
    const yaml = yamlStringify(config, { lineWidth: 120 });
    await writeFile(tmpPath, yaml, 'utf8');
    await rename(tmpPath, this.configPath);

    const event: ConfigChangedEvent = {
      id: `config-changed-${Date.now()}`,
      type: 'config-file.changed',
      occurredAt: new Date().toISOString(),
      payload: {
        configPath: this.configPath,
        previousVersion,
        newVersion,
      },
    };

    await this.options.onChanged?.(event);
  }

  /** Backup the config file to a gzipped archive. */
  public async backup(destinationPath: string): Promise<void> {
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(
      createReadStream(this.configPath),
      createGzip(),
      createWriteStream(destinationPath),
    );
  }

  /** Restore the config file from a gzipped backup. */
  public async restore(sourcePath: string): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.restore.tmp`;
    await pipeline(createReadStream(sourcePath), createGunzip(), createWriteStream(tmpPath));
    await rename(tmpPath, this.configPath);
  }
}

function mergeConfig(base: DarkKitchenConfig, patch: ConfigPatch): DarkKitchenConfig {
  return { ...base, ...patch } as DarkKitchenConfig;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ─── Sample configurations ────────────────────────────────────────────────────

export const SAMPLE_GITHUB_ISSUES_CONFIG: DarkKitchenConfig = {
  version: 1,
  trackers: [
    {
      id: 'gh-issues',
      kind: 'github-issues',
      owner: 'my-org',
      repo: 'my-repo',
      tokenEnv: 'GITHUB_TOKEN',
    },
  ],
  repositories: [
    {
      id: 'main-repo',
      kind: 'github',
      owner: 'my-org',
      repo: 'my-repo',
      defaultBranch: 'main',
      tokenEnv: 'GITHUB_TOKEN',
    },
  ],
  harnessProfiles: [
    {
      managed: true,
      id: 'cursor-composer',
      kind: 'cursor-composer',
      model: 'claude-opus-4-5',
    },
  ],
  roles: [
    { id: 'implementer', harnessProfileId: 'cursor-composer' },
    { id: 'reviewer', harnessProfileId: 'cursor-composer' },
    { id: 'fixer', harnessProfileId: 'cursor-composer' },
    { id: 'repository-tester', harnessProfileId: 'cursor-composer' },
  ],
  workflows: [
    {
      id: 'default',
      builtin: 'default',
      roles: ['implementer', 'reviewer', 'fixer', 'repository-tester'],
    },
  ],
  mergePolicy: {
    strategy: 'squash',
    requiredChecks: ['ci'],
    requireApproval: false,
    deleteHeadBranchAfterMerge: true,
  },
};

export const SAMPLE_LINEAR_GITHUB_CONFIG: DarkKitchenConfig = {
  version: 1,
  trackers: [
    {
      id: 'linear',
      kind: 'linear',
      workspace: 'my-workspace',
      tokenEnv: 'LINEAR_API_KEY',
    },
  ],
  repositories: [
    {
      id: 'main-repo',
      kind: 'github',
      owner: 'my-org',
      repo: 'my-repo',
      defaultBranch: 'main',
      tokenEnv: 'GITHUB_TOKEN',
    },
  ],
  harnessProfiles: [
    {
      managed: true,
      id: 'cursor-composer',
      kind: 'cursor-composer',
    },
  ],
  roles: [
    { id: 'implementer', harnessProfileId: 'cursor-composer' },
    { id: 'reviewer', harnessProfileId: 'cursor-composer' },
    { id: 'fixer', harnessProfileId: 'cursor-composer' },
    { id: 'repository-tester', harnessProfileId: 'cursor-composer' },
  ],
  workflows: [
    {
      id: 'default',
      builtin: 'default',
      roles: ['implementer', 'reviewer', 'fixer', 'repository-tester'],
    },
  ],
  mergePolicy: {
    strategy: 'squash',
    requireApproval: false,
    deleteHeadBranchAfterMerge: true,
  },
};

export const SAMPLE_LINEAR_GITHUB_WITH_WEB_E2E_CONFIG: DarkKitchenConfig = {
  ...SAMPLE_LINEAR_GITHUB_CONFIG,
  roles: [
    ...(SAMPLE_LINEAR_GITHUB_CONFIG.roles ?? []),
    { id: 'verifier', harnessProfileId: 'cursor-composer' },
  ],
  capabilityProviders: [
    {
      managed: true,
      id: 'playwright',
      capability: 'browser.playwright',
      version: '>=1.40',
    },
  ],
  verificationProfiles: [
    {
      id: 'web-e2e',
      requiredCapabilities: ['browser.playwright'],
      timeoutSeconds: 300,
      retryPolicy: { maxAttempts: 2, delaySeconds: 10 },
      evidencePolicy: { screenshots: true, logs: true },
      blocking: true,
    },
  ],
  workflows: [
    {
      id: 'default',
      builtin: 'default',
      roles: ['implementer', 'verifier'],
      verificationProfiles: ['web-e2e'],
    },
  ],
};
