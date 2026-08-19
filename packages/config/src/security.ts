/**
 * Security utilities for Dark Kitchen (Issue 27).
 *
 * - Secret redaction from logs/events/SQLite
 * - Allowlist-based plugin/adapter loading
 * - Path/command sanitization
 * - Policy gates for destructive actions
 */

/** Common secret patterns to redact from logs and events. */
const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub personal access tokens
  /ghs_[A-Za-z0-9]{36,}/g, // GitHub app installation tokens
  /ghu_[A-Za-z0-9]{36,}/g, // GitHub OAuth tokens
  /sk-[A-Za-z0-9]{40,}/g, // OpenAI-style API keys
  /xoxb-[A-Za-z0-9-]{40,}/g, // Slack bot tokens
  /xoxp-[A-Za-z0-9-]{40,}/g, // Slack user tokens
  /Bearer\s+[A-Za-z0-9._-]{20,}/g, // Bearer tokens in headers
  /:[A-Za-z0-9+/=]{40,}@/g, // Tokens embedded in URLs
];

const REDACTED = '[REDACTED]';

/** Redact known secret patterns from a string. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/** Redact secrets from an object recursively (for logging). */
export function redactObject(obj: unknown): unknown {
  if (typeof obj === 'string') return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Always redact fields named token/key/secret/password/credential
      if (/token|key|secret|password|credential|apikey|api_key/i.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }
  return obj;
}

/** Allowlisted plugin/adapter package names. */
const allowlistedPlugins = new Set<string>(['@dark-kitchen/harness-deepseek']);

/** Register an additional allowlisted plugin package name. */
export function allowlistPlugin(packageName: string): void {
  allowlistedPlugins.add(packageName);
}

/** Check if a plugin package is allowlisted for loading. */
export function isPluginAllowlisted(packageName: string): boolean {
  return allowlistedPlugins.has(packageName);
}

export class UnauthorizedPluginError extends Error {
  public constructor(packageName: string) {
    super(
      `Plugin "${packageName}" is not in the Dark Kitchen allowlist. ` +
        `Add it to your .dark-kitchen/config.yaml allowedPlugins or register it with allowlistPlugin().`,
    );
    this.name = 'UnauthorizedPluginError';
  }
}

/** Require that a plugin is allowlisted before loading. */
export function requireAllowlisted(packageName: string): void {
  if (!isPluginAllowlisted(packageName)) {
    throw new UnauthorizedPluginError(packageName);
  }
}

/** Sanitize a file path to prevent directory traversal. */
export function sanitizePath(input: string): string {
  // Remove null bytes, reject traversal sequences
  const cleaned = input.replace(/\0/g, '').replace(/\.\.[/\\]/g, '');
  return cleaned;
}

/** Check for directory traversal in a path. */
export function isPathSafe(input: string): boolean {
  return !input.includes('\0') && !/(\.\.)[/\\]/.test(input);
}

export type DestructiveAction =
  | 'git.force-push'
  | 'git.rebase'
  | 'worktree.delete'
  | 'tracker.close'
  | 'scm.merge'
  | 'capability.install'
  | 'run.stop';

export interface DestructiveActionPolicy {
  readonly requireApproval: readonly DestructiveAction[];
  readonly autoApprove: readonly DestructiveAction[];
}

export const DEFAULT_DESTRUCTIVE_POLICY: DestructiveActionPolicy = {
  requireApproval: ['git.force-push', 'capability.install'],
  autoApprove: ['worktree.delete', 'tracker.close', 'scm.merge', 'run.stop', 'git.rebase'],
};

/** Check whether a destructive action requires an intervention approval. */
export function requiresApproval(
  action: DestructiveAction,
  policy?: DestructiveActionPolicy,
): boolean {
  const p = policy ?? DEFAULT_DESTRUCTIVE_POLICY;
  return p.requireApproval.includes(action);
}
