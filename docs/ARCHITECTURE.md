# Arquitetura

```
        ┌──────────────────────────────────────────────┐
        │  Transporte / entradas                        │
        │  src/bin.ts · src/cli/ · src/mcp/             │
        └───────────────┬──────────────────────────────┘
                        │ usa
        ┌───────────────▼──────────────────────────────┐
        │  Aplicação — src/tools/ · src/context.ts      │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  Domínio — src/domain/ · src/cache/           │
        │  (não conhece MCP, CLI nem HTTP)              │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  AliExpress — src/aliexpress/ · src/ultron/ · src/mtop/│
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │  Infra — src/core/ · src/session/ · config    │
        └──────────────────────────────────────────────┘
```

## Fluxo de uma pergunta

1. `bin.ts` decide entre servidor MCP e CLI (import preguiçoso por modo: o
   caminho MCP nunca carrega o commander).
2. `tools/define.ts` valida os argumentos contra o schema TypeBox da tool.
3. A tool lê do **cache** (`cache/repo.ts`) sempre que possível.
4. Quando precisa de rede: `aliexpress/*` monta a chamada, `mtop/client.ts` assina e
   `core/http.ts` a envia, serial, com intervalo, backoff e breaker.
5. `ultron/parse.ts` lê o grafo de componentes, `domain/normalize.ts` o
   converte no modelo, `cache/repo.ts` grava.
6. A resposta sai em JSON pelo MCP ou formatada pelo CLI.

## Regras

1. **Dependências só para dentro.** O SDK do MCP só existe em `src/mcp/`, o
   commander só em `src/cli/`, o `playwright-core` só em `src/session/login.ts`
   (import dinâmico).
2. **`src/domain/normalize.ts` é a única camada que conhece os nomes de
   componente do Ultron e os campos do AliExpress.** Se o site mudar o layout,
   é esse arquivo que quebra.
3. **Toda rede passa por `src/core/http.ts`.** Uma requisição por vez, sempre.
4. **Dinheiro é centavo inteiro para dentro**, número decimal só na borda da
   tool (`cache/rows.ts`).
5. **stdout é do JSON-RPC.** Log só no stderr, com os valores de cookie
   redigidos.
6. **Falha de tool vira `isError`, nunca crash.** Um argumento ruim não pode
   derrubar o servidor.
7. **Nenhum arquivo de lógica passa de ~450 linhas.**

## O que cada diretório faz

| Diretório | Responsabilidade |
| --- | --- |
| `src/core/` | Erros tipados, logger com redação, cliente HTTP serial, helpers de SQLite |
| `src/session/` | Cookie jar puro, sessão cifrada em repouso, login por navegador |
| `src/mtop/` | Assinatura MD5, retry de token, taxonomia dos códigos `ret` |
| `src/ultron/` | Leitura do grafo de componentes e montagem do POST de paginação |
| `src/aliexpress/` | Wrappers tipados dos endpoints; devolvem o payload cru |
| `src/domain/` | Modelo normalizado, dinheiro, datas, status |
| `src/cache/` | Schema, queries, mapeamento de leitura e o sync em blocos |
| `src/tools/` | Uma tool por assunto; o registry é compartilhado com o CLI |

## Testes

- **Unitários** com fixtures reais anonimizadas: `fetch`, relógio e `random`
  são injetados, então backoff e ritmo são verificados sem esperar de verdade.
- **`test/local/`** roda sobre as capturas cruas (`task/captures/`, fora do
  git) e se auto-ignora em outra máquina.
- **`test/integration/`** faz duas chamadas reais, só com `ALIEXPRESS_LIVE=1`.
- **`scripts/verify.ts`** é o portão: typecheck, testes e as invariantes que só
  aparecem com o servidor MCP rodando de verdade.
