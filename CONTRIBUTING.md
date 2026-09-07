# Contribuindo

## Ambiente

```sh
bun install
bun run verify     # tsc --noEmit + bun test + as invariantes do servidor MCP
```

`bun run verify` é o portão. Se ele passa, o PR passa.

## Convenções

- **Código, comentários, testes e commits em inglês.** Documentação, descrições
  de tools, help do CLI e mensagens de erro em **pt-BR**: quem lê essas é o
  usuário.
- Sem linter. O gate é `tsc` estrito (`noUncheckedIndexedAccess`, `noUnused*`,
  `verbatimModuleSyntax`) mais os testes.
- Nenhum arquivo de lógica acima de ~450 linhas.
- Comentários explicam **por quê**, não o quê. Uma simplificação deliberada
  leva um comentário que diz qual é o teto e qual seria a saída.
- Conventional Commits, sem escopo, uma linha, até 72 caracteres.

## Regras de arquitetura

Estas não são estilo, são o que mantém o projeto consertável quando o
AliExpress mudar (veja [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):

1. Nenhuma rede fora de `src/core/http.ts`.
2. Só `src/domain/normalize.ts` conhece nomes de campo do AliExpress.
3. SDK do MCP só em `src/mcp/`; commander só em `src/cli/`; `playwright-core`
   só em `src/session/login.ts`, por import dinâmico (ele vai embutido no
   binário, mas o caminho do servidor MCP nunca o carrega).
4. Dinheiro em centavo inteiro para dentro; decimal só na borda da tool.
5. stdout é do JSON-RPC. Log só no stderr.
6. Falha de tool vira `isError`, nunca crash.
7. **Nada de escrita na conta.** Nem uma tool, nem um caminho no `raw_get`.

## Testes

Escreva testes que teriam pego um bug de verdade: regra de negócio, segurança,
regressão. Não escreva testes que reafirmam estruturas estáticas.

- Injete `fetch`, relógio e `random`. Nada de esperar de verdade nem de
  timers falsos globais.
- Use as fixtures reais anonimizadas. Se precisar de uma nova, capture e passe
  pelo anonimizador (nunca commite dado cru).
- Mudou um parser? Incremente `PARSER_VERSION` em `src/cache/sync.ts`.
- Mudou uma tool? `bun run docs:tools`.

## Publicando

A tag `vX.Y.Z` dispara o release: binários para Linux, macOS e Windows, e o
publish no npm por OIDC (trusted publishing, sem token).

Uma ressalva do npm: a primeira versão de um pacote novo não sai por OIDC. O
npmjs exige que o pacote exista para você configurar o trusted publisher, e
exige o trusted publisher para publicar ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
Então a primeira versão foi publicada à mão (`npm publish --access public --otp=…`)
e o trusted publisher foi configurado depois. O workflow pula a publicação
quando a versão já está no registro, em vez de falhar.

## Dado pessoal

O repositório é público. `test/fixtures.test.ts` falha se e-mail, CEP, código
de rastreio real ou nome de cookie de sessão aparecer nas fixtures. `task/` é
gitignored e é onde ficam as capturas cruas e o salt. Não tire nada de lá.
