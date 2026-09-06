import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { compactObject, runTool } from "../tools/define.js";
import { activeTools, allTools } from "../tools/registry.js";
import type { ToolDef } from "../tools/define.js";

// The CLI is a thin argv → tool-args mapper. Every command goes through the
// same `runTool` the MCP server uses, so validation and behaviour cannot drift
// between the two surfaces.

function resolveTool(readOnly: boolean, name: string): ToolDef {
  const tool = activeTools({ readOnly }).find((candidate) => candidate.name === name);
  if (tool) return tool;
  const exists = allTools.some((candidate) => candidate.name === name);
  throw new Error(
    exists
      ? `Comando indisponível em modo somente leitura: ${name}`
      : `Tool não encontrada: ${name}`,
  );
}

const formatValue = (value: unknown): string =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

export function formatHuman(result: unknown): string {
  if (result === null || typeof result !== "object") return String(result);
  if (Array.isArray(result)) return result.map(formatValue).join("\n");
  return Object.entries(result)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join("\n");
}

type InvokeOptions = { json: boolean; format?: (result: unknown) => string };

async function invoke(
  toolName: string,
  args: Record<string, unknown>,
  options: InvokeOptions,
): Promise<void> {
  try {
    const config = loadConfig();
    const ctx = createContext(config);
    const tool = resolveTool(config.readOnly, toolName);
    const result = await runTool(tool, compactObject(args), ctx);
    const text = options.json
      ? JSON.stringify(result, null, 2)
      : (options.format ?? formatHuman)(result);
    // Await the write: a large result piped to a slow reader is truncated when
    // the process exits before stdout drains.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runCli(argv: string[], version: string): Promise<void> {
  const program = new Command();
  program
    .name("aliexpress")
    .description("Histórico de compras do AliExpress: CLI + servidor MCP")
    .version(version);

  // Every command gets --json for structured output.
  const command = (signature: string) =>
    program.command(signature).option("--json", "saída em JSON puro");

  command("status")
    .description("Mostra a sessão salva (região, idioma, moeda, validade)")
    .option("--verify", "gasta 1 requisição para confirmar que o AliExpress aceita a sessão")
    .action((options) =>
      invoke("auth_status", { verify: options.verify }, { json: options.json ?? false }),
    );

  command("raw <api>")
    .description("Chama uma API MTOP de leitura diretamente (redescoberta)")
    .option("-d, --data <json>", "payload JSON da API")
    .option("-m, --method <method>", "GET ou POST (default GET)")
    .option("--api-version <v>", "versão da API (default 1.0)")
    .action((api, options) =>
      invoke(
        "raw_get",
        {
          api,
          data: options.data ? (JSON.parse(options.data) as Record<string, unknown>) : undefined,
          method: options.method,
          v: options.apiVersion,
        },
        { json: options.json ?? false },
      ),
    );

  program
    .command("mcp")
    .description("Sobe o servidor MCP (stdio)")
    .action(async () => {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer(createContext(loadConfig()), version);
    });

  await program.parseAsync(argv);
}
