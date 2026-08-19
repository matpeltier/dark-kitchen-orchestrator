/**
 * Harness capability negotiation contracts.
 * A harness declares which operations it supports; Dark Kitchen validates
 * before launching a run rather than discovering unsupported operations later.
 */

export type HarnessCapability =
  | 'sessions.persistent'
  | 'sessions.resume'
  | 'sessions.cancel'
  | 'sessions.live-instructions'
  | 'model.selection'
  | 'reasoning.selection'
  | 'permissions.declare'
  | 'usage.reporting'
  | 'skills.mcp'
  | 'skills.plugins'
  | 'skills.custom';

export interface HarnessCapabilitySet {
  readonly supported: ReadonlySet<HarnessCapability>;
}

export function supportsCapability(
  caps: HarnessCapabilitySet,
  capability: HarnessCapability,
): boolean {
  return caps.supported.has(capability);
}

export function requireCapability(
  caps: HarnessCapabilitySet,
  capability: HarnessCapability,
  harnessId: string,
): void {
  if (!supportsCapability(caps, capability)) {
    throw new UnsupportedCapabilityError(capability, harnessId);
  }
}

export class UnsupportedCapabilityError extends Error {
  public readonly capability: HarnessCapability;
  public readonly harnessId: string;
  public constructor(capability: HarnessCapability, harnessId: string) {
    super(`Harness "${harnessId}" does not support capability "${capability}"`);
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
    this.harnessId = harnessId;
  }
}

export function makeCapabilitySet(caps: readonly HarnessCapability[]): HarnessCapabilitySet {
  return { supported: new Set(caps) };
}

/** The minimal capability set for any harness. */
export const MINIMAL_CAPABILITIES: HarnessCapabilitySet = makeCapabilitySet([]);

/** Full capability set for testing and fully-featured harnesses. */
export const FULL_CAPABILITIES: HarnessCapabilitySet = makeCapabilitySet([
  'sessions.persistent',
  'sessions.resume',
  'sessions.cancel',
  'sessions.live-instructions',
  'model.selection',
  'reasoning.selection',
  'permissions.declare',
  'usage.reporting',
  'skills.mcp',
  'skills.plugins',
  'skills.custom',
]);
