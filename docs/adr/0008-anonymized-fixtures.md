# ADR-0008: Fixtures reais anonimizadas num repositório público

Status: Aceito

## Contexto

Testes contra payloads inventados provam pouco: as armadilhas
reais (ordem embaralhada, três formatos de dinheiro, rótulos não
documentados) só aparecem no que o AliExpress realmente devolve. Mas o
repositório é público e a conta é de uma pessoa.

## Decisão

Capturar as respostas cruas em `task/captures/` (fora do git, `0600`) e gerar
`test/fixtures/` com um anonimizador determinístico:

- todo bloco de 9+ dígitos vira `sha256(salt + valor)`, **mantendo comprimento
  e os 4 primeiros dígitos**, e o mesmo mapa vale para as *chaves* dos
  componentes Ultron, senão o grafo deixa de resolver;
- **valores monetários nunca são tocados** (nenhum tem 9 dígitos), então as
  identidades financeiras continuam verdadeiras;
- PII vira valor fixo; `linkage`, que é um blob assinado da sessão, vira stub.

Duas passadas: tudo é anonimizado primeiro, e só então cada saída é conferida
contra os segredos colhidos de **todas** elas. O script falha se algo escapar,
e `test/fixtures.test.ts` é a guarda permanente.

## Consequências

Os testes rodam sobre dados reais e as relações entre fixtures sobrevivem: o
`tradeOrderId` do detalhe continua sendo um dos `orderId` da lista. O salt fica
fora do git, então o mapa não é reversível por quem clona.
