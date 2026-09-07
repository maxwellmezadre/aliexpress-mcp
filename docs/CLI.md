# CLI

Todo comando aceita `--json`. O resultado vai para o stdout; erros, avisos e
progresso vão para o stderr, então `aliexpress orders --json | jq` funciona.
Saída de erro sai com código 1.

## Sessão e diagnóstico

| Comando | O que faz |
| --- | --- |
| `aliexpress status [--verify]` | A sessão salva. `--verify` gasta 1 requisição para confirmar |
| `aliexpress login [--timeout <min>] [--fresh] [--from-browser <nav>]` | Abre o navegador (ou importa de um já logado) |
| `aliexpress doctor [--shallow]` | Diagnóstico camada a camada. `--shallow` pula paginação e detalhe |

## Cache

| Comando | O que faz |
| --- | --- |
| `aliexpress sync` | Incremental: para na primeira página sem novidades |
| `aliexpress sync --full` | Percorre todo o histórico |
| `aliexpress sync --reparse` | Reprocessa o cache sem usar a rede |
| `aliexpress sync --max-requests <n>` | Orçamento por bloco (default 40) |
| `aliexpress sync --no-details --no-tracking --no-refunds` | Desliga fases |

O CLI repete os blocos sozinho até terminar.

## Pedidos

| Comando | O que faz |
| --- | --- |
| `aliexpress orders` | Lista do cache. `--status --from --to --store --include-unpaid --limit --offset` |
| `aliexpress order <id>` | Detalhe completo. `--address` inclui o endereço, `--refresh` rebusca |
| `aliexpress search <texto>` | Busca nos produtos comprados. `--from --to --limit` |

## Logística e devoluções

| Comando | O que faz |
| --- | --- |
| `aliexpress track <id>` | Rastreio ao vivo (1 requisição). `--line <id>` restringe a um item |
| `aliexpress refunds` | Devoluções. `--refresh` busca ao vivo, `--limit` |

## Análise

| Comando | O que faz |
| --- | --- |
| `aliexpress spending --by month\|year\|store\|payment_method\|breakdown` | Gastos agregados. `--from --to --include-unpaid` |
| `aliexpress export --format json\|csv --scope orders\|lines\|packages\|refunds` | Arquivo dentro de `ALIEXPRESS_EXPORT_DIR`. `--from --to --filename` |

## Redescoberta

| Comando | O que faz |
| --- | --- |
| `aliexpress raw <api> [-d '<json>'] [-m GET\|POST]` | Chamada MTOP assinada. Recusa qualquer API de escrita |

## Servidor

| Comando | O que faz |
| --- | --- |
| `aliexpress mcp` | Sobe o servidor MCP em stdio |

## Exemplos

```sh
# tudo que ainda não chegou
aliexpress orders --status shipped

# o que gastei com uma loja específica
aliexpress orders --store baseus --json | jq '[.orders[].total.amount] | add'

# quanto de imposto em 2026
aliexpress spending --by breakdown --from 2026-01-01 --json \
  | jq '.rows[] | select(.key == "tax")'

# planilha com todos os itens já comprados
aliexpress export --format csv --scope lines
```
