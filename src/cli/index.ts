import { Command } from "commander";
import { loadConfig } from "../config.js";
import { type Ctx, createContext } from "../context.js";
import type { ToolDef } from "../tools/define.js";
import { compactObject, runTool } from "../tools/define.js";
import { activeTools, allTools } from "../tools/registry.js";

// The CLI is a thin argv → tool-args mapper. Every command goes through the
// same `runTool` the MCP server uses, and both resolve from the same registry,
// so the two surfaces cannot drift.

function resolveTool(readOnly: boolean, name: string): ToolDef {
  const tool = activeTools({ readOnly }).find((candidate) => candidate.name === name);
  if (tool) return tool;
  const exists = allTools.some((candidate) => candidate.name === name);
  throw new Error(
    exists ? `Comando indisponível em modo somente leitura: ${name}` : `Tool não encontrada: ${name}`,
  );
}

const value = (input: unknown): string =>
  input === null || input === undefined
    ? ""
    : typeof input === "object"
      ? JSON.stringify(input)
      : String(input);

export function formatHuman(result: unknown): string {
  if (result === null || typeof result !== "object") return String(result);
  if (Array.isArray(result)) return result.map(value).join("\n");
  return Object.entries(result)
    .map(([key, item]) => `${key}: ${value(item)}`)
    .join("\n");
}

/** Fixed-width table, no dependency. Columns are [header, accessor]. */
export function printTable<T>(rows: T[], columns: Array<[string, (row: T) => string]>): string {
  if (rows.length === 0) return "(nenhum resultado)";
  const header = columns.map(([name]) => name);
  const body = rows.map((row) => columns.map(([, get]) => get(row)));
  const widths = header.map((name, index) =>
    Math.max(name.length, ...body.map((cells) => (cells[index] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

const brl = (money: { amount: number; currency: string } | null): string =>
  money ? `${money.currency} ${money.amount.toFixed(2)}` : "-";

type InvokeOptions = { json: boolean; format?: (result: unknown) => string };

async function withContext<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = createContext(loadConfig());
  try {
    return await fn(ctx);
  } finally {
    ctx.dispose();
  }
}

async function write(text: string): Promise<void> {
  // Await the write: a large result piped to a slow reader is truncated when
  // the process exits before stdout drains.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function invoke(
  toolName: string,
  args: Record<string, unknown>,
  options: InvokeOptions,
): Promise<void> {
  try {
    await withContext(async (ctx) => {
      const tool = resolveTool(ctx.config.readOnly, toolName);
      const result = await runTool(tool, compactObject(args), ctx);
      await write(
        options.json ? JSON.stringify(result, null, 2) : (options.format ?? formatHuman)(result),
      );
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// ---- formatters ------------------------------------------------------------

type OrderOut = {
  orderId: string;
  date: string | null;
  status: string;
  store: string | null;
  total: { amount: number; currency: string } | null;
  itemCount: number;
};

const formatOrders = (result: unknown): string => {
  const data = result as { total: number; orders: OrderOut[]; note?: string };
  const table = printTable(data.orders, [
    ["PEDIDO", (row) => row.orderId],
    ["DATA", (row) => row.date ?? "-"],
    ["SITUAÇÃO", (row) => row.status],
    ["TOTAL", (row) => brl(row.total)],
    ["ITENS", (row) => String(row.itemCount)],
    ["LOJA", (row) => (row.store ?? "-").slice(0, 32)],
  ]);
  return `${table}\n\n${data.orders.length} de ${data.total}${data.note ? `\n${data.note}` : ""}`;
};

const formatSearch = (result: unknown): string => {
  const data = result as {
    total: number;
    items: Array<{
      date: string | null;
      title: string | null;
      quantity: number;
      unitPrice: { amount: number; currency: string } | null;
      store: string | null;
    }>;
  };
  return printTable(data.items, [
    ["DATA", (row) => row.date ?? "-"],
    ["QTD", (row) => String(row.quantity)],
    ["UNITÁRIO", (row) => brl(row.unitPrice)],
    ["PRODUTO", (row) => (row.title ?? "-").slice(0, 60)],
    ["LOJA", (row) => (row.store ?? "-").slice(0, 24)],
  ]);
};

const formatSummary = (result: unknown): string => {
  const data = result as {
    groupBy: string;
    currency: string | null;
    rows: Array<{ key: string; orders: number; items?: number; total: number }>;
    grandTotal: number;
    note: string;
  };
  const table = printTable(data.rows, [
    [data.groupBy.toUpperCase(), (row) => row.key],
    ["PEDIDOS", (row) => String(row.orders)],
    ["TOTAL", (row) => row.total.toFixed(2)],
  ]);
  return `${table}\n\nTotal: ${data.currency ?? ""} ${data.grandTotal.toFixed(2)}\n${data.note}`;
};

const formatTracking = (result: unknown): string => {
  const data = result as {
    packages: Array<{
      trackingNumber: string | null;
      carrier: string | null;
      eta: string | null;
      events: Array<{ at: string | null; stage: string | null; description: string | null }>;
    }>;
  };
  return data.packages
    .map((pkg) => {
      const head = `${pkg.trackingNumber ?? "(sem código)"} · ${pkg.carrier ?? "?"}${pkg.eta ? ` · previsão ${pkg.eta}` : ""}`;
      const events = printTable(pkg.events, [
        ["QUANDO", (row) => (row.at ?? "").slice(0, 16).replace("T", " ")],
        ["ETAPA", (row) => row.stage ?? "-"],
        ["EVENTO", (row) => (row.description ?? "-").slice(0, 70)],
      ]);
      return `${head}\n${events}`;
    })
    .join("\n\n");
};

const formatDoctor = (result: unknown): string => {
  const data = result as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
  const table = printTable(data.checks, [
    ["", (row) => (row.ok ? "ok " : "ERR")],
    ["VERIFICAÇÃO", (row) => row.name],
    ["DETALHE", (row) => row.detail],
  ]);
  return `${table}\n\n${data.ok ? "tudo certo" : "há falhas acima"}`;
};

// ---- the program -----------------------------------------------------------

export async function runCli(argv: string[], version: string): Promise<void> {
  const program = new Command();
  program
    .name("aliexpress")
    .description("Histórico de compras do AliExpress: CLI + servidor MCP")
    .version(version);

  const command = (signature: string) =>
    program.command(signature).option("--json", "saída em JSON puro");

  command("status")
    .description("Mostra a sessão salva (região, idioma, moeda, validade)")
    .option("--verify", "gasta 1 requisição para confirmar que o AliExpress aceita a sessão")
    .action((options) =>
      invoke("auth_status", { verify: options.verify }, { json: options.json ?? false }),
    );

  command("login")
    .description("Abre o navegador para entrar na conta do AliExpress e salva a sessão")
    .option("--timeout <minutes>", "minutos esperando o login (default 5)")
    .option("--fresh", "apaga o perfil do navegador antes de abrir")
    .option("--from-browser <browser>", "importa a sessão de um navegador já logado (macOS)")
    .action((options) =>
      invoke(
        "login",
        {
          timeout_seconds: options.timeout ? Number(options.timeout) * 60 : undefined,
          fresh: options.fresh,
          from_browser: options.fromBrowser,
        },
        { json: options.json ?? false },
      ),
    );

  command("doctor")
    .description("Diagnóstico camada a camada da sessão, da API e do cache")
    .option("--shallow", "pula os testes de paginação e detalhe")
    .action((options) =>
      invoke(
        "doctor",
        { deep: options.shallow ? false : undefined },
        { json: options.json ?? false, format: formatDoctor },
      ),
    );

  command("sync")
    .description("Preenche o cache local (repete os blocos até terminar)")
    .option("--full", "percorre todo o histórico em vez de parar nas novidades")
    .option("--reparse", "reprocessa o cache sem usar a rede")
    .option("--max-requests <n>", "orçamento de requisições por bloco (default 40)")
    .option("--no-details", "não baixa o detalhe dos pedidos")
    .option("--no-tracking", "não atualiza o rastreio")
    .option("--no-refunds", "não atualiza as devoluções")
    .action(async (options) => {
      try {
        await withContext(async (ctx) => {
          const tool = resolveTool(ctx.config.readOnly, "sync");
          const args = compactObject({
            mode: options.reparse ? "reparse" : options.full ? "full" : undefined,
            max_requests: options.maxRequests ? Number(options.maxRequests) : undefined,
            with_details: options.details,
            with_tracking: options.tracking,
            with_refunds: options.refunds,
          });
          let last: Record<string, unknown> = {};
          for (let chunk = 1; chunk <= 50; chunk += 1) {
            last = (await runTool(tool, args, ctx)) as Record<string, unknown>;
            // Progress goes to stderr so stdout stays parseable.
            console.error(
              `bloco ${chunk}: ${last.requestsUsed} req, ${last.detailsFetched} detalhes, ` +
                `${last.pendingDetails} pendentes${last.done ? " — pronto" : ""}`,
            );
            if (last.done === true) break;
          }
          await write(
            options.json ? JSON.stringify(last, null, 2) : formatHuman(last),
          );
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  command("orders")
    .description("Lista os pedidos do cache")
    .option("--status <status>", "unpaid | processing | shipped | completed | cancelled | expired")
    .option("--from <date>", "data inicial YYYY-MM-DD")
    .option("--to <date>", "data final YYYY-MM-DD")
    .option("--store <name>", "trecho do nome da loja")
    .option("--include-unpaid", "inclui cancelados e expirados")
    .option("--limit <n>", "máximo de pedidos (default 50)")
    .option("--offset <n>", "pedidos a pular")
    .action((options) =>
      invoke(
        "list_orders",
        {
          status: options.status,
          from: options.from,
          to: options.to,
          store: options.store,
          include_unpaid: options.includeUnpaid,
          limit: options.limit ? Number(options.limit) : undefined,
          offset: options.offset ? Number(options.offset) : undefined,
        },
        { json: options.json ?? false, format: formatOrders },
      ),
    );

  command("order <orderId>")
    .description("Detalhe completo de um pedido")
    .option("--address", "inclui o endereço de entrega")
    .option("--refresh", "busca o detalhe de novo mesmo estando no cache")
    .action((orderId, options) =>
      invoke(
        "get_order",
        { order_id: orderId, include_address: options.address, refresh: options.refresh },
        { json: options.json ?? false },
      ),
    );

  command("search <query>")
    .description("Busca nos produtos comprados")
    .option("--from <date>", "data inicial YYYY-MM-DD")
    .option("--to <date>", "data final YYYY-MM-DD")
    .option("--limit <n>", "máximo de resultados (default 50)")
    .action((query, options) =>
      invoke(
        "search_products",
        {
          query,
          from: options.from,
          to: options.to,
          limit: options.limit ? Number(options.limit) : undefined,
        },
        { json: options.json ?? false, format: formatSearch },
      ),
    );

  command("track <orderId>")
    .description("Rastreio ao vivo de um pedido")
    .option("--line <orderLineId>", "restringe a um item específico")
    .action((orderId, options) =>
      invoke(
        "track_order",
        { order_id: orderId, order_line_id: options.line },
        { json: options.json ?? false, format: formatTracking },
      ),
    );

  command("refunds")
    .description("Devoluções e reembolsos")
    .option("--refresh", "busca ao vivo em vez de ler o cache")
    .option("--limit <n>", "máximo de registros (default 50)")
    .action((options) =>
      invoke(
        "list_refunds",
        { refresh: options.refresh, limit: options.limit ? Number(options.limit) : undefined },
        { json: options.json ?? false },
      ),
    );

  command("spending")
    .description("Gastos agregados")
    .option("--by <group>", "month | year | store | payment_method | breakdown", "month")
    .option("--from <date>", "data inicial YYYY-MM-DD")
    .option("--to <date>", "data final YYYY-MM-DD")
    .option("--include-unpaid", "inclui cancelados e expirados")
    .action((options) =>
      invoke(
        "spending_summary",
        {
          group_by: options.by,
          from: options.from,
          to: options.to,
          include_unpaid: options.includeUnpaid,
        },
        { json: options.json ?? false, format: formatSummary },
      ),
    );

  command("export")
    .description("Exporta o cache para JSON ou CSV")
    .option("--format <format>", "json | csv", "csv")
    .option("--scope <scope>", "orders | lines | packages | refunds", "orders")
    .option("--from <date>", "data inicial YYYY-MM-DD")
    .option("--to <date>", "data final YYYY-MM-DD")
    .option("--include-unpaid", "inclui cancelados e expirados")
    .option("--filename <name>", "nome do arquivo")
    .action((options) =>
      invoke(
        "export",
        {
          format: options.format,
          scope: options.scope,
          from: options.from,
          to: options.to,
          include_unpaid: options.includeUnpaid,
          filename: options.filename,
        },
        { json: options.json ?? false },
      ),
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
