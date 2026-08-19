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
import { ALL_TOOLS, handleTool, type McpContext } from './tools.js';

const SERVER_NAME = 'dark-kitchen';
const SERVER_VERSION = '0.1.0';

export async function createMcpServer(ctx: McpContext): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of ALL_TOOLS) {
    // Register each tool with the MCP SDK
    server.tool(tool.name, tool.description, {}, async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<
        string,
        unknown
      >;
      const result = await handleTool(tool.name, args, ctx);
      if (result.success) {
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }
      return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
    });
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
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\.js$/, '.ts'))) {
  await startServer({});
}
