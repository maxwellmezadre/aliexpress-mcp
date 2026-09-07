import { Type } from "@sinclair/typebox";
import { fetchLogistics } from "../aliexpress/logistics.js";
import { normalizeLogistics } from "../domain/normalize.js";
import { defineTool } from "./define.js";
import { orderIdField } from "./fields.js";

export const trackOrder = defineTool({
  name: "track_order",
  description:
    "Rastreio ao vivo de um pedido: código dos Correios, código logístico do AliExpress, " +
    "transportadora, previsão de entrega e a linha do tempo completa. Sempre gasta 1 requisição " +
    "(é o dado que mais muda) e atualiza o cache. Para um pedido já entregue, `get_order` responde " +
    "de graça. Use `primaryCode` para identificar um evento: a descrição é traduzida.",
  readOnly: true,
  input: Type.Object({
    order_id: orderIdField,
    order_line_id: Type.Optional(
      Type.String({ description: "Restringe a um item específico de um pedido com vários pacotes" }),
    ),
  }),
  run: async (args, ctx) => {
    const module = await fetchLogistics(ctx, args.order_id, args.order_line_id ?? "");
    const packages = normalizeLogistics(module);
    // Only cache the whole-order view; a per-line query is a narrower slice.
    if (!args.order_line_id) ctx.cache().upsertPackages(args.order_id, packages);
    return {
      orderId: args.order_id,
      packageCount: packages.length,
      fetchedAt: new Date(ctx.now()).toISOString(),
      packages: packages.map((pkg) => ({
        trackingNumber: pkg.trackingNumber,
        originTrackingNumber: pkg.originTrackingNumber,
        carrier: pkg.carrier,
        eta: pkg.etaText,
        etaStart: pkg.etaStart,
        etaEnd: pkg.etaEnd,
        items: pkg.items.map((item) => ({ title: item.title, count: item.count })),
        events: pkg.events.map((event) => ({
          at: event.at,
          stage: event.stage,
          description: event.description,
          primaryCode: event.primaryCode,
        })),
      })),
    };
  },
});
