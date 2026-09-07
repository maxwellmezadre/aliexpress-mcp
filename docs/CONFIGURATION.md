# Configuração

Tudo vem do ambiente (12-factor). **Nenhum arquivo `.env` é lido.** Valores
malformados falham no boot, com todos os problemas listados de uma vez; valores
ausentes nunca falham no boot: falham na hora da chamada, com uma mensagem que
diz o que fazer.

## Variáveis

| Variável | Default | O que faz |
| --- | --- | --- |
| `ALIEXPRESS_CONFIG_DIR` | `~/.config/aliexpress-mcp` | Raiz de tudo que é gravado. `~/` é expandido à mão, porque config de cliente MCP é JSON, não shell |
| `ALIEXPRESS_SESSION_KEY` | — | Chave AES em base64 de 32 bytes (`openssl rand -base64 32`). Sem ela, uma é gerada em `session.key` |
| `ALIEXPRESS_READ_ONLY` | `0` | Não registra `login`, `sync` e `export` |
| `ALIEXPRESS_COMPACT` | `0` | Respostas mínimas por padrão nas tools que aceitam `compact` |
| `ALIEXPRESS_EXPORT_DIR` | `~/Downloads/aliexpress-export` | Único diretório em que o `export` pode escrever |
| `ALIEXPRESS_BROWSER_CHANNEL` | `chrome` | `chrome`, `chromium` ou `msedge` |
| `ALIEXPRESS_IMPORT_BROWSER` | — | `arc`, `chrome`, `chromium`, `brave` ou `edge`: o `login` importa daí |
| `ALIEXPRESS_MIN_INTERVAL_MS` | `400` | Intervalo mínimo entre duas requisições |
| `ALIEXPRESS_JITTER_MS` | `200` | Variação aleatória somada ao intervalo |
| `ALIEXPRESS_HTTP_TIMEOUT_MS` | `30000` | Timeout de cada requisição |
| `ALIEXPRESS_REGION` | do cookie | Sobrescreve o `shipToCountry` derivado de `aep_usuc_f` |
| `ALIEXPRESS_LOCALE` | do cookie | Sobrescreve o `_lang` |
| `ALIEXPRESS_CURRENCY` | do cookie | Sobrescreve o `_currency` |
| `ALIEXPRESS_ACS_BASE_URL` | `https://acs.aliexpress.com` | Host do MTOP (testes) |
| `ALIEXPRESS_SITE_BASE_URL` | `https://www.aliexpress.com` | Host do site, usado no login e no Referer |
| `ALIEXPRESS_LOG_FILE` | — | Espelha os logs num arquivo. Eles sempre vão para o stderr também |
| `ALIEXPRESS_LIVE` | — | `=1` destrava `test/integration` |

Aceita como booleano: `1/0`, `true/false`, `yes/no`, `on/off`. Qualquer outra
coisa é erro, não um default silencioso.

## Arquivos em disco

| Arquivo | Modo | Conteúdo |
| --- | --- | --- |
| `session.enc` | `0600` | Cookies + User-Agent + região, cifrados com AES-256-GCM |
| `session.key` | `0600` | Chave gerada no primeiro login, se `ALIEXPRESS_SESSION_KEY` não existir |
| `cache.db` (+ `-wal`, `-shm`) | `0600` | Pedidos, itens, preços, pacotes, devoluções |
| `browser-profile/` | `0700` | Perfil persistente do Chrome usado no login |

O diretório é criado com `0700` e o `umask` é forçado na criação do banco, para
que nenhum deles fique legível por outros usuários da máquina.

## Registro no Claude Code

```sh
claude mcp add -s user aliexpress -- /Users/você/.local/bin/aliexpress mcp
```

Sempre com **caminho absoluto**: clientes MCP não herdam o `PATH` do shell. Uma
entrada com o mesmo nome no escopo do projeto tem precedência sobre a de
usuário; `scripts/install.ts` remove essas entradas justamente por isso.

Variante somente leitura, para um agente menos confiável:

```sh
claude mcp add -s user aliexpress --env ALIEXPRESS_READ_ONLY=1 -- /Users/você/.local/bin/aliexpress mcp
```

Outros clientes (Claude Desktop e afins) leem o mesmo bloco `mcpServers`, com
`command`, `args` e, se precisar, `env`.

## Ritmo e anti-bot

O default é uma requisição a cada 400 a 600 ms, sempre serial. O crawl completo
das 7 páginas da conta de referência rodou estável assim. Se aparecer o desafio
anti-bot, o cliente grava um cooldown de 30 minutos em `meta`. Ele sobrevive ao
processo, de propósito: um agente que reiniciasse e tentasse de novo só
aprofundaria o bloqueio.
