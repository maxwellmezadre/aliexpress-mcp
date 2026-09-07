# ADR-0005 — Sessão por cookie, capturada pelo navegador

- **Status:** Aceito
- **Contexto:** O AliExpress não tem API de comprador. A Open Platform atende
  afiliado, dropshipping e vendedor, e não dá acesso ao histórico da própria
  conta. Não existe OAuth, access token nem refresh token para esse caso.

## Decisão

Autenticar pelos cookies da sessão do navegador do próprio usuário, capturados
por um login interativo com Playwright (ou importados do banco de cookies de um
navegador no macOS). A ferramenta nunca vê credencial.

O `storageState` é obrigatório porque os cookies que autenticam são `HttpOnly`
— `document.cookie` não os enxerga, e um jar montado dali não autentica nada.

## Consequências

O usuário faz login à mão de vez em quando. Não há como renovar sozinho: quando
a sessão cai, a ferramenta devolve um erro acionável e **não** tenta logar
sozinha. Os cookies equivalem à conta inteira, daí a cifragem em repouso
(ADR-0006).
