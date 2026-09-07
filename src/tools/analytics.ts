import { Type } from "@sinclair/typebox";
import { toDecimal } from "../domain/money.js";
import { compactObject, defineTool } from "./define.js";
import { dayField } from "./fields.js";

const GROUPS = ["month", "year", "store", "payment_method", "breakdown"] as const;

const NOTES: Record<(typeof GROUPS)[number], string> = {
  month: "Total por mês (YYYY-MM), pela data do pedido.",
  year: "Total por ano, pela data do pedido.",
  store: "Total por loja.",
  payment_method:
    "Total por forma de pagamento. Só aparece para pedidos cujo detalhe já foi sincronizado.",
  breakdown:
    "Para onde o dinheiro foi: subtotal, imposto, frete, taxa de parcelamento e descontos " +
    "(negativos). Vem do detalhe de cada pedido; a soma das linhas pode divergir do total em " +
    "1 a 3 centavos porque o AliExpress arredonda cada linha.",
};

export const spendingSummary = defineTool({
  name: "spending_summary",
  description:
    "Agrega os gastos do cache local por mês, ano, loja, forma de pagamento, ou em `breakdown` " +
    "(quanto foi imposto, frete, taxa de parcelamento e cupons). Pedidos cancelados ou expirados " +
    "ficam de fora por padrão — neles nada foi pago. Rode `sync` antes para ter o histórico completo.",
  readOnly: true,
  input: Type.Object({
    group_by: Type.Union(
      GROUPS.map((group) => Type.Literal(group)),
      { description: "month | year | store | payment_method | breakdown" },
    ),
    from: dayField("Data inicial (YYYY-MM-DD), pela data do pedido"),
    to: dayField("Data final inclusiva (YYYY-MM-DD)"),
    include_unpaid: Type.Optional(
      Type.Boolean({ description: "Inclui cancelados e expirados (default false)" }),
    ),
  }),
  run: (args, ctx) => {
    const cache = ctx.cache();
    const filters = { from: args.from, to: args.to, includeUnpaid: args.include_unpaid };
    const rows =
      args.group_by === "breakdown"
        ? cache.spendingBreakdown(filters)
        : cache.spendingSummary(args.group_by, filters);

    const currency = cache.listOrders({ limit: 1, includeUnpaid: true })[0]?.currency ?? null;
    return compactObject({
      groupBy: args.group_by,
      period: { from: args.from ?? null, to: args.to ?? null },
      includeUnpaid: args.include_unpaid === true,
      currency,
      rows: rows.map((row) => ({
        key: row.key,
        orders: row.orders,
        ...(args.group_by === "breakdown" ? {} : { items: row.items }),
        total: toDecimal(row.totalCents),
      })),
      // For `breakdown` the rows are components of one total, so summing them
      // is meaningful; for the others it is the grand total of the period.
      grandTotal: toDecimal(rows.reduce((sum, row) => sum + row.totalCents, 0)),
      note: NOTES[args.group_by],
    });
  },
});
