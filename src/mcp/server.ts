import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Ctx } from "../context.js";
import { runTool } from "../tools/define.js";
import { activeTools } from "../tools/registry.js";

// MCP transport adapter: all SDK usage is confined here. The low-level `Server`
// on purpose — `McpServer.registerTool` wants Zod/Standard Schema, while the
// TypeBox object already IS a valid JSON Schema and is advertised verbatim.

export const SERVER_NAME = "aliexpress-mcp";

export async function startMcpServer(ctx: Ctx, version: string): Promise<void> {
  const tools = activeTools(ctx.config);

  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input as { type: "object" },
      annotations: {
        // The account is never written to; `readOnly` is about local state.
        readOnlyHint: tool.readOnly,
        destructiveHint: false,
        idempotentHint: tool.readOnly,
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) return toolError(`Tool desconhecida: ${request.params.name}`);
    // Validation and execution failures become tool errors (isError), never a
    // crash: one bad call must not take the server down.
    try {
      const result = await runTool(tool, request.params.arguments ?? {}, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  await server.connect(new StdioServerTransport());
  // stderr only: stdout is 100% JSON-RPC.
  ctx.log.info(`${SERVER_NAME} pronto (${tools.length} tools)`);
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
