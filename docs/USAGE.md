# Do zero à primeira resposta

```sh
git clone https://github.com/maxwellmezadre/aliexpress-mcp.git
cd aliexpress-mcp
bun install
bun run scripts/install.ts
```

## 1. Entrar na conta

```sh
aliexpress login
```

Uma janela do Chrome abre. Faça o login normalmente. Quando terminar:

```sh
aliexpress status --verify
```

```
loggedIn: true
region: BR
locale: pt_BR
currency: BRL
verified: true
firstPageOrders: 10
```

## 2. Preencher o cache

```sh
aliexpress sync
```

Ele trabalha em blocos e repete sozinho até terminar, mostrando o progresso no
stderr:

```
bloco 1: 40 req, 33 detalhes, 37 pendentes
bloco 2: 40 req, 37 detalhes, 0 pendentes — pronto
```

Um histórico de ~70 pedidos custa cerca de 80 requisições e 40 segundos. Depois
disso, `aliexpress sync` incremental custa 2 requisições.

## 3. Perguntar

```sh
$ aliexpress orders --limit 3
PEDIDO            DATA        SITUAÇÃO   TOTAL       ITENS  LOJA
----------------  ----------  ---------  ----------  -----  ---------------------
82145653345820XX  2026-09-01  shipped    BRL 31.93   2      BASEUS Co.,Ltd. Store
82145653345620XX  2026-09-01  shipped    BRL 87.15   2      BASEUS Choice Store
82123798575120XX  2026-07-15  completed  BRL 277.33  1      Switch Global Store
```

```sh
$ aliexpress spending --by year
YEAR  PEDIDOS  TOTAL
----  -------  -------
2026  11       1748.97
2025  2        836.50
…
```

```sh
$ aliexpress spending --by breakdown
BREAKDOWN         PEDIDOS  TOTAL
----------------  -------  -------
subtotal          64       9548.35
tax               18       577.44
installment_fee   23       281.52
shipping          64       161.25
ae_coupon         8        -153.00
…
```

```sh
$ aliexpress search "cabo hdmi"
$ aliexpress order 82123798575120XX --address
$ aliexpress track 82145653345820XX
$ aliexpress export --format csv --scope lines
```

## 4. Usar pelo Claude

Reinicie o Claude Code e pergunte em português:

- "quanto gastei no AliExpress esse ano?"
- "quanto já paguei de imposto em compras do AliExpress?"
- "quando eu comprei aquele cabo HDMI e quanto custou?"
- "onde está meu pedido da Baseus?"
- "quais pedidos eu parcelei?"

O Claude usa `auth_status` → `sync` (se preciso) → a tool certa. A Skill em
`~/.claude/skills/aliexpress-mcp/` já ensina as regras que evitam resposta
errada — principalmente que **cancelado e expirado não são gasto** e que a
**quantidade de parcelas não existe** em lugar nenhum.

## Manutenção

```sh
aliexpress sync              # incremental, 2 requisições
aliexpress sync --full       # percorre todo o histórico de novo
aliexpress sync --reparse    # reprocessa o cache SEM rede, depois de atualizar
aliexpress doctor            # quando algo falhar de um jeito estranho
```
