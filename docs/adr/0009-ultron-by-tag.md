# ADR-0009: Ler o Ultron por `tag` e pela hierarquia

Status: Aceito

## Contexto

`order.list` e `order.detail` respondem com um grafo de
componentes. As chaves são `pc_om_list_order_<id>` e
`pc_om_list_body_109702`: o sufixo é um id no CMS do AliExpress.

## Decisão

Selecionar componentes por `tag`, nunca pela chave literal, e tirar a ordem de
`hierarchy.structure`, nunca de `Object.keys(data)`.

Não é teoria: medido na conta real, a ordem das chaves de `data` vem
embaralhada (`Jul 15, May 18, Jun 26, …`) enquanto `structure` traz a
cronológica correta (`Sep 1, Sep 1, Jul 15, …`). Iterar as chaves entregaria as
compras do usuário fora de ordem, sem erro nenhum.

Junto vai uma guarda para a falha silenciosa da paginação: o POST da página
seguinte exige `linkage`, e **sem ele o servidor responde `SUCCESS` com `data`
vazio**, indistinguível de "acabaram os pedidos". A camada recusa montar a
página nesse caso, e o `doctor` tem um teste negativo dedicado.

## Consequências

Uma renumeração no CMS do AliExpress não quebra nada. Um componente novo é
ignorado em vez de derrubar o parser.
