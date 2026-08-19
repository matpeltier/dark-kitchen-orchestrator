/**
 * Migration registry for `.dark-kitchen/config.yaml`.
 *
 * Each migration transforms a raw (pre-validation) config object from one
 * schema version to the next. Migrations run in order from the detected
 * version up to the current version.
 */

export type RawConfig = Record<string, unknown>;

export interface Migration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(raw: RawConfig): RawConfig;
}

/** All registered migrations in ascending version order. */
const migrations: Migration[] = [
  // Version 0 → 1: initial schema. No data transformation needed.
  // (Pre-versioned files have no version field; we treat them as version 0.)
  {
    fromVersion: 0,
    toVersion: 1,
    migrate(raw) {
      return { ...raw, version: 1 };
    },
  },
];

/**
 * Run all necessary migrations on a raw config object, returning a raw object
 * at the current schema version. Does not validate the result.
 */
export function migrateConfig(raw: RawConfig): RawConfig {
  let current: RawConfig = raw;
  const detectedVersion = typeof current['version'] === 'number' ? current['version'] : 0;
  let version = detectedVersion;

  for (const migration of migrations) {
    if (version === migration.fromVersion) {
      current = migration.migrate(current);
      version = migration.toVersion;
    }
  }

  return current;
}

export function getDetectedVersion(raw: RawConfig): number {
  return typeof raw['version'] === 'number' ? raw['version'] : 0;
}
