#!/usr/bin/env bun
// Entry for the `aliexpress-mcp` binary: starts the MCP server directly,
// without a subcommand — what an MCP client registers when it does not want
// the CLI.
import pkg from "../package.json" with { type: "json" };

// Scaffold: replaced by the real bootstrap in step 007.
console.error(`aliexpress-mcp ${pkg.version} — ainda em construção (scaffold).`);
process.exitCode = 1;
