import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../src/tools/registry.js";

// End-to-end over stdio: the real entry point, a real JSON-RPC handshake, and
// the guarantee that stdout carries nothing but JSON-RPC.

const home = mkdtempSync(join(tmpdir(), "ae-mcp-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

type Rpc = { id?: number; result?: Record<string, unknown>; error?: unknown };

async function talk(
  messages: object[],
  env: Record<string, string> = {},
): Promise<{ replies: Rpc[]; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", "src/bin.ts", "mcp"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ALIEXPRESS_CONFIG_DIR: home, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  proc.kill();
  const replies = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Rpc);
  return { replies, stdout };
}

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

test(
  "mcp handshake lists the registry and survives a failing call",
  async () => {
    const { replies, stdout } = await talk([
      ...handshake,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "auth_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "raw_get", arguments: { api: "mtop.aliexpress.trade.buyer.order.operation" } },
      },
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
    ]);

    // Every line of stdout is JSON-RPC: no log leaked into the stream.
    for (const line of stdout.split("\n").filter((value) => value.trim() !== "")) {
      expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
    }

    const list = replies.find((reply) => reply.id === 2)?.result as {
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    };
    expect(list.tools.map((tool) => tool.name)).toEqual(allTools.map((tool) => tool.name));
    expect(list.tools[0]?.annotations.readOnlyHint).toBe(true);

    const status = replies.find((reply) => reply.id === 3)?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(status.isError).toBeUndefined();
    expect(JSON.parse(status.content[0]?.text as string).loggedIn).toBe(false);

    const unknown = replies.find((reply) => reply.id === 4)?.result as { isError: boolean };
    expect(unknown.isError).toBe(true);

    const refused = replies.find((reply) => reply.id === 5)?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/somente leitura/);

    // Still answering after two tool errors.
    expect(replies.find((reply) => reply.id === 6)?.result).toBeDefined();
  },
  30_000,
);

test(
  "read-only mode registers only the read-only tools",
  async () => {
    const { replies } = await talk([...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list" }], {
      ALIEXPRESS_READ_ONLY: "1",
    });
    const list = replies.find((reply) => reply.id === 2)?.result as {
      tools: Array<{ name: string }>;
    };
    expect(list.tools.map((tool) => tool.name)).toEqual(
      allTools.filter((tool) => tool.readOnly).map((tool) => tool.name),
    );
  },
  30_000,
);
