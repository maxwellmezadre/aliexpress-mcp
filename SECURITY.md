# Segurança

## O modelo de ameaça

**O jar de cookies é a conta inteira.** Quem o tiver entra sem senha e sem
segundo fator. Todo o resto deste documento decorre disso.

| Proteção | Como |
| --- | --- |
| Sessão em repouso | AES-256-GCM, arquivo `0600`, escrita atômica. A chave vem do ambiente ou de um `session.key` `0600` |
| Sessão em log | Todo valor de cookie é redigido em toda linha de log, por um provedor que acompanha as renovações. Headers nunca são logados |
| Sessão em resposta de tool | `auth_status` devolve contagens e validade, nunca um valor de cookie |
| Cache | `cache.db` `0600`, com o `umask` forçado na criação. Contém endereço e histórico de consumo |
| Escrita em disco | Só `export`, e só dentro de `ALIEXPRESS_EXPORT_DIR`. Nome de arquivo é higienizado e o caminho resolvido é conferido contra o diretório |
| Escrita na conta | Não existe. `raw_get` recusa por regex qualquer API de escrita (`*.operation`, `*.submit`, `*.cancel`, `*.confirm`…) |
| Superfície da API | `raw_get` só aceita `mtop.aliexpress.*` e `mtop.ae.*` |
| Anti-bot | Uma requisição por vez, com intervalo. Um desafio trava o cliente e grava um cooldown de 30 minutos que sobrevive ao processo — para que um agente reiniciando não aprofunde o bloqueio |
| Fixtures | Anonimização determinística com leak guard em duas passadas, mais um teste permanente contra e-mail, CEP e rastreio |

Relatos que contornem qualquer uma dessas proteções são especialmente
bem-vindos.

## Nunca faça

- Não cole `session.enc`, `session.key`, `cache.db` nem um header `Cookie` numa
  issue, num log ou num prompt.
- Não commite nada de `task/`: é onde ficam as capturas cruas e o salt.
- Não rode este projeto contra a conta de outra pessoa.

## Revogando uma sessão

```sh
rm ~/.config/aliexpress-mcp/session.enc
```

Isso apaga a cópia local. Para invalidar do lado do AliExpress, saia da conta
em todos os dispositivos nas configurações de segurança do site.

## Reportando

**Não abra uma issue pública** para uma vulnerabilidade. Reporte por
[GitHub Security Advisories](https://github.com/maxwellmezadre/aliexpress-mcp/security/advisories/new),
com passos de reprodução.
