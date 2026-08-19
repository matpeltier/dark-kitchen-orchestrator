import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  redactObject,
  isPluginAllowlisted,
  requireAllowlisted,
  UnauthorizedPluginError,
  isPathSafe,
  sanitizePath,
  requiresApproval,
} from './security.js';

describe('redactSecrets', () => {
  it('redacts GitHub personal access token', () => {
    const text = 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    expect(redactSecrets(text)).not.toContain('ghp_');
    expect(redactSecrets(text)).toContain('[REDACTED]');
  });

  it('redacts Slack bot token', () => {
    const text = 'slack_token=xoxb-1234567890-1234567890-1234567890-ABCDEFGHIJKLMNO';
    expect(redactSecrets(text)).toContain('[REDACTED]');
  });

  it('leaves non-secret strings untouched', () => {
    const text = 'Hello, world! This has no secrets.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactObject', () => {
  it('redacts fields named token/key/secret', () => {
    const obj = { name: 'test', token: 'secret-value', apiKey: 'another-secret' };
    const result = redactObject(obj) as Record<string, unknown>;
    expect(result['token']).toBe('[REDACTED]');
    expect(result['apiKey']).toBe('[REDACTED]');
    expect(result['name']).toBe('test');
  });

  it('recursively redacts nested objects', () => {
    const obj = { config: { auth: { token: 'my-token' } } };
    const result = redactObject(obj) as { config: { auth: { token: string } } };
    expect(result.config.auth.token).toBe('[REDACTED]');
  });
});

describe('plugin allowlist', () => {
  it('allows allowlisted plugins', () => {
    expect(isPluginAllowlisted('@dark-kitchen/harness-deepseek')).toBe(true);
  });

  it('rejects non-allowlisted plugins', () => {
    expect(() => requireAllowlisted('some-malicious-package')).toThrow(UnauthorizedPluginError);
  });
});

describe('path safety', () => {
  it('detects directory traversal', () => {
    expect(isPathSafe('../etc/passwd')).toBe(false);
    expect(isPathSafe('/safe/path/file.txt')).toBe(true);
  });

  it('sanitizes path', () => {
    const result = sanitizePath('../../../etc/passwd');
    expect(result).not.toContain('../');
  });
});

describe('destructive action policy', () => {
  it('requires approval for capability.install', () => {
    expect(requiresApproval('capability.install')).toBe(true);
  });

  it('auto-approves tracker.close', () => {
    expect(requiresApproval('tracker.close')).toBe(false);
  });
});
