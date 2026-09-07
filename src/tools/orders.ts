import { Type } from "@sinclair/typebox";
import { fetchOrderDetail } from "../aliexpress/orders.js";
import { PARSER_VERSION } from "../cache/sync.js";
import { detailFromCache, detailOut, moneyOut, summaryFromRow, summaryOut } from "../cache/rows.js";
import { normalizeOrderDetail } from "../domain/normalize.js";
import { ORDER_STATUSES } from "../domain/status.js";
import { compactObject, defineTool } from "./define.js";
import { compactField, dayField, limitField, offsetField, orderIdField } from "./fields.js";

// Reading the purchase history. Everything here answers from the local cache;
// `get_order` is the only one that may spend a request, and only when the
// order's detail was never fetched.

const CACHE_HINT =
  "O cache está vazio. Rode `sync` (ou `aliexpress sync` no terminal) para preenchê-lo.";

const statusField = Type.Optional(
  Type.Union(
    ORDER_STATUSES.map((status) => Type.Literal(status)),
    {
      description:
        "Filtra por situação. `expired` e `cancelled` são pedidos em que nada foi pago e ficam " +
        "fora dos resultados por padrão.",
    },
  ),
);

export const listOrders = defineTool({
  name: "list_orders",
  description:
    "Lista os pedidos do AliExpress a partir do cache local, do mais novo para o mais antigo, com " +
    "os produtos de cada um. Filtra por situação, período e loja. Pedidos cancelados ou expirados " +
    "(nada foi pago) ficam de fora, a menos que include_unpaid seja true. Rode `sync` antes se o " +
    "cache estiver vazio.",
  readOnly: true,
  input: Type.Object({
    status: statusField,
    from: dayField("Data inicial do pedido (YYYY-MM-DD)"),
    to: dayField("Data final inclusiva (YYYY-MM-DD)"),
    store: Type.Optional(Type.String({ description: "Trecho do nome da loja" })),
    include_unpaid: Type.Optional(
      Type.Boolean({ description: "Inclui cancelados e expirados (default false)" }),
    ),
    limit: limitField(200, 50),
    offset: offsetField,
    compact: compactField,
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const filters = {
      status: args.status,
      from: args.from,
      to: args.to,
      store: args.store,
      includeUnpaid: args.include_unpaid,
      limit: args.limit ?? 50,
      offset: args.offset ?? 0,
    };
    const rows = cache.listOrders(filters);
    const total = cache.countOrders(filters);
    return compactObject({
      total,
      returned: rows.length,
      offset: filters.offset,
      hasMore: filters.offset + rows.length < total,
      orders: rows.map((row) =>
        summaryOut(summaryFromRow(row, cache.getLines(row.order_id)), args.compact === true),
      ),
      note: cache.stats().orders === 0 ? CACHE_HINT : undefined,
    });
  },
});

export const getOrder = defineTool({
  name: "get_order",
  description:
    "Detalhe completo de um pedido: produtos, breakdown de preço (subtotal, frete, imposto, cupons, " +
    "taxa de parcelamento), datas, forma de pagamento e linha do tempo. Lê do cache; se o detalhe " +
    "ainda não tiver sido baixado, gasta 1 requisição e grava. `installments` é SEMPRE null: o " +
    "AliExpress não expõe a quantidade de parcelas em nenhuma API; `installmentFee` aparece quando " +
    "houve cobrança de parcelamento. O endereço só vem com include_address.",
  readOnly: true,
  input: Type.Object({
    order_id: orderIdField,
    include_address: Type.Optional(
      Type.Boolean({ description: "Inclui o endereço de entrega gravado no pedido (default false)" }),
    ),
    refresh: Type.Optional(
      Type.Boolean({ description: "Busca o detalhe de novo mesmo se já estiver no cache" }),
    ),
  }),
  run: async (args, ctx) => {
    const cache = ctx.cache();
    let row = cache.getOrder(args.order_id);
    const needsFetch = args.refresh === true || row === null || row.detail_fetched_at === null;

    if (needsFetch) {
      const page = await fetchOrderDetail(ctx, args.order_id);
      const summary = row
        ? summaryFromRow(row, cache.getLines(args.order_id))
        : {
            orderId: args.order_id,
            orderDate: null,
            orderDateText: null,
            status: "unknown" as const,
            statusText: null,
            statusTab: null,
            total: null,
            store: { name: null, storeId: null, url: null },
            paymentOutId: null,
            itemCount: 0,
            lines: [],
          };
      const detail = normalizeOrderDetail(page, summary);
      // An order that was never listed has no row to update.
      if (!row) cache.upsertSummary(detail);
      cache.upsertDetail(detail, JSON.stringify(page), PARSER_VERSION);
      row = cache.getOrder(args.order_id);
    }

    if (!row) throw new Error(`Pedido ${args.order_id} não encontrado nesta conta.`);
    const detail = detailFromCache(cache, row);
    return {
      ...detailOut(detail, { includeAddress: args.include_address === true }),
      source: needsFetch ? "live" : "cache",
      packages: cache.getPackages(args.order_id).length,
    };
  },
});

export const searchProducts = defineTool({
  name: "search_products",
  description:
    "Busca textual nos produtos já comprados (título, variação e loja), sem acento e sem " +
    "diferenciar maiúsculas. Responde do cache, sem rede. Serve para 'quando comprei X' e " +
    "'quanto paguei em X'.",
  readOnly: true,
  input: Type.Object({
    query: Type.String({ minLength: 2, description: "Texto a procurar" }),
    from: dayField("Data inicial do pedido (YYYY-MM-DD)"),
    to: dayField("Data final inclusiva (YYYY-MM-DD)"),
    limit: limitField(200, 50),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const rows = cache.searchLines(args.query, {
      from: args.from,
      to: args.to,
      limit: args.limit ?? 50,
    });
    return compactObject({
      total: rows.length,
      items: rows.map((row) => ({
        orderId: row.order_id,
        date: row.order_date,
        status: row.status,
        store: row.store_name,
        title: row.title,
        quantity: row.quantity,
        unitPrice: moneyOut(
          row.unit_cents === null ? null : { cents: row.unit_cents, currency: row.currency ?? "", text: "" },
        ),
        lineTotal: moneyOut(
          row.line_cents === null ? null : { cents: row.line_cents, currency: row.currency ?? "", text: "" },
        ),
      })),
      note: cache.stats().orders === 0 ? CACHE_HINT : undefined,
    });
  },
});
