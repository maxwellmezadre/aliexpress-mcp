---
name: aliexpress-mcp
description: >-
  Histórico de compras do AliExpress da conta do usuário via MCP `aliexpress`:
  pedidos, produtos, preço pago, imposto, frete, cupons, taxa de parcelamento,
  rastreio completo, devoluções e resumos de gastos, com cache local. Use para
  perguntas como "quanto gastei no AliExpress", "quando comprei X", "onde está
  meu pedido", "quanto paguei de imposto". Triggers: aliexpress, ali express,
  pedido, compra, comprei, rastreio, entrega, encomenda, Correios, parcelamento,
  quanto gastei, imposto, taxa, cupom, frete, devolução, reembolso, loja.
---

# AliExpress — histórico de compras

MCP `aliexpress` (`mcp__aliexpress__*`), 12 tools. Referência completa de
parâmetros em `TOOLS.md`, ao lado deste arquivo.

## Leia antes de responder

1. **Comece por `auth_status`.** Sem `verify` ele não usa a rede e já diz se há
   sessão, de que região/moeda ela é e se o breaker anti-bot está ativo. Com
   `verify: true` gasta 1 requisição e confirma que o AliExpress ainda aceita.
2. **O cache responde quase tudo.** `list_orders`, `get_order`,
   `search_products`, `list_refunds` e `spending_summary` leem o SQLite local,
   sem rede. Se `list_orders` devolver `note` falando em sync, rode `sync`.
3. **`sync` é em blocos.** Ele faz até `max_requests` chamadas e devolve
   `done: false` com `pendingDetails`. **Chame de novo com os mesmos
   parâmetros até `done: true`.** Um histórico de ~70 pedidos custa cerca de
   80 requisições e 40 segundos — avise o usuário. **Nunca** chame `sync` em
   paralelo nem dispare outras tools de rede junto: o AliExpress derruba a
   sessão para verificação.
4. **Parcelamento: a quantidade de parcelas NÃO existe.** Nenhuma API do site
   expõe. `installments` é sempre `null` — não invente dividindo o total.
   O que existe é `installmentFee`, a taxa cobrada quando o pedido foi
   parcelado (aparece em cerca de um terço dos pedidos). Para o cronograma,
   diga ao usuário para olhar a fatura do cartão.
5. **Cancelado e expirado não são gasto.** `expired` é um pedido cujo prazo de
   pagamento venceu. Os dois ficam fora de `list_orders` e de
   `spending_summary` por padrão; só inclua com `include_unpaid: true` se o
   usuário pedir explicitamente.
6. **`track_order` é sempre ao vivo** (1 requisição). Para um pedido já
   entregue, `get_order` responde de graça — a linha do tempo já está no cache.
7. **Endereço só sob pedido.** `get_order` só devolve `shippingAddress` com
   `include_address: true`, e é o endereço **daquela época**, não o atual.
8. **Sessão caída** ("Rode `aliexpress login`"): peça ao usuário para rodar
   `aliexpress login` no terminal. O servidor recarrega a sessão nova sozinho,
   sem reiniciar. Nunca tente adivinhar cookies.
9. **Anti-bot** (mensagem de verificação, ou `cooldownUntil` preenchido em
   `auth_status`): **pare**. O cliente entra em espera de 30 minutos, gravada
   em disco, e insistir só piora. Responda com o cache e diga até que horas
   vale a espera.
10. **`doctor` quando algo falhar de um jeito estranho** — ele diz qual camada
    quebrou (sessão, assinatura, listagem, paginação, detalhe, dinheiro).

## Tools ↔ CLI

| Tool | CLI | Para quê |
| --- | --- | --- |
| `auth_status` | `aliexpress status [--verify]` | Tem sessão? De que conta e moeda? |
| `login` | `aliexpress login [--from-browser arc]` | Obter ou renovar a sessão |
| `doctor` | `aliexpress doctor` | Qual camada quebrou |
| `sync` | `aliexpress sync [--full] [--reparse]` | Preencher o cache (em blocos) |
| `list_orders` | `aliexpress orders [--status --from --to --store]` | Listar pedidos com seus produtos |
| `get_order` | `aliexpress order <id> [--address]` | Detalhe: preços, datas, pagamento, linha do tempo |
| `search_products` | `aliexpress search <texto>` | "Quando comprei X / quanto paguei" |
| `track_order` | `aliexpress track <id>` | "Onde está meu pedido" (ao vivo) |
| `list_refunds` | `aliexpress refunds` | Devoluções e reembolsos |
| `spending_summary` | `aliexpress spending --by <grupo>` | Gastos por mês, ano, loja, pagamento, ou breakdown |
| `export` | `aliexpress export --format csv --scope lines` | Levar os dados para uma planilha |
| `raw_get` | `aliexpress raw <api>` | Redescoberta quando o site mudar |

Todo comando do CLI aceita `--json`.

## Receitas

- **"Quanto gastei em 2026?"** → `auth_status` → (`sync` se preciso) →
  `spending_summary {group_by: "year"}`.
- **"Quanto já paguei de imposto?"** → `spending_summary {group_by: "breakdown"}`
  e leia a linha `tax`.
- **"Quando comprei aquele cabo?"** → `search_products {query: "cabo"}` →
  `get_order {order_id}` para os detalhes.
- **"O que ainda não chegou?"** → `list_orders {status: "shipped"}` e depois
  `track_order` só do que o usuário quiser ver.
- **"Quais pedidos eu parcelei?"** → `list_orders` e olhe `installmentFee` no
  `get_order` de cada um; a linha `installment_fee` do `breakdown` dá o total.
- **"Me manda tudo numa planilha"** → `export {format: "csv", scope: "lines"}`
  e informe o caminho devolvido.

## Avisos

- **Somente leitura na conta.** Este servidor nunca confirma recebimento,
  cancela, abre disputa ou paga. `raw_get` recusa qualquer API de escrita.
- **Ritmo:** uma requisição por vez, com intervalo. Não paralelize nada que vá
  à rede.
- **Dados sensíveis:** endereço, histórico de consumo e códigos de rastreio
  ficam num cache local (0600) e a sessão fica cifrada. Não copie nem cole
  esses arquivos em lugar nenhum.
- **Somas do `breakdown`** podem divergir do total do pedido em 1 a 3 centavos:
  o AliExpress arredonda cada linha. O `total` do pedido é o valor bom.
- **`list_refunds.unitPrice` é o preço do item**, não o valor reembolsado —
  essa API não expõe o reembolso. Não apresente um como o outro.
- Com `ALIEXPRESS_READ_ONLY=1`, `login`, `sync` e `export` não existem:
  explique que o cache é um retrato e que atualizar é fora do agente.
