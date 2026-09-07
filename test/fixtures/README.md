# Fixtures

Respostas **reais** da conta do autor, capturadas em 2026-09-07 e **anonimizadas
deterministicamente** por `scripts/anonymize-fixture.ts` antes de entrar no repositório
(que é público).

| Arquivo | Origem |
|---|---|
| `order-count.json` | `mtop.aliexpress.trade.buyer.order.count` |
| `order-list-init.json` | `mtop.aliexpress.trade.buyer.order.list` (página 1, `renderType: init`) |
| `order-detail.json` | `mtop.aliexpress.trade.buyer.order.detail` (`channel: tracking`) |
| `logistics-querydetail.json` | `mtop.ae.ld.querydetail` (pacote entregue, 26 eventos) |
| `refund-list.json` | `mtop.aliexpress.buyer.reverse.queryreverseorderpagelistforbuyer` (`reverseStatus: 1`) |

## O que a anonimização faz

- **Ids** (todo bloco de 9+ dígitos, inclusive dentro das *chaves* dos componentes Ultron):
  remapeados por `sha256(salt + valor)` mantendo o comprimento e os 4 primeiros dígitos.
  O mapa é determinístico, então **as relações sobrevivem** — o `tradeOrderId` do detalhe
  continua sendo um dos `orderId` da lista.
- **Valores monetários nunca são tocados** (nenhum tem 9 dígitos), então as identidades
  financeiras continuam verdadeiras: no `order-detail`,
  `126,59 − 5,66 − 10,80 + 22,61 = 132,74`.
- **PII** (nome, telefone, endereço, CEP, cidade, código de rastreio, nome de loja, título
  de produto) trocada por valores fixos ou por palavras de um dicionário por hash.
- **`linkage`** vira um stub: é um blob assinado, atrelado à sessão, e nunca deve ser publicado.
- Blocos volumosos e inúteis para os testes (`i18nMap`, `pageResources`, `contentText`,
  `utParams`, `exposeInfo`) são removidos.

`test/fixtures.test.ts` é a guarda permanente: falha se e-mail, CEP, rastreio real ou
nome de cookie de sessão aparecer aqui.

## Corpus completo

As capturas cruas ficam em `task/captures/` (gitignored, 0600) e alimentam
`test/local/*.local.test.ts`, que se auto-ignora quando a pasta não existe.
