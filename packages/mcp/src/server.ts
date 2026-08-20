#!/usr/bin/env node
/**
 * Dark Kitchen MCP Server entry point.
 *
 * Exposes the Dark Kitchen control plane through MCP so PM agents can
 * manage tracker work, inspect runtime state, resolve interventions, and
 * provision capabilities — without direct terminal/process access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS, handleTool, type McpContext } from './tools.js';
import { zodSchemaFromJsonSchema } from './schema.js';

const SERVER_NAME = 'dark-kitchen';
const SERVER_VERSION = '0.1.0';

export async function createMcpServer(ctx: McpContext): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of ALL_TOOLS) {
    const inputSchema = zodSchemaFromJsonSchema(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        annotations: tool.annotations ?? inferAnnotations(tool.name),
      },
      async (rawArgs: unknown) => {
        const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<
          string,
          unknown
        >;
        const result = await handleTool(tool.name, args, ctx);
        if (result.success) {
          const data = result.data ?? null;
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: { success: true, data },
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
          isError: true,
        };
      },
    );
  }

  return server;
}

/** Start the MCP server on stdio (standard deployment mode). */
export async function startServer(ctx: McpContext): Promise<void> {
  const server = await createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run as a script
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await startServer({});
}

function inferAnnotations(name: string): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
} {
  const readOnlyHint = /^dk_(list|get|inspect|validate|plan)/.test(name);
  const destructiveHint = /^dk_(close|remove|stop|cancel|dismiss|ensure)/.test(name);
  return { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint };
}
