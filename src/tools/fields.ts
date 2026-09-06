import { Type } from "@sinclair/typebox";

// Schema fragments shared by several tools, so a description is written once.

export const compactField = Type.Optional(
  Type.Boolean({
    description:
      "Devolve apenas os campos essenciais, para economizar contexto (default ALIEXPRESS_COMPACT)",
  }),
);

export const dayField = (description: string) =>
  Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description }));

export const limitField = (max: number, fallback: number) =>
  Type.Optional(
    Type.Integer({ minimum: 1, maximum: max, description: `Máximo de itens (default ${fallback})` }),
  );

export const offsetField = Type.Optional(
  Type.Integer({ minimum: 0, description: "Itens a pular (paginação)" }),
);

export const orderIdField = Type.String({
  pattern: "^\\d{6,}$",
  description: "Número do pedido no AliExpress (só dígitos), como aparece em `list_orders`",
});
