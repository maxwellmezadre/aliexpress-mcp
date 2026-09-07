# ADR-0004 — `Server` de baixo nível do SDK do MCP

- **Status:** Aceito
- **Contexto:** `McpServer.registerTool` espera um schema Zod/Standard. O
  projeto tem TypeBox (ADR-0003).

## Decisão

Usar o `Server` de baixo nível com `setRequestHandler`, passando o objeto
TypeBox direto como `inputSchema`. Todo uso do SDK fica confinado em
`src/mcp/server.ts`.

## Consequências

Nenhuma ponte de schema e uma fonte só de verdade. Em troca, acoplamento à API
de baixo nível do SDK — mitigado pelo pin de versão e pelo isolamento num único
arquivo de 55 linhas. O `ListTools` também publica `annotations`
(`readOnlyHint`, `destructiveHint`), o que um cliente usa para decidir o que
pode chamar sozinho.
