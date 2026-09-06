import { Type } from "@sinclair/typebox";
import { defineTool } from "./define.js";

// Escape hatch for rediscovery when AliExpress changes something (see
// docs/REDISCOVERY.md). It rides the same signature, rate limit and breaker as
// every other call, and it is fenced in two ways:
//   - the api name must belong to the AliExpress MTOP namespace;
//   - anything that writes to the account is refused outright.

/** Only the buyer-facing MTOP namespaces. */
export const API_PATTERN = /^mtop\.(aliexpress|ae)\.[a-zA-Z0-9._]{3,90}$/;

/**
 * Write APIs. `order.operation` confirms delivery, cancels orders and opens
 * disputes — this server is strictly read-only, so it is refused even though
 * the signature would work.
 */
export const FORBIDDEN_API = /(\.operation|\.submit|\.create|\.modify|\.delete|\.cancel|\.confirm)$/i;

export const MAX_RAW_BYTES = 64 * 1024;

export const rawGet = defineTool({
  name: "raw_get",
  description:
    "Chama uma API MTOP do AliExpress diretamente (assinada, com o mesmo limite de taxa). Serve para " +
    "redescobrir um endpoint quando o site muda — use com parcimônia e nunca em rajada. Só APIs " +
    "`mtop.aliexpress.*` / `mtop.ae.*` de leitura: qualquer API de escrita (`*.operation` e afins) é " +
    "recusada, porque este servidor nunca altera a conta.",
  readOnly: true,
  input: Type.Object({
    api: Type.String({
      description: "Nome da API, ex.: mtop.aliexpress.trade.buyer.order.count",
    }),
    v: Type.Optional(Type.String({ description: "Versão da API (default 1.0)" })),
    method: Type.Optional(
      Type.Union([Type.Literal("GET"), Type.Literal("POST")], {
        description: "Método MTOP (default GET)",
      }),
    ),
    data: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Payload da API. shipToCountry e _lang são preenchidos a partir da sessão quando ausentes.",
      }),
    ),
    max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: MAX_RAW_BYTES,
        description: `Corta a resposta neste tamanho (default ${MAX_RAW_BYTES})`,
      }),
    ),
  }),
  run: async (args, ctx) => {
    const api = args.api.trim();
    if (!API_PATTERN.test(api)) {
      throw new Error(
        `API fora do escopo: "${api}". Só são aceitas APIs mtop.aliexpress.* ou mtop.ae.* do comprador.`,
      );
    }
    if (FORBIDDEN_API.test(api)) {
      throw new Error(
        `API de escrita recusada: "${api}". O aliexpress-mcp é somente leitura e nunca altera a conta.`,
      );
    }

    const response = await ctx.mtop.request({
      api,
      ...(args.v ? { v: args.v } : {}),
      ...(args.method ? { method: args.method } : {}),
      data: args.data ?? {},
    });

    const limit = args.max_bytes ?? MAX_RAW_BYTES;
    const serialized = JSON.stringify(response.data ?? null);
    const truncated = serialized.length > limit;
    return {
      api: response.api,
      v: response.v,
      ret: response.ret,
      truncated,
      bytes: serialized.length,
      data: truncated ? `${serialized.slice(0, limit)}…` : (response.data ?? null),
    };
  },
});
