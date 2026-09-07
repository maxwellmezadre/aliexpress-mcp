# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [0.1.1] - 2026-09-07

Primeira versão publicada.

> A `0.1.0` foi despublicada logo após sair e o npm queima o par nome+versão
> para sempre, então ela não existe no registro. A tag `v0.1.0` no GitHub
> continua válida e traz os mesmos binários.

### Added

- CLI `aliexpress` e servidor MCP `aliexpress-mcp` sobre um núcleo compartilhado,
  com 12 tools: `auth_status`, `login`, `doctor`, `sync`, `list_orders`,
  `get_order`, `search_products`, `track_order`, `list_refunds`,
  `spending_summary`, `export` e `raw_get`.
- Login interativo por navegador (Playwright) e importação da sessão de um
  navegador já logado no macOS. Sessão cifrada com AES-256-GCM.
- Cliente MTOP assinado, com renovação transparente do token, fila serial,
  backoff e um circuit breaker anti-bot com cooldown persistido.
- Leitura do protocolo Ultron/DX, incluindo a paginação por reenvio de estado
  e a guarda contra a falha silenciosa do `linkage` ausente.
- Cache SQLite com busca textual sem acento, sync em blocos e retomável, e
  `--reparse`, que reprocessa todo o histórico sem usar a rede.
- Rastreio completo (`mtop.ae.ld.querydetail`) e devoluções.
- Exportação para JSON e CSV, restrita a `ALIEXPRESS_EXPORT_DIR`.
- Fixtures reais anonimizadas e um `doctor` que diz qual camada quebrou.

### Notas

- `installments` é sempre `null`: nenhuma API do site expõe a quantidade de
  parcelas. O que existe é `installmentFee`, a taxa cobrada quando houve
  parcelamento — e a presença dela prova que o pedido foi parcelado.
- `order.count` responde `SUCCESS` com zeros mesmo deslogado; a verificação de
  sessão usa `order.list`.
- A soma das linhas do breakdown pode divergir do total em 1 a 3 centavos: o
  AliExpress arredonda cada linha.

[Unreleased]: https://github.com/maxwellmezadre/aliexpress-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/maxwellmezadre/aliexpress-mcp/releases/tag/v0.1.1
