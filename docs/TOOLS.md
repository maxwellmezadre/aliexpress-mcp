# Tools

> Gerado por `bun run docs:tools` a partir de `src/tools/registry.ts`. Não edite à mão.

O servidor expõe **12 tools**. Com `ALIEXPRESS_READ_ONLY=1` as 3 que escrevem algo (sessão, cache, arquivo) não são registradas.

| Tool | Escreve | O que faz |
| --- | --- | --- |
| [`auth_status`](#authstatus) | — | Diz se há uma sessão do AliExpress salva e o que ela cobre (região, idioma, moeda, validade dos cookies). Não … |
| [`login`](#login) | sim | Abre uma janela do navegador para o usuário entrar na conta do AliExpress e guarda a sessão cifrada (a senha n… |
| [`doctor`](#doctor) | — | Diagnóstico camada a camada: sessão, assinatura MTOP, listagem, paginação Ultron (inclusive o teste negativo d… |
| [`sync`](#sync) | sim | Baixa o histórico do AliExpress para o cache local. Trabalha em blocos: faz até max_requests chamadas e devolv… |
| [`list_orders`](#listorders) | — | Lista os pedidos do AliExpress a partir do cache local, do mais novo para o mais antigo, com os produtos de ca… |
| [`get_order`](#getorder) | — | Detalhe completo de um pedido: produtos, breakdown de preço (subtotal, frete, imposto, cupons, taxa de parcela… |
| [`search_products`](#searchproducts) | — | Busca textual nos produtos já comprados (título, variação e loja), sem acento e sem diferenciar maiúsculas. Re… |
| [`track_order`](#trackorder) | — | Rastreio ao vivo de um pedido: código dos Correios, código logístico do AliExpress, transportadora, previsão d… |
| [`list_refunds`](#listrefunds) | — | Devoluções e reembolsos da conta, do mais recente para o mais antigo, com o pedido de origem e o preço unitári… |
| [`spending_summary`](#spendingsummary) | — | Agrega os gastos do cache local por mês, ano, loja, forma de pagamento, ou em `breakdown` (quanto foi imposto,… |
| [`export`](#export) | sim | Exporta o cache para um arquivo JSON ou CSV (pedidos, itens, pacotes ou devoluções). Grava somente dentro de A… |
| [`raw_get`](#rawget) | — | Chama uma API MTOP do AliExpress diretamente (assinada, com o mesmo limite de taxa). Serve para redescobrir um… |

## `auth_status`

Diz se há uma sessão do AliExpress salva e o que ela cobre (região, idioma, moeda, validade dos cookies). Não usa a rede por padrão. Com verify=true gasta 1 requisição para confirmar que o AliExpress ainda aceita a sessão. Comece por aqui quando outra tool reclamar de sessão.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `verify` | boolean | — | Também faz 1 chamada ao AliExpress para confirmar que a sessão é aceita |

## `login`

Abre uma janela do navegador para o usuário entrar na conta do AliExpress e guarda a sessão cifrada (a senha nunca passa por aqui). Bloqueia até o login terminar (até 15 minutos). Com from_browser, importa a sessão de um navegador já logado (macOS) em vez de abrir a janela. Prefira o comando de terminal `aliexpress login` quando o cliente MCP tiver timeout curto.

**Escreve em disco/cache:** sim

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `timeout_seconds` | integer (≥ 60, ≤ 900) | — | Tempo máximo esperando o login (default 300) |
| `fresh` | boolean | — | Apaga o perfil do navegador antes de abrir (login do zero) |
| `from_browser` | `arc` \| `chrome` \| `chromium` \| `brave` \| `edge` | — | Importa os cookies de um navegador já logado (só macOS) em vez de abrir uma janela |

## `doctor`

Diagnóstico camada a camada: sessão, assinatura MTOP, listagem, paginação Ultron (inclusive o teste negativo de `linkage`), detalhe (com `tradeOrderId` e com o parâmetro errado), somas de dinheiro, devoluções e cache. Use quando algo falhar de um jeito estranho: ele diz qual camada quebrou. Gasta cerca de 5 requisições.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `deep` | boolean | — | Também testa a paginação e o detalhe (mais 3 requisições) |

## `sync`

Baixa o histórico do AliExpress para o cache local. Trabalha em blocos: faz até max_requests chamadas e devolve `done: false` com `pendingDetails`. CHAME DE NOVO com os mesmos parâmetros até `done: true`. Um histórico de ~70 pedidos leva cerca de 80 requisições e 40 s. Nunca chame em paralelo nem dispare outras tools de rede junto: o AliExpress derruba a sessão. `mode: reparse` reprocessa o que já está no cache sem usar a rede.

**Escreve em disco/cache:** sim

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `mode` | `incremental` \| `full` \| `reparse` | — | incremental (default) para na primeira página sem novidades; full percorre tudo; reparse reprocessa o cache sem rede |
| `max_requests` | integer (≥ 1, ≤ 200) | — | Orçamento de requisições (default 40) |
| `with_details` | boolean | — | Baixa o detalhe de cada pedido (default true) |
| `with_tracking` | boolean | — | Atualiza o rastreio dos pacotes a caminho (default true) |
| `with_refunds` | boolean | — | Atualiza as devoluções (default true) |

## `list_orders`

Lista os pedidos do AliExpress a partir do cache local, do mais novo para o mais antigo, com os produtos de cada um. Filtra por situação, período e loja. Pedidos cancelados ou expirados (nada foi pago) ficam de fora, a menos que include_unpaid seja true. Rode `sync` antes se o cache estiver vazio.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `status` | `unpaid` \| `processing` \| `shipped` \| `completed` \| `cancelled` \| `expired` \| `unknown` | — | Filtra por situação. `expired` e `cancelled` são pedidos em que nada foi pago e ficam fora dos resultados por padrão. |
| `from` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data inicial do pedido (YYYY-MM-DD) |
| `to` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data final inclusiva (YYYY-MM-DD) |
| `store` | string | — | Trecho do nome da loja |
| `include_unpaid` | boolean | — | Inclui cancelados e expirados (default false) |
| `limit` | integer (≥ 1, ≤ 200) | — | Máximo de itens (default 50) |
| `offset` | integer (≥ 0) | — | Itens a pular (paginação) |
| `compact` | boolean | — | Devolve apenas os campos essenciais, para economizar contexto (default ALIEXPRESS_COMPACT) |

## `get_order`

Detalhe completo de um pedido: produtos, breakdown de preço (subtotal, frete, imposto, cupons, taxa de parcelamento), datas, forma de pagamento e linha do tempo. Lê do cache; se o detalhe ainda não tiver sido baixado, gasta 1 requisição e grava. `installments` é SEMPRE null: o AliExpress não expõe a quantidade de parcelas em nenhuma API; `installmentFee` aparece quando houve cobrança de parcelamento. O endereço só vem com include_address.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `order_id` | string (`^\d{6,}$`) | sim | Número do pedido no AliExpress (só dígitos), como aparece em `list_orders` |
| `include_address` | boolean | — | Inclui o endereço de entrega gravado no pedido (default false) |
| `refresh` | boolean | — | Busca o detalhe de novo mesmo se já estiver no cache |

## `search_products`

Busca textual nos produtos já comprados (título, variação e loja), sem acento e sem diferenciar maiúsculas. Responde do cache, sem rede. Serve para 'quando comprei X' e 'quanto paguei em X'.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `query` | string (min 2 chars) | sim | Texto a procurar |
| `from` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data inicial do pedido (YYYY-MM-DD) |
| `to` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data final inclusiva (YYYY-MM-DD) |
| `limit` | integer (≥ 1, ≤ 200) | — | Máximo de itens (default 50) |

## `track_order`

Rastreio ao vivo de um pedido: código dos Correios, código logístico do AliExpress, transportadora, previsão de entrega e a linha do tempo completa. Sempre gasta 1 requisição (é o dado que mais muda) e atualiza o cache. Para um pedido já entregue, `get_order` responde de graça. Use `primaryCode` para identificar um evento: a descrição é traduzida.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `order_id` | string (`^\d{6,}$`) | sim | Número do pedido no AliExpress (só dígitos), como aparece em `list_orders` |
| `order_line_id` | string | — | Restringe a um item específico de um pedido com vários pacotes |

## `list_refunds`

Devoluções e reembolsos da conta, do mais recente para o mais antigo, com o pedido de origem e o preço unitário do item devolvido. Lê do cache; com refresh=true busca ao vivo. ATENÇÃO: o AliExpress não expõe nesta API o valor efetivamente reembolsado, só o preço do item. Não apresente `unitPrice` como se fosse o valor devolvido.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `refresh` | boolean | — | Busca ao vivo em vez de ler o cache (1 requisição) |
| `limit` | integer (≥ 1, ≤ 200) | — | Máximo de itens (default 50) |

## `spending_summary`

Agrega os gastos do cache local por mês, ano, loja, forma de pagamento, ou em `breakdown` (quanto foi imposto, frete, taxa de parcelamento e cupons). Pedidos cancelados ou expirados ficam de fora por padrão, porque neles nada foi pago. Rode `sync` antes para ter o histórico completo.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `group_by` | `month` \| `year` \| `store` \| `payment_method` \| `breakdown` | sim | month \| year \| store \| payment_method \| breakdown |
| `from` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data inicial (YYYY-MM-DD), pela data do pedido |
| `to` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data final inclusiva (YYYY-MM-DD) |
| `include_unpaid` | boolean | — | Inclui cancelados e expirados (default false) |

## `export`

Exporta o cache para um arquivo JSON ou CSV (pedidos, itens, pacotes ou devoluções). Grava somente dentro de ALIEXPRESS_EXPORT_DIR (default ~/Downloads/aliexpress-export) e devolve o caminho. Valores em reais, datas ISO.

**Escreve em disco/cache:** sim

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `format` | `json` \| `csv` | sim | Formato do arquivo |
| `scope` | `orders` \| `lines` \| `packages` \| `refunds` | sim | O que exportar |
| `from` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data inicial do pedido (YYYY-MM-DD) |
| `to` | string (`^\d{4}-\d{2}-\d{2}$`) | — | Data final inclusiva (YYYY-MM-DD) |
| `include_unpaid` | boolean | — | Inclui cancelados e expirados (default false) |
| `filename` | string | — | Nome do arquivo (sem diretório). Default: aliexpress-<escopo>-<data> |

## `raw_get`

Chama uma API MTOP do AliExpress diretamente (assinada, com o mesmo limite de taxa). Serve para redescobrir um endpoint quando o site muda. Use com parcimônia e nunca em rajada. Só APIs `mtop.aliexpress.*` / `mtop.ae.*` de leitura: qualquer API de escrita (`*.operation` e afins) é recusada, porque este servidor nunca altera a conta.

**Escreve em disco/cache:** não

| Parâmetro | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `api` | string | sim | Nome da API, ex.: mtop.aliexpress.trade.buyer.order.count |
| `v` | string | — | Versão da API (default 1.0) |
| `method` | `GET` \| `POST` | — | Método MTOP (default GET) |
| `data` | object | — | Payload da API. shipToCountry e _lang são preenchidos a partir da sessão quando ausentes. |
| `max_bytes` | integer (≥ 1024, ≤ 65536) | — | Corta a resposta neste tamanho (default 65536) |
