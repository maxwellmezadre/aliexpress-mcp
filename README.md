# aliexpress-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![TypeScript: strict](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.json)
[![CI](https://github.com/maxwellmezadre/aliexpress-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/maxwellmezadre/aliexpress-mcp/actions/workflows/ci.yml)

CLI + servidor MCP para o **histórico de compras da sua conta do AliExpress**:
pedidos, produtos, breakdown de preço (imposto, frete, cupons, taxa de
parcelamento), rastreio completo, devoluções e resumos de gastos, com cache
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

Requer [Bun](https://bun.sh) ≥ 1.3 (o cache usa `bun:sqlite`) e o Google
Chrome para o `login` pela janela.

### Tudo de uma vez (Claude Code)

```sh
git clone https://github.com/maxwellmezadre/aliexpress-mcp.git
cd aliexpress-mcp
bun install
bun run setup
```

`setup` compila o binário para `~/.local/bin/aliexpress`, registra o servidor
MCP `aliexpress` no escopo de usuário do seu `~/.claude.json` e instala a
Skill em `~/.claude/skills/aliexpress-mcp/`.

### npm

```sh
npm i -g @maxwellmezadre/aliexpress-mcp   # instala `aliexpress` e `aliexpress-mcp` no PATH
aliexpress --version
```

O pacote roda com o Bun (`bun:sqlite`), então o Bun precisa estar instalado.

### Binário único

```sh
bun run build:binary   # gera ./aliexpress, sem precisar de runtime instalado
./aliexpress --version
```

O binário roda tudo, inclusive o `login`: o Playwright vai embutido e o Chrome
vem do sistema.

## Login

A senha nunca passa por aqui. Dois caminhos:

```sh
aliexpress login                        # abre o Google Chrome para você entrar
aliexpress login --from-browser chrome  # importa a sessão de um navegador já logado (macOS)
```

O primeiro abre uma janela do Chrome em `aliexpress.com/p/order/index.html`.
Você digita a senha e resolve o que o AliExpress pedir (SMS, Google, captcha).
A ferramenta fica perguntando à API, de dentro da própria página, se a sessão
já vale, e só então grava os cookies.

O segundo é o mais rápido se você já usa o AliExpress no Chrome, no Arc, no
Brave ou no Edge: ele lê os cookies pelo Keychain (o macOS pede permissão uma
vez) e não abre janela nenhuma.

Nos dois casos a sessão é gravada cifrada com AES-256-GCM em
`~/.config/aliexpress-mcp/session.enc` (0600). Detalhes, o que é gravado e
como revogar: [`docs/LOGIN.md`](docs/LOGIN.md).

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

`--json` funciona em qualquer comando e imprime exatamente o que o cliente MCP
receberia. Referência completa em [`docs/CLI.md`](docs/CLI.md).

## Uso — MCP

O `setup` já registra o servidor. Manualmente:

```sh
claude mcp add -s user aliexpress -- /Users/você/.local/bin/aliexpress mcp
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

Use o caminho absoluto: clientes MCP não herdam o `PATH` do seu shell. Depois
é só perguntar: *"quanto gastei no AliExpress este ano?"*, *"onde está meu
pedido da Baseus?"*, *"quanto já paguei de imposto?"*.

## Variáveis de ambiente

Todas opcionais. A tabela completa está em
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

| Variável | Default | Para quê |
| --- | --- | --- |
| `ALIEXPRESS_CONFIG_DIR` | `~/.config/aliexpress-mcp` | Onde ficam sessão, chave e cache |
| `ALIEXPRESS_SESSION_KEY` | — | Chave AES em base64 de 32 bytes; sem ela, uma é gerada em `session.key` |
| `ALIEXPRESS_EXPORT_DIR` | `~/Downloads/aliexpress-export` | O único diretório onde `export` escreve |
| `ALIEXPRESS_READ_ONLY` | `0` | Não registra `login`, `sync` e `export` |
| `ALIEXPRESS_COMPACT` | `0` | Respostas mínimas por padrão, para economizar contexto |
| `ALIEXPRESS_BROWSER_CHANNEL` | `chrome` | `chrome`, `chromium` ou `msedge` |
| `ALIEXPRESS_IMPORT_BROWSER` | — | `arc` \| `chrome` \| `chromium` \| `brave` \| `edge` |
| `ALIEXPRESS_MIN_INTERVAL_MS` | `400` | Intervalo mínimo entre requisições |
| `ALIEXPRESS_JITTER_MS` | `200` | Variação aleatória somada ao intervalo |

Sem sessão, os comandos falham na hora da chamada com uma mensagem que diz o
que fazer, não no boot.

## Tools

São 12, iguais no MCP e no CLI. Referência gerada:
[`docs/TOOLS.md`](docs/TOOLS.md).

| Tool | Comando | Rede |
| --- | --- | --- |
| `auth_status` | `aliexpress status [--verify]` | 0 (1 com `--verify`) |
| `login` | `aliexpress login [--from-browser]` | — |
| `doctor` | `aliexpress doctor` | ≈ 5 (2 com `--shallow`) |
| `sync` | `aliexpress sync [--full\|--reparse]` | em blocos |
| `list_orders` | `aliexpress orders` | 0 |
| `get_order` | `aliexpress order <id>` | 0 (1 se não estiver no cache) |
| `search_products` | `aliexpress search <termo>` | 0 |
| `track_order` | `aliexpress track <id>` | 1, sempre ao vivo |
| `list_refunds` | `aliexpress refunds [--refresh]` | 0 (1 com `--refresh`) |
| `spending_summary` | `aliexpress spending --by …` | 0 |
| `export` | `aliexpress export` | 0 |
| `raw_get` | `aliexpress raw <api>` | 1 |

## Como funciona

1. **Login** captura os cookies pelo Playwright, inclusive os `HttpOnly`, que
   `document.cookie` não enxerga e sem os quais nada autentica.
2. **Cada chamada é assinada** com `md5(token & t & appKey & payload)`, o mesmo
   esquema do SDK do site. O token (`_m_h5_tk`) é de vida curta e o servidor o
   renova por `Set-Cookie`; o cliente absorve, reassina e repete.
3. **A listagem e o detalhe** vêm em Ultron/DX, um grafo de componentes. Os
   dados de negócio ficam em `data["<tag>_<id>"].fields`, e a ordem em que o
   usuário vê os pedidos está em `hierarchy.structure`, não na ordem das
   chaves do objeto.
4. **Tudo é normalizado** para um modelo limpo, com dinheiro em centavos
   inteiros, e guardado num SQLite local. As perguntas analíticas são
   respondidas dali, sem rede.

O que a API **não** tem: o número de parcelas (só a taxa). Está documentado em
[`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) para ninguém inventar esse número.
Arquitetura em detalhe: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Troubleshooting

| Sintoma | O que fazer |
| --- | --- |
| `Nenhuma sessão do AliExpress salva` | `aliexpress login` |
| `O AliExpress recusou a sessão` | Ela caiu. `aliexpress login` de novo; o servidor MCP recarrega sozinho, sem reiniciar |
| `O AliExpress exigiu verificação anti-bot` | Pare. Abra o site no navegador, resolva o desafio, espere o cooldown de 30 min (gravado em disco) e faça login de novo. Insistir piora |
| `sync` devolve `done: false` | É o esperado: ele trabalha em blocos. Chame de novo até `done: true` (o CLI já faz isso) |
| `list_orders` devolve `note` falando em sync | O cache está vazio: `aliexpress sync` |
| Pedido com status `unknown` | O AliExpress usou um rótulo novo. `aliexpress doctor` mostra qual; mapear é uma linha em `src/domain/status.ts` |
| Chrome não abre | Instale o Google Chrome, ou `bunx playwright install chromium` e `ALIEXPRESS_BROWSER_CHANNEL=chromium` |
| Algo mudou no site | `aliexpress doctor` diz qual camada quebrou; [`docs/REDISCOVERY.md`](docs/REDISCOVERY.md) diz como remapear |

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

[MIT](LICENSE). Uso pessoal, somente leitura, sobre a sua própria conta. Não
redistribua os dados nem use isto como serviço multiusuário.
