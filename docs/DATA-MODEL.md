# Modelo de dados

## As regras que não se negociam

Todas verificadas contra a conta de referência (70 pedidos, de 2021 a 2026).

### `itemPriceText` é preço **unitário**

Provado num pedido com quantidade 2: `Subtotal R$27,80 = 2 × R$13,90`. O
`lineTotal` que a ferramenta devolve é `unitPrice × quantity`, e é a soma dos
`lineTotal` que bate com o `Subtotal` do pedido.

### Dinheiro chega em três formatos que discordam entre si

| Forma | Exemplo | Onde |
| --- | --- | --- |
| `formatPriceInfo` | `"R$132,74\|132\|74"` | lista e detalhe — **exato, use sempre que existir** |
| String formatada | `"R$126,59"` (vírgula decimal) | linhas do breakdown |
| String formatada | `"R$61.25"` (**ponto** decimal) | API de devoluções |
| `cent` | `6125` | API de devoluções — o único campo já numérico |

Os dois formatos de string apareceram **na mesma conta, no mesmo dia**. Por
isso `parseMoneyText` decide pelo próprio texto: com os dois separadores, o
último é o decimal; com um só, ele é decimal apenas se houver exatamente dois
dígitos depois.

Internamente tudo é **centavo inteiro**. A conversão para decimal acontece só
na borda da tool.

### `Σ linhas do breakdown ≈ total`, não `=`

Em 18 dos 70 pedidos a soma diverge: 15 por 1 a 3 centavos (o AliExpress
arredonda cada linha exibida) e 3 por um frete de centavos que ele não soma no
total. **O `total` do pedido é o valor bom**; o breakdown é informativo.
`doctor` tolera até 15 centavos.

### Parcelamento: a quantidade não existe

Nenhuma API do site expõe o número de parcelas nem o valor de cada uma.
Verificado, inclusive no bundle da carteira. `installments` é **sempre `null`**.

O que existe: uma linha `Installment payment fee` no breakdown, presente em 24
dos 70 pedidos de referência, que vira `installmentFee`. **A presença dessa
linha prova que o pedido foi parcelado**, mas não em quantas vezes. Para o
cronograma, fatura do cartão.

### Status

`statusText` é traduzido e, em pt-BR, vem com espaço no fim. A precedência é:
aba de origem → `global.orderStatus` (numérico) → tabela de texto.

| Status | Significa |
| --- | --- |
| `unpaid` | aguardando pagamento |
| `processing` | pago, sendo preparado |
| `shipped` | a caminho |
| `completed` | concluído |
| `cancelled` | cancelado |
| `expired` | **o prazo de pagamento venceu** — nada foi pago |
| `unknown` | rótulo que ainda não está mapeado |

`cancelled`, `expired` e `unpaid` ficam fora dos gastos por padrão: neles nada
saiu da conta.

### Endereço é um retrato histórico

`addressVO` é o endereço **no momento do pedido**, não o atual. E só sai da
ferramenta com `include_address: true`.

### Datas

Só existe texto localizado (`"Jul 15, 2026"` em en_US, `"24 nov, 2023"` em
pt_BR). O parser conhece os dois idiomas e guarda o texto original ao lado do
ISO. Falhou o parse → `null`, nunca uma data inventada.

## O esquema do cache

| Tabela | Chave | Guarda |
| --- | --- | --- |
| `orders` | `order_id` | datas, situação, total em centavos, loja, pagamento, endereço, `raw_detail` |
| `order_lines` | `order_line_id` | produto, quantidade, preço unitário e total da linha, variação |
| `order_price_lines` | `(order_id, position)` | o breakdown, com a chave canônica de cada linha |
| `packages` | `(order_id, tracking_number)` | rastreio e a linha do tempo inteira em JSON |
| `refunds` | `reverse_order_line_id` | devoluções, ligadas ao pedido de origem |
| `order_lines_fts` | — | busca textual sem acento (`unicode61 remove_diacritics 2`) |
| `meta` | `key` | versão do schema, cursor do sync, cooldown do anti-bot |

`raw_detail` guarda o payload cru de cada pedido. É o que permite
`sync --reparse`: quando um parser melhora, o histórico inteiro é reprocessado
**sem uma única requisição** (70 pedidos em 50 ms na conta de referência).

## Chaves do breakdown

`subtotal`, `shipping`, `tax`, `installment_fee`, `store_coupon`, `ae_coupon`,
`promo_code`, `store_discount`, `coins`, `payment_discount`, `spend_save`,
`other`.

Rótulos desconhecidos caem em `other` **mantendo o texto original**. Nunca são
descartados, porque contam para o total.
