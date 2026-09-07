import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detailFromCache, summaryFromRow } from "../cache/rows.js";
import { toDecimal } from "../domain/money.js";
import { defineTool } from "./define.js";
import { dayField } from "./fields.js";

// Writes a file. The only tool that touches the disk outside the config dir,
// and it may only write inside ALIEXPRESS_EXPORT_DIR.

const SCOPES = ["orders", "lines", "packages", "refunds"] as const;

export const exportData = defineTool({
  name: "export",
  description:
    "Exporta o cache para um arquivo JSON ou CSV (pedidos, itens, pacotes ou devoluções). Grava " +
    "somente dentro de ALIEXPRESS_EXPORT_DIR (default ~/Downloads/aliexpress-export) e devolve o " +
    "caminho. Valores em reais, datas ISO.",
  readOnly: false,
  input: Type.Object({
    format: Type.Union([Type.Literal("json"), Type.Literal("csv")], {
      description: "Formato do arquivo",
    }),
    scope: Type.Union(
      SCOPES.map((scope) => Type.Literal(scope)),
      { description: "O que exportar" },
    ),
    from: dayField("Data inicial do pedido (YYYY-MM-DD)"),
    to: dayField("Data final inclusiva (YYYY-MM-DD)"),
    include_unpaid: Type.Optional(
      Type.Boolean({ description: "Inclui cancelados e expirados (default false)" }),
    ),
    filename: Type.Optional(
      Type.String({ description: "Nome do arquivo (sem diretório). Default: aliexpress-<escopo>-<data>" }),
    ),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const filters = {
      from: args.from,
      to: args.to,
      includeUnpaid: args.include_unpaid,
      limit: 100_000,
    };
    const orders = cache.listOrders(filters);
    const rows = buildRows(args.scope, orders, cache);

    const stamp = new Date(ctx.now()).toISOString().slice(0, 10);
    const name = sanitize(args.filename ?? `aliexpress-${args.scope}-${stamp}.${args.format}`);
    const dir = resolve(ctx.config.exportDir);
    const target = resolve(join(dir, name));
    // A filename can still try to escape with `..`; resolve and compare.
    if (target !== join(dir, name) || !target.startsWith(`${dir}/`)) {
      throw new Error(
        `Caminho fora de ALIEXPRESS_EXPORT_DIR (${dir}). O export só grava dentro desse diretório.`,
      );
    }

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const content = args.format === "json" ? `${JSON.stringify(rows, null, 2)}\n` : toCsv(rows);
    writeFileSync(target, content, { mode: 0o600 });

    return { path: target, format: args.format, scope: args.scope, rows: rows.length };
  },
});

/** Strips any directory component: the tool picks the directory, not the caller. */
const sanitize = (name: string): string => name.replace(/[/\\]/g, "_").replace(/^\.+/, "");

type Row = Record<string, string | number | null>;

function buildRows(
  scope: (typeof SCOPES)[number],
  orders: ReturnType<ReturnType<typeof import("../cache/repo.js").createCacheRepo>["listOrders"]>,
  cache: ReturnType<typeof import("../cache/repo.js").createCacheRepo>,
): Row[] {
  if (scope === "orders") {
    return orders.map((row) => {
      const detail = detailFromCache(cache, row);
      return {
        orderId: row.order_id,
        date: row.order_date,
        status: row.status,
        store: row.store_name,
        total: row.total_cents === null ? null : toDecimal(row.total_cents),
        currency: row.currency,
        itemCount: row.item_count,
        paymentMethod: row.payment_method,
        installmentFee: detail.installmentFee ? toDecimal(detail.installmentFee.cents) : null,
        paidAt: row.paid_at,
        finishedAt: row.finished_at,
      };
    });
  }
  if (scope === "lines") {
    return orders.flatMap((row) =>
      summaryFromRow(row, cache.getLines(row.order_id)).lines.map((line) => ({
        orderId: row.order_id,
        date: row.order_date,
        store: row.store_name,
        title: line.title,
        variations: line.skuAttrs.map((attr) => `${attr.name}: ${attr.value}`).join(", ") || null,
        quantity: line.quantity,
        unitPrice: line.unitPrice ? toDecimal(line.unitPrice.cents) : null,
        lineTotal: line.lineTotal ? toDecimal(line.lineTotal.cents) : null,
        currency: line.unitPrice?.currency ?? null,
      })),
    );
  }
  if (scope === "packages") {
    return orders.flatMap((row) =>
      cache.getPackages(row.order_id).map((pkg) => ({
        orderId: row.order_id,
        date: row.order_date,
        trackingNumber: pkg.trackingNumber,
        originTrackingNumber: pkg.originTrackingNumber,
        carrier: pkg.carrier,
        eta: pkg.etaText,
        lastEvent: pkg.events[0]?.description ?? null,
        lastEventAt: pkg.events[0]?.at ?? null,
        events: pkg.events.length,
      })),
    );
  }
  return cache.listRefunds(100_000).map((row) => ({
    reverseOrderId: (row.reverse_order_id as string) ?? null,
    orderId: (row.order_id as string) ?? null,
    type: (row.type as string) ?? null,
    status: (row.status as number) ?? null,
    createdAt: (row.created_at as string) ?? null,
    store: (row.store_name as string) ?? null,
    title: (row.title as string) ?? null,
    count: (row.count as number) ?? null,
    unitPrice: row.unit_cents === null ? null : toDecimal(row.unit_cents as number),
  }));
}

/** RFC 4180: quote everything that could contain a separator, escape the quotes. */
function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] as Row);
  const cell = (value: string | number | null): string => {
    if (value === null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => cell(row[header] ?? null)).join(","));
  return `${lines.join("\n")}\n`;
}
