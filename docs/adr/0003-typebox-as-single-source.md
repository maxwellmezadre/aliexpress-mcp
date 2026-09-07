# ADR-0003 — TypeBox como fonte única do schema

- **Status:** Aceito
- **Contexto:** Cada tool precisa de três coisas: o tipo estático dos
  argumentos, um validador em runtime e o JSON Schema anunciado ao cliente MCP.
  Manter os três à mão diverge; usar Zod exige uma ponte para JSON Schema.

## Decisão

Um `Type.Object({...})` por tool é as três coisas: `Static<S>` dá o tipo,
`Value.Check` valida, e o objeto **é** um JSON Schema válido, anunciado
verbatim. A spec original pedia Zod; TypeBox venceu por eliminar a conversão.

## Consequências

Zero divergência entre o que o modelo vê e o que o código aceita. `defineTool`
apaga o genérico na fronteira para que tools de schemas diferentes convivam num
mesmo array, com o `run` ainda tipado por dentro.
