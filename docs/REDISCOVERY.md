# Quando o AliExpress mudar

Este projeto fala uma API interna. Ela vai mudar. Este é o roteiro que produziu
o mapeamento atual e que vai produzir o próximo.

## 1. Pergunte ao `doctor` primeiro

```sh
aliexpress doctor
```

Ele testa camada a camada e diz qual quebrou: sessão, assinatura MTOP,
listagem, paginação (inclusive o teste negativo do `linkage`), detalhe (com
`tradeOrderId` e com o parâmetro errado), somas de dinheiro, devoluções, cache.

| Camada que falhou | Onde olhar |
| --- | --- |
| `session` | `src/session/`, e refaça o login |
| `order_count` | `src/mtop/sign.ts` — a assinatura mudou |
| `list_init` | `src/aliexpress/orders.ts` e `src/domain/normalize.ts` |
| `list_paging` | `src/ultron/parse.ts` — o empacotamento do POST |
| `detail_*` | `src/aliexpress/orders.ts` — o nome do parâmetro ou os componentes |
| `money_identity` | `src/domain/money.ts` ou os rótulos em `normalize.ts` |

Um pedido com status `unknown` significa um rótulo novo: o `doctor` mostra o
texto, e mapear é uma linha em `src/domain/status.ts`.

## 2. Leia o que a própria página declara

Abra a página logada e procure no HTML por `var prefetch`:

```js
var prefetch = { api: "…", method: "…", v: "1.0", data: { … } }
```

É onde o endpoint inicial e **os nomes exatos dos parâmetros** aparecem em
texto claro. Foi assim que se descobriu que o detalhe usa `tradeOrderId`.

## 3. Use o SDK da própria página

No console da página logada:

```js
await window.lib.mtop.request({
  api: "mtop.aliexpress.trade.buyer.order.list",
  v: "1.0", type: "GET", needLogin: true, dataType: "json",
  data: { statusTab: "all", renderType: "init", clientPlatform: "pc" },
})
```

Isso executa qualquer API MTOP **já assinada e autenticada**, o que permite
descobrir parâmetros sem reimplementar nada.

## 4. Instrumente as chamadas disparadas por clique

Paginação e popovers só acontecem na interação. Antes de clicar:

```js
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (...args) { console.log("XHR", args); return open.apply(this, args); };
const fetch0 = window.fetch;
window.fetch = (...args) => { console.log("fetch", args[0]); return fetch0(...args); };
```

## 5. Enumere as APIs que a página conhece

```js
const bundle = "https://assets.aliexpress-media.com/g/ae-dida/order-list/<versão>/index.js";
fetch(bundle).then((r) => r.text()).then((t) => console.log([...new Set(t.match(/mtop\.[a-zA-Z0-9._]{5,90}/g))]));
```

Bundles úteis: `order-list/<v>/index.js` (lista), `order-list/<v>/detail.js`
(detalhe e rastreio), `ae-fe/cosmos/<v>/pc/mtop.js` (**o SDK MTOP**: assinatura,
`__processToken`, retry, constantes de erro).

## 6. Valide de fora do navegador

```sh
aliexpress raw mtop.aliexpress.trade.buyer.order.count -d '{"clientPlatform":"pc"}'
```

`raw_get` usa a mesma assinatura, o mesmo limite de ritmo e o mesmo breaker das
outras tools, e recusa qualquer API de escrita. Se voltar `SUCCESS`, a
assinatura está certa.

## 7. Recapture as fixtures

```sh
bun run scripts/capture-fixtures.ts          # dry-run: mostra o que viria
bun run scripts/capture-fixtures.ts --write  # grava em task/captures/ (fora do git)
bun run scripts/anonymize-fixture.ts --write # gera test/fixtures/ para o repo público
```

O anonimizador falha se qualquer dado real sobreviver. Depois de mudar um
parser, incremente `PARSER_VERSION` em `src/cache/sync.ts`: o próximo sync
reprocessa todo o histórico **sem rede**, a partir do `raw_detail` guardado.

## Nunca automatize

O desafio anti-bot é resolvido **por uma pessoa**, na janela do navegador. Se
ele aparecer, o cliente entra em espera de 30 minutos gravada em disco.
Insistir aprofunda o bloqueio.
