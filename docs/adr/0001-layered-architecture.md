# ADR-0001 — Arquitetura em camadas, pragmática

- **Status:** Aceito
- **Contexto:** O projeto fala uma API interna instável, guarda dados sensíveis
  e serve duas interfaces (MCP e CLI). Sem separação, uma mudança no AliExpress
  espalha edição por todo lado; com separação demais, um projeto pessoal vira
  cerimônia.

## Decisão

Camadas com dependência só para dentro — transporte → aplicação → domínio →
AliExpress → infra — sem container de injeção, sem repositório genérico, sem
serviço para cada substantivo. `createContext(loadConfig())` é a fiação inteira.

Duas regras carregam o peso: **toda rede passa por `src/core/http.ts`** e
**`src/domain/normalize.ts` é a única camada que conhece os nomes de campo do
AliExpress**.

## Consequências

Uma mudança de layout quebra um arquivo, e o `doctor` diz qual. Em troca, é
preciso disciplina: nada de importar o SDK do MCP fora de `src/mcp/`.
