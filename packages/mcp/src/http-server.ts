/**
 * Dark Kitchen MCP server over Streamable HTTP.
 *
 * Exposes the Dark Kitchen tools (including `dk_ask_human`) over HTTP so coding
 * agents (via acpx) can call them. The `dk_ask_human` tool blocks until the
 * human replies over the configured messaging channel.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpServer } from './server.js';
import type { McpContext } from './tools.js';

export interface McpHttpServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Static bearer token suitable for local/VPN machine-to-machine use. */
  readonly authToken?: string;
  /** Alternative authorization hook for an OAuth/reverse-proxy boundary. */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Host header names (without ports) accepted by the server. */
  readonly allowedHosts?: readonly string[];
  /** Browser origins allowed to call MCP. Browser-origin requests are denied by default. */
  readonly allowedOrigins?: readonly string[];
  /** Maximum JSON request size. Defaults to 16 MiB (large task specs remain supported). */
  readonly maxRequestBodyBytes?: number;
}

export interface McpHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(
  ctx: McpContext,
  options: McpHttpServerOptions = {},
): Promise<McpHttpServer> {
  const port = options.port ?? 18801;
  const host = options.host ?? '127.0.0.1';
  const loopback = isLoopback(host);
  if (!loopback && !options.authToken && !options.authorize) {
    throw new Error('Remote MCP exposure requires authToken or an authorize callback');
  }
  if (!loopback && (!options.allowedHosts || options.allowedHosts.length === 0)) {
    throw new Error('Remote MCP exposure requires an explicit non-empty allowedHosts list');
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req, host, options.allowedHosts)) {
      sendJsonError(res, 403, 'Host header is not allowed');
      return;
    }
    if (!isAllowedOrigin(req, options.allowedOrigins)) {
      sendJsonError(res, 403, 'Browser origin is not allowed');
      return;
    }
    if (new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname !== '/mcp') {
      sendJsonError(res, 404, 'Not found');
      return;
    }

    void authorizeRequest(req, options)
      .then((authorized) => {
        if (!authorized) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="dark-kitchen-mcp"');
          sendJsonError(res, 401, 'Unauthorized');
          return;
        }
        readRequestBody(req, options.maxRequestBodyBytes ?? 16 * 1024 * 1024)
          .then((body) => handleOneRequest(ctx, req, res, body))
          .catch((error: unknown) => {
            const tooLarge = error instanceof RequestBodyTooLargeError;
            sendJsonError(res, tooLarge ? 413 : 400, errorMessage(error));
          });
      })
      .catch(() => sendJsonError(res, 500, 'Authorization check failed'));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${address.port}/mcp`,
    close: async () => {
      await closeServer(httpServer);
    },
  };
}

/**
 * Stateless-per-request handling: each HTTP request gets a fresh transport so
 * requests are self-contained (no Mcp-Session-Id handshake), which is what
 * coding-agent MCP clients and acpx expect.
 */
async function handleOneRequest(
  ctx: McpContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = await createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport();
  // The Node transport implements the runtime Transport contract, but its
  // optional callback declarations conflict under exactOptionalPropertyTypes.
  await server.connect(transport as unknown as Transport);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await transport.close();
    await server.close();
  };
  res.once('close', () => void close());
  try {
    await transport.handleRequest(req, res, body);
    if (res.writableEnded) await close();
  } catch (err: unknown) {
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    process.stderr.write(`[mcp-http] request failed (${errorName})\n`);
    if (!res.headersSent) {
      sendJsonError(res, 500, 'MCP request failed');
    }
    await close();
  }
}

async function authorizeRequest(
  request: IncomingMessage,
  options: McpHttpServerOptions,
): Promise<boolean> {
  if (options.authorize && (await options.authorize(request))) return true;
  if (!options.authToken) return !options.authorize;
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/iu);
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(options.authToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isAllowedHost(
  request: IncomingMessage,
  bindHost: string,
  configured: readonly string[] | undefined,
): boolean {
  const hostHeader = request.headers.host;
  if (!hostHeader) return false;
  const hostname = (
    hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : (hostHeader.split(':')[0] ?? '')
  ).toLowerCase();
  const allowed =
    configured ?? (isLoopback(bindHost) ? ['localhost', '127.0.0.1', '::1', bindHost] : [bindHost]);
  return allowed.some((candidate) => candidate.toLowerCase() === hostname);
}

function isAllowedOrigin(
  request: IncomingMessage,
  configured: readonly string[] | undefined,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return configured?.includes(origin) ?? false;
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (request.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
  });
}

function sendJsonError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid request';
}

class RequestBodyTooLargeError extends Error {
  public constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}
