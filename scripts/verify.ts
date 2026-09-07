#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../src/tools/registry.js";

// The real gate, and what CI runs: typecheck + tests + the invariants that only
// show up when the MCP server actually runs. Every check here is about a
// promise the project makes, not about code coverage.
//
// It spawns the server with a THROWAWAY config dir and no session, so nothing
// touches the network and nothing touches the user's cache.

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "aliexpress-verify-"));

type Rpc = { id?: number; result?: Record<string, unknown>; error?: unknown };
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok " : "  ERR"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function run(command: string[], label: string): Promise<boolean> {
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) console.log(`${out}\n${err}`);
  check(label, code === 0);
  return code === 0;
}

async function talk(messages: object[], env: Record<string, string> = {}): Promise<{
  replies: Rpc[];
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "run", "src/bin.ts", "mcp"], {
    cwd: ROOT,
    env: { ...process.env, ALIEXPRESS_CONFIG_DIR: home, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  proc.kill();
  const replies = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Rpc);
  return { replies, stdout, stderr };
}

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

const callTool = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

async function main(): Promise<void> {
  console.log("aliexpress-mcp — verificação\n");

  console.log("estático:");
  const typecheckOk = await run(["bunx", "tsc", "--noEmit"], "tsc --noEmit");
  const testsOk = await run(["bun", "test"], "bun test");

  console.log("\nservidor MCP (sem rede, sem sessão):");
  const { replies, stdout, stderr } = await talk([
    ...handshake,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    callTool(3, "auth_status"),
    callTool(4, "does_not_exist"),
    callTool(5, "raw_get", { api: "mtop.aliexpress.trade.buyer.order.operation" }),
    callTool(6, "raw_get", { api: "mtop.taobao.whatever" }),
    callTool(7, "list_orders", { limit: "muitos" }),
    { jsonrpc: "2.0", id: 8, method: "tools/list" },
  ]);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  check(
    "stdout é 100% JSON-RPC",
    lines.every((line) => {
      try {
        return (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0";
      } catch {
        return false;
      }
    }),
  );
  check("logs saem no stderr", stderr.includes("aliexpress-mcp"));

  const listed = (replies.find((reply) => reply.id === 2)?.result as
    | { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }
    | undefined)?.tools;
  check("tools/list bate com o registry", listed?.length === allTools.length, `${listed?.length}`);
  check(
    "todo inputSchema é um objeto JSON Schema",
    listed?.every((tool) => tool.inputSchema.type === "object") === true,
  );
  check(
    "toda descrição é longa o bastante para guiar um modelo",
    listed?.every((tool) => tool.description.length > 40) === true,
  );

  const status = replies.find((reply) => reply.id === 3)?.result as ToolResult | undefined;
  check("auth_status responde sem sessão e sem rede", status?.isError === undefined);
  check(
    "auth_status não vaza cookie",
    !JSON.stringify(status).includes("_m_h5_tk"),
  );

  for (const [id, label] of [
    [4, "tool desconhecida vira isError"],
    [5, "raw_get recusa uma API de escrita"],
    [6, "raw_get recusa uma API fora do namespace"],
    [7, "argumento inválido vira isError"],
  ] as const) {
    const result = replies.find((reply) => reply.id === id)?.result as ToolResult | undefined;
    check(label, result?.isError === true);
  }

  check(
    "o servidor continua respondendo depois de 4 erros",
    replies.find((reply) => reply.id === 8)?.result !== undefined,
  );

  console.log("\nmodo somente leitura:");
  const readOnly = await talk([...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list" }], {
    ALIEXPRESS_READ_ONLY: "1",
  });
  const readOnlyTools = (readOnly.replies.find((reply) => reply.id === 2)?.result as
    | { tools: Array<{ name: string }> }
    | undefined)?.tools;
  const expected = allTools.filter((tool) => tool.readOnly).map((tool) => tool.name);
  check(
    "registra exatamente o subconjunto readOnly",
    JSON.stringify(readOnlyTools?.map((tool) => tool.name)) === JSON.stringify(expected),
    `${readOnlyTools?.length} de ${allTools.length}`,
  );

  rmSync(home, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? "tudo certo" : `${failures} verificação(ões) falharam`}`,
  );
  if (failures > 0 || !typecheckOk || !testsOk) process.exit(1);
}

await main();
