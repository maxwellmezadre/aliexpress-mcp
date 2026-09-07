# ADR-0007: Dinheiro em centavos inteiros

Status: Aceito

## Contexto

A ferramenta soma valores de anos de compras. Ponto flutuante
acumula erro, e o SQLite não tem tipo decimal. Pior: o AliExpress entrega
dinheiro em **três formatos que discordam entre si**: `formatPriceInfo`
(`"R$132,74|132|74"`), string com vírgula decimal e string com **ponto**
decimal, essa última na API de devoluções, na mesma conta e no mesmo dia.

## Decisão

Centavo inteiro em toda a aplicação e no banco. A conversão para decimal
acontece só na borda da tool (`cache/rows.ts`). O parser prefere sempre o
formato com pipe, que não depende de locale; a string só é interpretada quando
não há alternativa, decidindo o separador decimal **pelo próprio texto**.

## Consequências

`SUM()` é exato. Um valor que não pôde ser lido vira `null`, nunca zero: um
zero silencioso mentiria num relatório de gastos. A soma das linhas do
breakdown ainda pode divergir do total em 1 a 3 centavos, mas por causa do
arredondamento do próprio AliExpress, não nosso.
