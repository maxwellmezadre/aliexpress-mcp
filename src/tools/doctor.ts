import { Type } from "@sinclair/typebox";
import {
  assertDetailUsable,
  fetchOrderCount,
  fetchOrderDetail,
  fetchOrderListInit,
  fetchOrderListPage,
} from "../ae/orders.js";
import { fetchAllRefunds } from "../ae/refunds.js";
import type { Ctx } from "../context.js";
import { ParseError } from "../core/errors.js";
import { breakdownTotal, normalizeOrderDetail, normalizeOrderList } from "../domain/normalize.js";
import { listOrders as listOrderComponents } from "../ultron/parse.js";
import type { UltronResponse } from "../ultron/types.js";
import { defineTool } from "./define.js";

// Layer-by-layer diagnostics. When AliExpress changes something, this says
// WHICH layer broke instead of leaving a tool with a vague error. Each check is
// best-effort and never throws; the report is what matters.

type Check = { name: string; ok: boolean; detail: string };

const CHECK_ORDER = [
  "session",
  "order_count",
  "list_init",
  "list_paging",
  "list_paging_without_linkage",
  "detail_trade_order_id",
  "detail_wrong_parameter",
  "money_identity",
  "refunds",
  "cache",
] as const;

export const doctor = defineTool({
  name: "doctor",
  description:
    "Diagnóstico camada a camada: sessão, assinatura MTOP, listagem, paginação Ultron (inclusive o " +
    "teste negativo de `linkage`), detalhe (com `tradeOrderId` e com o parâmetro errado), somas de " +
    "dinheiro, devoluções e cache. Use quando algo falhar de um jeito estranho — ele diz qual " +
    "camada quebrou. Gasta cerca de 5 requisições.",
  readOnly: true,
  input: Type.Object({
    deep: Type.Optional(
      Type.Boolean({ description: "Também testa a paginação e o detalhe (mais 3 requisições)" }),
    ),
  }),
  run: async (args, ctx) => {
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };
    const deep = args.deep !== false;

    // 1. Session
    const session = ctx.session.load();
    if (!session) {
      add("session", false, "Nenhuma sessão salva. Rode `aliexpress login`.");
      return report(checks, ctx);
    }
    add(
      "session",
      true,
      `${session.cookies.length} cookies (${session.cookies.filter((c) => c.httpOnly).length} HttpOnly), ` +
        `${session.regional.region}/${session.regional.locale}/${session.regional.currency}`,
    );

    // 2. The cheap endpoint: proves the signature, NOT the session.
    try {
      const counts = await fetchOrderCount(ctx);
      add(
        "order_count",
        true,
        `assinatura MTOP aceita (${JSON.stringify(counts)}). Atenção: esta API responde SUCCESS ` +
          "mesmo deslogado, então não prova a sessão.",
      );
    } catch (error) {
      add("order_count", false, message(error));
    }

    // 3. The listing: this is what really requires a live session.
    let firstPage: UltronResponse | null = null;
    try {
      firstPage = await fetchOrderListInit(ctx, { statusTab: "all", timeOption: "all" });
      const orders = normalizeOrderList(firstPage, { statusTab: "all" });
      const unknown = orders.filter((order) => order.status === "unknown");
      add(
        "list_init",
        orders.length > 0,
        `${orders.length} pedidos na página 1` +
          (unknown.length > 0
            ? `; ${unknown.length} com status não mapeado: ${[...new Set(unknown.map((o) => o.statusText))].join(", ")}`
            : "; todos os status mapeados"),
      );
    } catch (error) {
      add("list_init", false, message(error));
    }

    if (deep && firstPage) {
      // 4. Ultron paging, and the negative test that catches a missing linkage.
      try {
        const second = await fetchOrderListPage(ctx, firstPage, 2, { statusTab: "all" });
        add("list_paging", listOrderComponents(second).length > 0, `página 2 com ${listOrderComponents(second).length} pedidos`);
      } catch (error) {
        add("list_paging", false, message(error));
      }
      try {
        await fetchOrderListPage(ctx, { ...firstPage, linkage: undefined }, 2);
        add(
          "list_paging_without_linkage",
          false,
          "paginar sem `linkage` NÃO foi detectado — a guarda contra a página vazia silenciosa quebrou",
        );
      } catch (error) {
        add(
          "list_paging_without_linkage",
          error instanceof ParseError,
          error instanceof ParseError
            ? "a guarda contra `linkage` ausente está ativa (nenhuma requisição gasta)"
            : message(error),
        );
      }

      // 5. The detail, and the classic wrong-parameter trap.
      const orderId = normalizeOrderList(firstPage)[0]?.orderId;
      if (orderId) {
        try {
          const page = await fetchOrderDetail(ctx, orderId);
          const summary = normalizeOrderList(firstPage)[0];
          const detail = normalizeOrderDetail(page, summary as never);
          add(
            "detail_trade_order_id",
            detail.priceBreakdown.length > 0,
            `${detail.priceBreakdown.length} linhas de preço; pagamento: ${detail.paymentMethod ?? "?"}`,
          );

          const sum = breakdownTotal(detail.priceBreakdown);
          const total = detail.total;
          const diff = sum && total ? Math.abs(sum.cents - total.cents) : null;
          add(
            "money_identity",
            diff !== null && diff <= 15,
            diff === null
              ? "não foi possível somar o breakdown"
              : `Σ linhas − total = ${diff} centavo(s) (o AliExpress arredonda cada linha; até ~3 é normal)`,
          );
        } catch (error) {
          add("detail_trade_order_id", false, message(error));
        }

        // The classic trap: with `orderId` the API answers SUCCESS and an empty
        // page skeleton, which reads like a deleted order. The guard must catch it.
        try {
          const wrong = await ctx.mtop.request<UltronResponse>({
            api: "mtop.aliexpress.trade.buyer.order.detail",
            data: { orderId, clientPlatform: "pc" },
          });
          assertDetailUsable(wrong.data, orderId);
          add(
            "detail_wrong_parameter",
            false,
            "chamar o detalhe com `orderId` devolveu uma página real — a armadilha mudou, revise `fetchOrderDetail`",
          );
        } catch (error) {
          add(
            "detail_wrong_parameter",
            error instanceof ParseError,
            error instanceof ParseError
              ? "a guarda contra o parâmetro errado (`orderId` em vez de `tradeOrderId`) está ativa"
              : message(error),
          );
        }
      }
    }

    // 6. Refunds
    try {
      const page = await fetchAllRefunds(ctx);
      add("refunds", true, `total informado: ${page.total ?? 0}, grupos recebidos: ${page.items?.length ?? 0}`);
    } catch (error) {
      add("refunds", false, message(error));
    }

    return report(checks, ctx);
  },
});

function report(checks: Check[], ctx: Ctx) {
  const stats = ctx.cache().stats();
  checks.push({
    name: "cache",
    ok: stats.orders > 0,
    detail:
      stats.orders === 0
        ? "cache vazio — rode `sync`"
        : `${stats.orders} pedidos (${stats.withDetail} com detalhe), ${stats.lines} itens, ` +
          `${stats.packages} pacotes, ${stats.refunds} devoluções, ${stats.oldestOrder} → ${stats.newestOrder}`,
  });
  const ordered = [...checks].sort(
    (a, b) => rank(a.name) - rank(b.name),
  );
  return { ok: ordered.every((check) => check.ok), checks: ordered };
}

const rank = (name: string): number => {
  const index = (CHECK_ORDER as readonly string[]).indexOf(name);
  return index === -1 ? CHECK_ORDER.length : index;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
