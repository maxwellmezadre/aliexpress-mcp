import { Type } from "@sinclair/typebox";
import { fetchAllRefunds } from "../ae/refunds.js";
import { moneyOut } from "../cache/rows.js";
import { normalizeRefundPage } from "../domain/normalize.js";
import { compactObject, defineTool } from "./define.js";
import { limitField } from "./fields.js";

export const listRefunds = defineTool({
  name: "list_refunds",
  description:
    "Devoluções e reembolsos da conta, do mais recente para o mais antigo, com o pedido de origem " +
    "e o preço unitário do item devolvido. Lê do cache; com refresh=true busca ao vivo. ATENÇÃO: o " +
    "AliExpress não expõe nesta API o valor efetivamente reembolsado, só o preço do item — não " +
    "apresente `unitPrice` como se fosse o valor devolvido.",
  readOnly: true,
  input: Type.Object({
    refresh: Type.Optional(
      Type.Boolean({ description: "Busca ao vivo em vez de ler o cache (1 requisição)" }),
    ),
    limit: limitField(200, 50),
  }),
  run: async (args, ctx) => {
    const cache = ctx.cache();
    if (args.refresh) {
      const page = await fetchAllRefunds(ctx);
      cache.upsertRefunds(normalizeRefundPage(page));
    }
    const rows = cache.listRefunds(args.limit ?? 50);
    return compactObject({
      total: rows.length,
      source: args.refresh ? "live" : "cache",
      refunds: rows.map((row) => ({
        reverseOrderId: row.reverse_order_id,
        orderId: row.order_id,
        type: row.type,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        store: row.store_name,
        title: row.title,
        count: row.count,
        unitPrice: moneyOut(
          row.unit_cents === null
            ? null
            : {
                cents: row.unit_cents as number,
                currency: (row.currency as string) ?? "",
                text: "",
              },
        ),
      })),
      note: "unitPrice é o preço do item, não o valor reembolsado — essa API não expõe o reembolso.",
    });
  },
});
