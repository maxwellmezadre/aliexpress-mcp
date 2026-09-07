# A API interna do AliExpress

Engenharia reversa validada contra uma conta real. Os ids abaixo são
placeholders. Nada aqui é documentado ou estável. Quando mudar,
[`REDISCOVERY.md`](REDISCOVERY.md) diz como remapear.

## Por que não existe caminho oficial

A Open Platform do AliExpress só atende afiliado, dropshipping e vendedor. Ela
**não dá acesso ao histórico da própria conta**. Não há OAuth de comprador, não
há access token nem refresh token. O único caminho é a API interna **MTOP**, em
`acs.aliexpress.com`, autenticada pelos cookies de sessão do navegador,
exatamente como a página `www.aliexpress.com/p/order/index.html` faz.

## Assinatura

```
sign = md5(`${token}&${t}&${appKey}&${data}`)

token  = cookie _m_h5_tk até o primeiro "_"
t      = Date.now() em milissegundos, como string
appKey = "12574478"        (constante do H5 do AliExpress)
data   = a MESMA string JSON que vai no parâmetro `data`
```

**A armadilha clássica**: assinar um JSON e enviar outro. Serialize uma vez e
use a mesma string nos dois lugares.

`_m_h5_tk` **não é autenticação**. É um token anti-abuso de vida curta que o
próprio servidor emite. A autenticação vem dos cookies de sessão.

### O ciclo do token

`FAIL_SYS_TOKEN_EMPTY`, `FAIL_SYS_TOKEN_EXOIRED` (o typo é do Alibaba) e
`FAIL_SYS_ILLEGAL_ACCESS` são **o mesmo caso**: o servidor manda um
`Set-Cookie` com o token novo junto do erro. Absorva o cookie, gere um `t`
novo, reassine e repita. Máximo de 3 tentativas, contador por chamada, nunca um
laço.

Um detalhe que só aparece na prática: o jar pode ter **dois** `_m_h5_tk` (um em
`.aliexpress.com` e outro em `acs.aliexpress.com`). Assine com o de timestamp
maior.

### A requisição

```
GET  https://acs.aliexpress.com/h5/{api}/{v}/?jsv=2.5.1&appKey=12574478&t=…&sign=…
     &api={api}&v=1.0&type=originaljson&dataType=json&timeout=15000
     &ecode=1&needLogin=true&data={json}
POST mesma query sem `data`; corpo `data=<encodeURIComponent(json)>`
```

Headers: `Cookie` completo, `Referer: https://www.aliexpress.com/`,
`Origin: https://www.aliexpress.com`, `Accept: application/json` e **o mesmo
User-Agent do navegador que gerou a sessão**.

### Códigos `ret[0]`

| Prefixo | Significa | O que fazer |
| --- | --- | --- |
| `SUCCESS` | ok | — |
| `FAIL_SYS_TOKEN_EMPTY` / `_EXOIRED` / `FAIL_SYS_ILLEGAL_ACCESS` | token | absorver cookie, reassinar, repetir (máx. 3) |
| `FAIL_SYS_SESSION_EXPIRED` / `NEED_LOGIN` / `FAIL_SYS_SID_INVALID` | login caiu | erro acionável, nunca logar sozinho |
| `FAIL_SYS_TRAFFIC_LIMIT` | rate limit | backoff exponencial |
| `FAIL_SYS_USER_VALIDATE` | anti-bot | abortar, travar o breaker, esperar |
| `FAIL_SYS_ACCESS_DENIED` | permissão | abortar |
| `UNKNOWN_FAIL_CODE` | parâmetro inválido ou erro interno | tratar como 4xx |

## Os cinco endpoints

| API | Método | Resposta | Uso |
| --- | --- | --- | --- |
| `mtop.aliexpress.trade.buyer.order.count` | GET | simples | contadores por aba |
| `mtop.aliexpress.trade.buyer.order.list` | GET (init) / POST (páginas) | Ultron | lista de pedidos |
| `mtop.aliexpress.trade.buyer.order.detail` | GET | Ultron | detalhe do pedido |
| `mtop.ae.ld.querydetail` | GET | simples | rastreio completo |
| `mtop.aliexpress.buyer.reverse.queryreverseorderpagelistforbuyer` | POST | simples | devoluções |
| `mtop.aliexpress.trade.buyer.order.operation` | POST | — | **escrita — proibida aqui** |

### `order.count` mente

Ele responde `SUCCESS` com zeros **mesmo para um chamador deslogado**. Serve
para provar que a assinatura está certa, **não** para provar que a sessão vale.
Quem prova a sessão é o `order.list`, que devolve `FAIL_SYS_SESSION_EXPIRED`.

### `order.detail` usa `tradeOrderId`

Chamar com `orderId` devolve `SUCCESS` e o **esqueleto vazio da página**, fácil
de confundir com um pedido apagado. E sem `channel: "tracking"` o backend deixa
o bloco de logística de fora (e às vezes deixa mesmo com ele).

### `reverse.*` usa `shipTo`

Não `shipToCountry`, como todo o resto. `reverseStatus: 1` é o histórico
completo; `2` e `3` são as abas em andamento, `4` a de concluídas; `0` e `5`
estão fora do domínio e devolvem `UNKNOWN_FAIL_CODE`. O campo `pages` voltou
`0` com 3 resultados reais. Conte os `items`, não confie nele.

## Ultron/DX

`order.list` e `order.detail` respondem com um grafo de componentes:

```jsonc
{
  "hierarchy": {
    "root": "pc_om_list_page_109694",
    "structure": { "pc_om_list_body_109702": ["pc_om_list_order_<id>", …] }
  },
  "data": { "pc_om_list_order_<id>": { "tag": "pc_om_list_order", "fields": { … } } },
  "linkage": { … },   // blob opaco e assinado
  "endpoint": { … },
  "global": { "orderStatus": 8 }
}
```

Três regras:

1. **Selecione por `tag`**, nunca pela chave literal: o sufixo é um id no CMS
   do AliExpress e pode mudar.
2. **A ordem vem de `hierarchy.structure`.** Medido na conta real: a ordem das
   chaves de `data` é embaralhada, e a de `structure` é a cronológica correta.
3. **`linkage` é opaco.** Repasse inalterado.

### Paginação

O servidor não aceita número de página. As páginas 2..N são um POST que reenvia
o estado dos componentes com `pageIndex` incrementado, mais `linkage`,
`hierarchy`, `endpoint` e `operator`:

```jsonc
{ "params": "{\"data\":\"…\",\"linkage\":\"…\",\"hierarchy\":\"…\",\"endpoint\":\"…\",\"operator\":\"pc_om_list_body_…\"}" }
```

**Omitir `linkage` devolve `SUCCESS` com `data` vazio**, uma falha silenciosa
que se parece exatamente com "acabaram os pedidos". Cada resposta é a base da
próxima: o `linkage` é rotativo.

### Componentes que importam

Lista: `pc_om_list_page`, `pc_om_list_header`, `pc_om_list_header_action`
(filtros), `pc_om_list_body` (`hasMore`, `pageIndex`, `pageSize`),
`pc_om_list_order`.

Detalhe: `detail_simple_order_info_component` (datas, endereço, pagamento),
`detail_order_price_block` (breakdown), `detail_product_block` (produtos **e
`sellerVO`**, a única fonte do vendedor no detalhe),
`detail_service_progress_bar` (linha do tempo), `detail_order_status_block`
(`title` é a situação canônica), `detail_aync_block` (veio vazio; não é
necessário).

## Rastreio

`mtop.ae.ld.querydetail` devolve um item de `trackingDetailLineList` por pacote,
com `mailNo` (Correios), `originMailNo` (código do AliExpress), transportadora,
`etaInfo` e `detailList`, a linha do tempo, do mais recente para o mais antigo
(26 eventos num pacote entregue da conta de referência).

Use `trackingPrimaryCode`/`trackingSecondCode` como chave do evento: a descrição
é traduzida. Cuidado com `timeText`, `detailedLocation` e `note`: a
transportadora escreve **a cidade e o nome de quem recebeu** neles.
