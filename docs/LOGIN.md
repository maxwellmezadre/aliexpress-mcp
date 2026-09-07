# Login

## Por que precisa de um navegador

Não existe OAuth de comprador no AliExpress. A sessão são cookies, e os que
autenticam de verdade são `HttpOnly`, e `document.cookie` não os enxerga. Só o
navegador (via `context.cookies()` do Playwright) ou o banco de cookies dele
entregam a sessão completa. Copiar `document.cookie` à mão produz um jar que
não autentica nada.

## O caminho normal

```sh
aliexpress login
```

1. Abre o Chrome (perfil persistente em `~/.config/aliexpress-mcp/browser-profile/`)
   com os sinais de automação desligados.
2. Navega para `aliexpress.com/p/order/index.html`.
3. **Você** faz o login: senha, SMS, Google, captcha, o que o AliExpress pedir.
   A ferramenta nunca vê credencial.
4. A cada 2 segundos ela pergunta à API, **de dentro da própria página**, se a
   sessão já vale, chamando `order.list` pelo SDK do site. Não é URL, não é
   seletor: os dois mudam sem aviso e os dois já são verdadeiros antes do login
   terminar.
5. Volta à página de pedidos, o que faz o servidor emitir os cookies `HttpOnly`.
6. Grava tudo cifrado e confirma com uma chamada real.

Opções: `--timeout <minutos>` (default 5), `--fresh` (apaga o perfil e começa
do zero).

> O probe usa `order.list` e **não** `order.count`: o `count` responde `SUCCESS`
> com zeros mesmo deslogado, e usar ele daria "login detectado" antes de você
> digitar a senha.

## Importando de um navegador já logado (macOS)

```sh
aliexpress login --from-browser chrome    # arc | chrome | chromium | brave | edge
```

Lê o banco de cookies do navegador e decifra com a chave que ele guarda no
Keychain. O macOS vai pedir sua permissão uma vez. Nada é automatizado no
navegador e nenhuma senha é lida.

**Ressalva:** a sessão passa a ser compartilhada com aquele navegador. Se o
AliExpress rotacionar um cookie de um lado, o outro pode cair; reimportar
resolve. E um navegador com login antigo pode ter uma sessão **parcial**, que
passa no `order.count` mas é recusada no `order.list`; nesse caso use o login
normal.

## O que é gravado, e onde

| Arquivo | Conteúdo |
| --- | --- |
| `~/.config/aliexpress-mcp/session.enc` | Cookies, User-Agent e região — AES-256-GCM, modo 0600 |
| `~/.config/aliexpress-mcp/session.key` | A chave, se você não definiu `ALIEXPRESS_SESSION_KEY` |
| `~/.config/aliexpress-mcp/browser-profile/` | Perfil do Chrome, para não pedir OTP toda vez |

Formato do arquivo: `[0] versão | IV 12B | tag GCM 16B | ciphertext`. A escrita
é atômica (`.tmp` + rename), porque o servidor MCP pode estar gravando a
renovação de um cookie no exato momento em que você refaz o login.

O User-Agent é gravado junto e reenviado em toda requisição: divergir dele
aumenta a chance de cair no anti-bot.

## Ciclo de vida

| Evento | O que acontece |
| --- | --- |
| Token `_m_h5_tk` expira | Transparente: o servidor manda um novo, o cliente absorve e reassina |
| Cookies renovados | Absorvidos e regravados, só quando algo realmente mudou |
| Sessão cai | Erro acionável. Rode `aliexpress login`; o servidor MCP recarrega sozinho |
| Anti-bot | Cooldown de 30 min gravado em disco. Resolva o desafio no navegador |

Na prática a sessão dura semanas.

## Revogando

```sh
rm ~/.config/aliexpress-mcp/session.enc
```

E, para invalidar de verdade do lado do AliExpress, saia da conta em todos os
dispositivos pelas configurações de segurança do site. Apagar o arquivo local
só remove a cópia; os cookies continuariam válidos se alguém já os tivesse.
