# ADR-0006: Sessão cifrada em repouso

Status: Aceito

## Contexto

O jar de cookies **é** a conta: quem o tiver entra sem senha e
sem segundo fator. Ele fica no disco de uma máquina de trabalho, ao lado de
backups, sincronizações e ferramentas de busca.

## Decisão

AES-256-GCM, arquivo `0600`, layout `[0] versão | IV 12B | tag 16B |
ciphertext`. A chave vem de `ALIEXPRESS_SESSION_KEY` ou de um `session.key`
gerado no primeiro login: zero configuração para quem não quer pensar nisso.

Escrita atômica (`.tmp` + rename): o servidor MCP pode estar gravando a
renovação de um cookie no mesmo instante em que o CLI faz um login novo.

## Consequências

Um `cat` no arquivo não entrega nada. A chave ao lado não protege contra quem
já tem a sua conta de usuário. Protege contra o resto: backup, sincronização,
um `grep -r` distraído. Perder a chave custa um login novo, nada mais.
