import type { TrackerAdapter } from '@dark-kitchen/core';

/** Composition input for the future HTTP control plane. */
export interface ApiDependencies {
  readonly tracker: TrackerAdapter;
}

/**
 * The API is a composition boundary for control-plane capabilities.
 * Transport and concrete adapters are intentionally out of scope for bootstrap.
 */
export const createApiComposition = (dependencies: ApiDependencies): ApiDependencies =>
  dependencies;
