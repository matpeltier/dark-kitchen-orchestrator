import type { Tracker } from '@dark-kitchen/core';

/** Composition input for the future HTTP control plane. */
export interface ApiDependencies {
  readonly tracker: Tracker;
}

/**
 * The API is a composition boundary for control-plane capabilities.
 * Transport and concrete adapters are intentionally out of scope for bootstrap.
 */
export const createApiComposition = (dependencies: ApiDependencies): ApiDependencies =>
  dependencies;
