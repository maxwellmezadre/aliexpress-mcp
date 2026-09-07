import { Type } from "@sinclair/typebox";
import { runSyncChunk } from "../cache/sync.js";
import { defineTool } from "./define.js";

export const sync = defineTool({
  name: "sync",
  description:
    "Baixa o histórico do AliExpress para o cache local. Trabalha em blocos: faz até max_requests " +
    "chamadas e devolve `done: false` com `pendingDetails`. CHAME DE NOVO com os mesmos parâmetros " +
    "até `done: true`. Um histórico de ~70 pedidos leva cerca de 80 requisições e 40 s. Nunca " +
    "chame em paralelo nem dispare outras tools de rede junto: o AliExpress derruba a sessão. " +
    "`mode: reparse` reprocessa o que já está no cache sem usar a rede.",
  readOnly: false,
  input: Type.Object({
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("incremental"), Type.Literal("full"), Type.Literal("reparse")],
        {
          description:
            "incremental (default) para na primeira página sem novidades; full percorre tudo; " +
            "reparse reprocessa o cache sem rede",
        },
      ),
    ),
    max_requests: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, description: "Orçamento de requisições (default 40)" }),
    ),
    with_details: Type.Optional(
      Type.Boolean({ description: "Baixa o detalhe de cada pedido (default true)" }),
    ),
    with_tracking: Type.Optional(
      Type.Boolean({ description: "Atualiza o rastreio dos pacotes a caminho (default true)" }),
    ),
    with_refunds: Type.Optional(
      Type.Boolean({ description: "Atualiza as devoluções (default true)" }),
    ),
  }),
  run: (args, ctx) =>
    runSyncChunk(ctx, {
      mode: args.mode,
      maxRequests: args.max_requests,
      withDetails: args.with_details,
      withTracking: args.with_tracking,
      withRefunds: args.with_refunds,
    }),
});
