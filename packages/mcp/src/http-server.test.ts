import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startMcpHttpServer, type McpHttpServer } from './http-server.js';

describe('MCP Streamable HTTP security boundary', () => {
  let running: McpHttpServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('refuses remote binds without authentication and an explicit host allowlist', async () => {
    await expect(startMcpHttpServer({}, { host: '0.0.0.0', port: 0 })).rejects.toThrow(
      /requires auth/i,
    );
    await expect(
      startMcpHttpServer({}, { host: '0.0.0.0', port: 0, authToken: 'secret' }),
    ).rejects.toThrow(/allowedHosts/i);
  });

  it('requires the configured bearer token and does not expose other paths', async () => {
    running = await startMcpHttpServer({}, { port: 0, authToken: 'correct-token' });

    const missing = await fetch(running.url, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = await fetch(running.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);

    const hiddenPath = await fetch(running.url.replace('/mcp', '/internal'), {
      headers: { Authorization: 'Bearer correct-token' },
    });
    expect(hiddenPath.status).toBe(404);
  });

  it('serves an authenticated MCP SDK client over Streamable HTTP', async () => {
    running = await startMcpHttpServer({}, { port: 0, authToken: 'correct-token' });
    const client = new Client({ name: 'http-boundary-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: 'Bearer correct-token' } },
    });

    try {
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === 'dk_get_task')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects browser origins, malformed JSON, and oversized bodies before MCP dispatch', async () => {
    running = await startMcpHttpServer(
      {},
      { port: 0, authToken: 'token', maxRequestBodyBytes: 16 },
    );
    const headers = { Authorization: 'Bearer token' };

    const browser = await fetch(running.url, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.example' },
      body: '{}',
    });
    expect(browser.status).toBe(403);

    const malformed = await fetch(running.url, {
      method: 'POST',
      headers,
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(running.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payload: 'x'.repeat(100) }),
    });
    expect(oversized.status).toBe(413);
  });
});
