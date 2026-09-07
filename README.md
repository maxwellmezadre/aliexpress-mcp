# aliexpress-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![TypeScript: strict](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.json)
[![CI](https://github.com/maxwellmezadre/aliexpress-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/maxwellmezadre/aliexpress-mcp/actions/workflows/ci.yml)

CLI + servidor MCP para o **histórico de compras da sua conta do AliExpress**:
pedidos, produtos, breakdown de preço (imposto, frete, cupons, taxa de
parcelamento), rastreio completo, devoluções e resumos de gastos — com cache
local, para você perguntar quanto gastou sem bater no AliExpress a cada
pergunta.

O AliExpress não tem API de comprador. A Open Platform dele é para afiliados,
dropshipping e vendedores, e **não dá acesso ao histórico da sua própria
conta**. Este projeto fala a API interna que o próprio site usa (MTOP, em
`acs.aliexpress.com`), autenticado pelos cookies da sua sessão de navegador e
assinando cada requisição do mesmo jeito que a página assina. **Somente
leitura**: nenhuma operação de escrita na conta é implementada, e o escape
hatch recusa APIs de escrita por construção.

## Sumário

- [Instalação](#instalação)
- [Login](#login)
- [Uso — CLI](#uso--cli)
- [Uso — MCP](#uso--mcp)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Tools](#tools)
- [Como funciona](#como-funciona)
- [Troubleshooting](#troubleshooting)
- [Documentação](#documentação)
- [Licença](#licença)

## Instalação

### Tudo de uma vez (Claude Code)

```sh
git clone https://github.com/maxwellmezadre/aliexpress-mcp.git
cd aliexpress-mcp
bun install
bun run scripts/install.ts
```

Compila o binário, instala em `~/.local/bin/aliexpress`, registra o servidor
MCP no escopo de usuário do Claude Code e copia a Skill para
`~/.claude/skills/aliexpress-mcp/`.

### npm

```sh
bun install -g @maxwellmezadre/aliexpress-mcp
```

### Binário único

```sh
bun run build:binary   # gera ./aliexpress, sem runtime nenhum
```

O `login` precisa do `playwright-core` resolvível; todos os outros comandos
rodam só com o binário.

## Login

```sh
aliexpress login
```

Abre uma janela do Chrome em `aliexpress.com/p/order/index.html`. **Você**
digita a senha e resolve o que o AliExpress pedir (SMS, Google, captcha) — a
ferramenta nunca vê credencial nenhuma. Ela fica perguntando à API, de dentro
da própria página, se a sessão já vale, e só então grava os cookies cifrados
com AES-256-GCM em `~/.config/aliexpress-mcp/session.enc` (modo 0600).

No macOS dá para importar a sessão de um navegador em que você já está logado:

```sh
aliexpress login --from-browser chrome   # arc | chrome | chromium | brave | edge
```

Detalhes, o que é gravado e como revogar: [`docs/LOGIN.md`](docs/LOGIN.md).

## Uso — CLI

```sh
aliexpress status --verify        # a sessão ainda vale?
aliexpress sync                   # preenche o cache (repete os blocos sozinho)

aliexpress orders --limit 10
aliexpress orders --status shipped
aliexpress order 8212379857492017 --address
aliexpress search "cabo hdmi"
aliexpress track 8214565334582017
aliexpress refunds

aliexpress spending --by month --from 2026-01-01
aliexpress spending --by breakdown        # imposto, frete, cupons, parcelamento
aliexpress export --format csv --scope lines

aliexpress doctor                 # o que quebrou, camada a camada
```

Todo comando aceita `--json`. Referência completa: [`docs/CLI.md`](docs/CLI.md).

## Uso — MCP

```sh
claude mcp add -s user aliexpress -- aliexpress mcp
```

Ou, à mão, em `~/.claude.json`:

```json
{
  "mcpServers": {
    "aliexpress": {
      "type": "stdio",
      "command": "/Users/você/.local/bin/aliexpress",
      "args": ["mcp"]
    }
  }
}
```

Use o caminho absoluto: clientes MCP não herdam o `PATH` do seu shell.

## Variáveis de ambiente

| Variável | Default | O que faz |
| --- | --- | --- |
| `ALIEXPRESS_CONFIG_DIR` | `~/.config/aliexpress-mcp` | Onde ficam sessão, chave e cache |
| `ALIEXPRESS_SESSION_KEY` | — | Chave AES em base64 de 32 bytes; sem ela, uma é gerada em `session.key` |
| `ALIEXPRESS_READ_ONLY` | `0` | Esconde `login`, `sync` e `export` |
| `ALIEXPRESS_COMPACT` | `0` | Respostas mínimas por padrão, para economizar contexto |
| `ALIEXPRESS_EXPORT_DIR` | `~/Downloads/aliexpress-export` | Único diretório em que o `export` pode escrever |
| `ALIEXPRESS_BROWSER_CHANNEL` | `chrome` | `chrome`, `chromium` ou `msedge` |
| `ALIEXPRESS_IMPORT_BROWSER` | — | Importa a sessão desse navegador no `login` |
| `ALIEXPRESS_MIN_INTERVAL_MS` | `400` | Intervalo mínimo entre requisições |
| `ALIEXPRESS_JITTER_MS` | `200` | Variação aleatória somada ao intervalo |
| `ALIEXPRESS_HTTP_TIMEOUT_MS` | `30000` | Timeout de cada requisição |
| `ALIEXPRESS_REGION` / `_LOCALE` / `_CURRENCY` | do cookie | Sobrescreve o que veio de `aep_usuc_f` |
| `ALIEXPRESS_LOG_FILE` | — | Espelha os logs num arquivo (sempre vão para o stderr também) |
| `ALIEXPRESS_LIVE` | — | `=1` destrava o teste de integração contra a conta real |

Nada é obrigatório. Sem sessão, os comandos falham na hora da chamada com uma
mensagem que diz o que fazer — não no boot.

## Tools

**Sessão e diagnóstico:** `auth_status`, `login`, `doctor`
**Cache:** `sync`
**Pedidos:** `list_orders`, `get_order`, `search_products`
**Logística e devoluções:** `track_order`, `list_refunds`
**Análise:** `spending_summary`, `export`
**Redescoberta:** `raw_get`

Parâmetros de cada uma: [`docs/TOOLS.md`](docs/TOOLS.md) (gerado do registry).

## Como funciona

1. **Login** captura os cookies pelo Playwright — inclusive os `HttpOnly`, que
   `document.cookie` não enxerga e sem os quais nada autentica.
2. **Cada chamada é assinada** com `md5(token & t & appKey & payload)`, o mesmo
   esquema do SDK do site. O token (`_m_h5_tk`) é de vida curta e o servidor o
   renova por `Set-Cookie`; o cliente absorve, reassina e repete.
3. **A listagem e o detalhe** vêm em Ultron/DX, um grafo de componentes. Os
   dados de negócio ficam em `data["<tag>_<id>"].fields`, e a ordem em que o
   usuário vê os pedidos está em `hierarchy.structure` — não na ordem das
   chaves do objeto.
4. **Tudo é normalizado** para um modelo limpo, com dinheiro em centavos
   inteiros, e guardado num SQLite local. As perguntas analíticas são
   respondidas dali, sem rede.

Arquitetura em detalhe: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Troubleshooting

- **"Nenhuma sessão do AliExpress salva"** — rode `aliexpress login`.
- **"O AliExpress recusou a sessão"** — ela caiu. `aliexpress login` de novo;
  o servidor MCP recarrega sozinho, sem reiniciar.
- **"O AliExpress exigiu verificação anti-bot"** — pare. Abra o site no seu
  navegador, resolva o desafio, espere o fim do cooldown (30 min, gravado em
  disco) e faça login de novo. Insistir piora.
- **`sync` devolve `done: false`** — é o esperado: ele trabalha em blocos.
  Chame de novo até `done: true` (o CLI já faz isso sozinho).
- **`list_orders` devolve `note` falando em sync** — o cache está vazio.
- **Um pedido com status `unknown`** — o AliExpress usou um rótulo novo.
  `aliexpress doctor` mostra qual, e é um `dicionário` de uma linha em
  `src/domain/status.ts`.
- **Algo quebrou depois de uma mudança no site** — `aliexpress doctor` diz qual
  camada, e [`docs/REDISCOVERY.md`](docs/REDISCOVERY.md) diz como remapear.

## Documentação

| Arquivo | Conteúdo |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Camadas, fluxo e as regras que as separam |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Todas as variáveis e os arquivos em disco |
| [`docs/USAGE.md`](docs/USAGE.md) | Do zero à primeira resposta |
| [`docs/CLI.md`](docs/CLI.md) | Todos os comandos |
| [`docs/TOOLS.md`](docs/TOOLS.md) | Referência das tools (gerada) |
| [`docs/LOGIN.md`](docs/LOGIN.md) | Como o login funciona, o que grava, como revogar |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | O modelo, as regras de dinheiro e o que não existe |
| [`docs/INTERNAL-API.md`](docs/INTERNAL-API.md) | A API interna: assinatura, endpoints, Ultron |
| [`docs/REDISCOVERY.md`](docs/REDISCOVERY.md) | O que fazer quando o AliExpress mudar |
| [`docs/adr/`](docs/adr) | As decisões de projeto e por quê |

## Licença

MIT. Uso pessoal, somente leitura, sobre a sua própria conta. Não redistribua
os dados nem use isto como serviço multiusuário.
