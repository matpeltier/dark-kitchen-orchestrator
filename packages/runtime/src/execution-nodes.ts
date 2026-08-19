/**
 * Execution node registry and capability discovery (Issues 24, 25).
 *
 * Models where harnesses and verification capabilities execute so Dark Kitchen
 * can run locally today while keeping a clean path to cloud/remote nodes.
 */

import type { ExecutionNodeId } from '@dark-kitchen/core';
import { createExecutionNodeId } from '@dark-kitchen/core';

export type CapabilityState = 'installed' | 'provisionable' | 'unavailable' | 'unknown';
export type NodeKind = 'local' | 'remote';

export interface NodeCapabilityInfo {
  readonly capabilityId: string;
  readonly capability: string;
  readonly state: CapabilityState;
  readonly version?: string;
  readonly lastHealthCheck?: string;
  readonly healthCheckResult?: 'ok' | 'degraded' | 'failing';
}

export interface ExecutionNodeInfo {
  readonly id: ExecutionNodeId;
  readonly kind: NodeKind;
  readonly platform: string;
  readonly hostname: string;
  readonly available: boolean;
  readonly installedHarnessProfiles: readonly string[];
  readonly capabilities: readonly NodeCapabilityInfo[];
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface NodeRegistrationInput {
  readonly kind: NodeKind;
  readonly platform?: string;
  readonly hostname?: string;
  readonly installedHarnessProfiles?: readonly string[];
  readonly capabilities?: readonly NodeCapabilityInfo[];
}

/**
 * Local execution node registry.
 * Tracks node registrations and capability state in memory and SQLite.
 */
export class ExecutionNodeRegistry {
  private readonly nodes = new Map<ExecutionNodeId, ExecutionNodeInfo>();

  public register(input: NodeRegistrationInput): ExecutionNodeInfo {
    const id = createExecutionNodeId(`node-${input.kind}-${Date.now()}`);
    const now = new Date().toISOString();
    const node: ExecutionNodeInfo = {
      id,
      kind: input.kind,
      platform: input.platform ?? process.platform,
      hostname: input.hostname ?? 'localhost',
      available: true,
      installedHarnessProfiles: input.installedHarnessProfiles ?? [],
      capabilities: input.capabilities ?? [],
      registeredAt: now,
      lastSeenAt: now,
    };
    this.nodes.set(id, node);
    return node;
  }

  public get(nodeId: ExecutionNodeId): ExecutionNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  public list(): readonly ExecutionNodeInfo[] {
    return [...this.nodes.values()];
  }

  public updateCapabilities(
    nodeId: ExecutionNodeId,
    capabilities: readonly NodeCapabilityInfo[],
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    const updated: ExecutionNodeInfo = {
      ...node,
      capabilities,
      lastSeenAt: new Date().toISOString(),
    };
    this.nodes.set(nodeId, updated);
  }

  public heartbeat(nodeId: ExecutionNodeId): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.set(nodeId, { ...node, lastSeenAt: new Date().toISOString() });
  }

  public markUnavailable(nodeId: ExecutionNodeId): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.set(nodeId, { ...node, available: false, lastSeenAt: new Date().toISOString() });
  }

  /**
   * Find nodes that have a specific capability installed.
   */
  public findNodesWithCapability(capability: string): readonly ExecutionNodeInfo[] {
    return [...this.nodes.values()].filter(
      (node) =>
        node.available &&
        node.capabilities.some((c) => c.capability === capability && c.state === 'installed'),
    );
  }

  /**
   * Compute the current local node from the system environment.
   */
  public static discoverLocalNode(): NodeRegistrationInput {
    return {
      kind: 'local',
      platform: process.platform,
      hostname: 'localhost',
    };
  }
}

// ─── Remote execution node transport (Issue 25) ──────────────────────────────

export interface RemoteNodeConfig {
  readonly nodeId: ExecutionNodeId;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly tlsCert?: string;
}

/**
 * Client for a remote Dark Kitchen execution node.
 * Forwards harness/capability operations to the remote node over HTTP.
 */
export class RemoteExecutionNodeClient {
  private readonly config: RemoteNodeConfig;

  public constructor(config: RemoteNodeConfig) {
    this.config = config;
  }

  public async heartbeat(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.endpoint}/health`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async getCapabilities(): Promise<readonly NodeCapabilityInfo[]> {
    const res = await fetch(`${this.config.endpoint}/capabilities`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`Remote node error: ${res.status}`);
    return res.json() as Promise<NodeCapabilityInfo[]>;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    return headers;
  }
}
