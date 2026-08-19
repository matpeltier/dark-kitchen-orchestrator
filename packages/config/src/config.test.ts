import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateConfig,
  ConfigValidationError,
  ConfigStore,
  migrateConfig,
  SAMPLE_GITHUB_ISSUES_CONFIG,
  SAMPLE_LINEAR_GITHUB_CONFIG,
  SAMPLE_LINEAR_GITHUB_WITH_WEB_E2E_CONFIG,
} from './index.js';
import { dump as yamlDump } from 'js-yaml';

// ─── Validate ────────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    const config = validateConfig({ version: 1 });
    expect(config.version).toBe(1);
  });

  it('rejects a missing version field', () => {
    expect(() => validateConfig({})).toThrow(ConfigValidationError);
  });

  it('rejects an unknown version', () => {
    expect(() => validateConfig({ version: 999 })).toThrow(ConfigValidationError);
  });

  it('rejects non-object input', () => {
    expect(() => validateConfig('string')).toThrow(ConfigValidationError);
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
  });

  it('accepts sample GitHub Issues config', () => {
    const config = validateConfig(SAMPLE_GITHUB_ISSUES_CONFIG);
    expect(config.trackers?.[0]?.kind).toBe('github-issues');
  });

  it('accepts sample Linear + GitHub config', () => {
    const config = validateConfig(SAMPLE_LINEAR_GITHUB_CONFIG);
    expect(config.trackers?.[0]?.kind).toBe('linear');
  });

  it('accepts sample Linear + GitHub + web-e2e config', () => {
    const config = validateConfig(SAMPLE_LINEAR_GITHUB_WITH_WEB_E2E_CONFIG);
    expect(config.verificationProfiles?.[0]?.id).toBe('web-e2e');
  });
});

// ─── Duplicate IDs ───────────────────────────────────────────────────────────

describe('validateConfig - duplicate IDs', () => {
  it('rejects duplicate role ids', () => {
    expect(() =>
      validateConfig({
        version: 1,
        harnessProfiles: [{ managed: true, id: 'hp', kind: 'cursor' }],
        roles: [
          { id: 'impl', harnessProfileId: 'hp' },
          { id: 'impl', harnessProfileId: 'hp' },
        ],
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects duplicate workflow ids', () => {
    expect(() =>
      validateConfig({
        version: 1,
        workflows: [
          { id: 'wf', file: 'a.ts' },
          { id: 'wf', file: 'b.ts' },
        ],
      }),
    ).toThrow(ConfigValidationError);
  });
});

// ─── Reference validation ────────────────────────────────────────────────────

describe('validateConfig - unknown references', () => {
  it('rejects role referencing unknown harnessProfileId', () => {
    expect(() =>
      validateConfig({
        version: 1,
        roles: [{ id: 'impl', harnessProfileId: 'nonexistent' }],
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects verificationProfile referencing unknown capability', () => {
    expect(() =>
      validateConfig({
        version: 1,
        verificationProfiles: [{ id: 'vp', requiredCapabilities: ['missing-cap'] }],
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects role overrides on user-managed harness profile', () => {
    expect(() =>
      validateConfig({
        version: 1,
        harnessProfiles: [{ managed: false, id: 'custom', kind: 'custom' }],
        roles: [
          {
            id: 'impl',
            harnessProfileId: 'custom',
            overrides: { model: 'gpt-4' },
          },
        ],
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects verificationProfile referencing unknown verifierRoleId', () => {
    expect(() =>
      validateConfig({
        version: 1,
        verificationProfiles: [{ id: 'vp', verifierRoleId: 'no-such-role' }],
      }),
    ).toThrow(ConfigValidationError);
  });
});

// ─── Secret detection ─────────────────────────────────────────────────────────

describe('validateConfig - inline secrets', () => {
  it('rejects tracker tokenEnv that looks like a token value', () => {
    expect(() =>
      validateConfig({
        version: 1,
        trackers: [
          {
            id: 't',
            kind: 'github-issues',
            owner: 'o',
            repo: 'r',
            tokenEnv: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
          },
        ],
      }),
    ).toThrow(ConfigValidationError);
  });
});

// ─── Migrations ───────────────────────────────────────────────────────────────

describe('migrateConfig', () => {
  it('adds version:1 to a pre-versioned config', () => {
    const result = migrateConfig({ trackers: [] });
    expect(result['version']).toBe(1);
  });

  it('is idempotent for current version', () => {
    const result = migrateConfig({ version: 1, trackers: [] });
    expect(result['version']).toBe(1);
  });
});

// ─── ConfigStore ──────────────────────────────────────────────────────────────

describe('ConfigStore', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = join(tmpdir(), `dk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('reads a valid config file', async () => {
    const store = new ConfigStore({ projectRoot });
    await store.write(SAMPLE_GITHUB_ISSUES_CONFIG);
    const config = await store.read();
    expect(config.version).toBe(1);
    expect(config.trackers?.[0]?.id).toBe('gh-issues');
  });

  it('throws ConfigValidationError when config file is missing', async () => {
    const store = new ConfigStore({ projectRoot });
    await expect(store.read()).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('migrates an unversioned config on read', async () => {
    const store = new ConfigStore({ projectRoot });
    await mkdir(join(projectRoot, '.dark-kitchen'), { recursive: true });
    await writeFile(
      join(projectRoot, '.dark-kitchen', 'config.yaml'),
      yamlDump({ trackers: [] }),
      'utf8',
    );
    const config = await store.read();
    expect(config.version).toBe(1);
  });

  it('patches config atomically', async () => {
    const events: string[] = [];
    const store = new ConfigStore({
      projectRoot,
      onChanged: (e) => {
        events.push(e.type);
      },
    });
    await store.write(SAMPLE_GITHUB_ISSUES_CONFIG);
    const patched = await store.patch({
      concurrency: { maxParallelTasks: 8, maxParallelWorkflows: 4 },
    });
    expect(patched.concurrency?.maxParallelTasks).toBe(8);
    expect(events).toContain('config-file.changed');
  });

  it('round-trips config through YAML', async () => {
    const store = new ConfigStore({ projectRoot });
    await store.write(SAMPLE_LINEAR_GITHUB_WITH_WEB_E2E_CONFIG);
    const config = await store.read();
    expect(config.verificationProfiles?.[0]?.id).toBe('web-e2e');
    expect(config.capabilityProviders?.[0]?.capability).toBe('browser.playwright');
  });

  it('emits configuration.changed event after write', async () => {
    const events: string[] = [];
    const store = new ConfigStore({
      projectRoot,
      onChanged: (e) => {
        events.push(e.type);
      },
    });
    await store.write(SAMPLE_GITHUB_ISSUES_CONFIG);
    expect(events).toEqual(['config-file.changed']);
  });
});
