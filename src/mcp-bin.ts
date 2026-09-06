#!/usr/bin/env bun
// Entry for the `aliexpress-mcp` binary: starts the MCP server directly,
// without a subcommand — what an MCP client registers when it does not want
// the CLI.
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { startMcpServer } from "./mcp/server.js";

await startMcpServer(createContext(loadConfig()), pkg.version);
