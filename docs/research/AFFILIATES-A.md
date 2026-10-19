# Amazon, Shopee e AliExpress: contratos e limites verificáveis

Pesquisa realizada em 18 de outubro de 2026 (horário de Brasília). Não houve acesso às contas do usuário nem chamada autenticada às lojas. Fontes técnicas abaixo são dos próprios operadores; ausência de contrato público legível está indicada, em vez de preencher lacunas com parâmetros inventados.

## Decisões para o PromoBridge

1. Amazon: continuar permitindo o link direto com `tag`, classificando a verificação como estrutural. Para enriquecimento de produto e uma resposta atribuída obtida pela conta, integrar **Creators API**, e não PA-API 5. A API nova tem documentação pública suficiente para implementar o cliente.
2. Shopee: integrar o gerador oficial autenticado quando App ID e Secret estiverem disponíveis. A existência das funções é confirmada oficialmente, mas o schema completo não ficou acessível publicamente nesta pesquisa. O contrato candidato abaixo precisa de confirmação no Explorer da conta antes de se declarar compatível/validado.
3. AliExpress: manter o caminho manual por produto como alternativa utilizável. Os documentos oficiais públicos encontrados pertencem a versões diferentes. Não misturar o gateway TOP legado, o gateway `/rest` novo e o gateway `/sync` citado em SDKs independentes. O contrato do aplicativo aprovado precisa determinar qual família será usada.
4. Um par de URLs original/afiliado de um produto nunca autoriza gerar links dos outros produtos de Shopee/AliExpress por substituição de IDs ou parâmetros. Links opacos devem conservar o valor exato retornado pela loja ou informado para aquele produto.

## Amazon Brasil

### Cadastro e credenciais

O titular precisa de conta de Associados definitivamente aceita e de vendas qualificadas. O proprietário principal acessa Ferramentas → Creators API, cria a aplicação e gera **Credential ID, Secret e Version**. Não basta ter uma tag. As credenciais e tokens devem permanecer no worker. [Cadastro oficial](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding/register-for-creators-api), [portal brasileiro](https://associados.amazon.com.br/).

### Token e catálogo

Credencial versão `3.1` usa o endpoint de token abaixo; a versão é da credencial e não deve ser inferida apenas pelo país do produto. `3.2` usa `api.amazon.co.uk`, e `3.3`, `api.amazon.co.jp`. O host de catálogo é comum. Tokens podem ser reutilizados até a expiração. O acesso em outro marketplace ainda exige aprovação regional e uma Partner Tag válida nele. [Guia HTTP oficial](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl).

```http
POST https://api.amazon.com/auth/o2/token
Content-Type: application/json

{"grant_type":"client_credentials","client_id":"<credential-id>","client_secret":"<secret>","scope":"creatorsapi::default"}
```

Resposta de autenticação, com valores ilustrativos:

```json
{"access_token":"<opaque-token>","token_type":"bearer","expires_in":3600,"scope":"creatorsapi::default"}
```

```http
POST https://creatorsapi.amazon/catalog/v1/getItems
Authorization: Bearer <access-token>
Content-Type: application/json
x-marketplace: www.amazon.com.br

{"itemIds":["B0TEST0001"],"itemIdType":"ASIN","marketplace":"www.amazon.com.br","partnerTag":"sua-tag-20","resources":["itemInfo.title","images.primary.large","offersV2.listings.price","offersV2.listings.availability"]}
```

Para BR: marketplace `www.amazon.com.br`, idioma `pt_BR`, moeda `BRL`. São valores confirmados, não tradução presumida. [Referência do Brasil](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/locale-reference/brazil).

O resultado contém `asin` e `detailPageURL`; usar a URL fornecida pela API sem reconstruir seus parâmetros. Até dez ASINs por pedido; resultados podem vir em outra ordem e itens indisponíveis aparecem em `errors`. Associar pelo ASIN. **A documentação está inconsistente**: o guia HTTP usa `itemsResult.items`; a página da operação mostra `itemResults.items`. O parser deve aceitar ambos explicitamente até confirmar a resposta real da conta. [Contrato GetItems](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/get-items).

Exemplo reduzido e adaptado ao Brasil, não resposta real:

```json
{"itemsResult":{"items":[{"asin":"B0TEST0001","detailPageURL":"https://www.amazon.com.br/dp/B0TEST0001?tag=sua-tag-20&linkCode=ogi&language=pt_BR&th=1&psc=1","itemInfo":{"title":{"displayValue":"Título ilustrativo"}}}]}}
```

No validador atual do PromoBridge, `language` não está na lista permitida: uma URL legítima do Creators API pode ser recusada por esse motivo. Conferir idioma permitido do marketplace e somente aceitar o ASIN e a tag exatos. Resposta autenticada e URL estruturalmente correta continuam sem garantir venda futura ou comissão.

### Migração, validação e publicação

PA-API 5 foi substituída; a documentação atual informa `403 AccessDeniedException` para chamadas remanescentes. Não desenvolver nova assinatura SigV4 para esse produto. [Aviso oficial](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation).

A Amazon permite construir links usando a tag e oferece um Verificador de links para links construídos/modificados fora da Central. Links gerados na própria Central já vêm codificados e esse verificador não se destina a eles. Isso não é uma API pública de comprovação de titularidade. [Ajuda oficial de verificação](https://associados.amazon.com.br/help/node/topic/G6253GFSARDQENZR).

As políticas BR atualizadas em 14/04/2026 admitem e-mails, SMS e mensagens diretas solicitadas pelo destinatário. Não criar cliques artificiais ou sessões para “testar comissão”; não associar subtags a pessoas individuais. Histórico de preço público e alertas de preço têm restrições próprias e não devem ser habilitados automaticamente a partir do conteúdo Amazon. Há ajuda antiga mais restritiva; a política vigente contém a regra específica. [Políticas brasileiras](https://associados.amazon.com.br/help/operating/policies/?ac-ms-src=ac-nav).

O texto publicitário deve ficar próximo do link. A conta/site também precisa da declaração obrigatória: “Como associado da Amazon, eu ganho com compras qualificadas”. O texto genérico atual “Link de afiliado” pode receber `Publicidade` e a declaração correspondente quando a loja for Amazon. [Identificação exigida no Brasil](https://associados.amazon.com.br/help/node/topic/GPXFHVYZMTGPUMPE).

## Shopee Brasil

### Confirmado em fontes oficiais

- O [portal brasileiro Open API](https://affiliate.shopee.com.br/open_api) existe; o [Explorer BR v2](https://open-api.affiliate.shopee.com.br/explorer/v2) solicita App ID e Secret. O Explorer legado retorna `Invalid Credential` quando não autenticado e não expõe schema nessa condição.
- A [ajuda oficial Shopee](https://help.shopee.sg/portal/10/article/191702-API-Access) descreve listas de ofertas Shopee/marcas/produtos, geração de shortlinks e relatórios de conversão/validação. Essa fonte é de Singapura; não estabelece sozinha aprovação ou quota brasileira.
- A geração manual oficial é oferecida no aplicativo e no portal: Conta → Link de Conversão, ou Oferta → Link personalizado. [Ajuda de geração](https://help.shopee.com.br/portal/10/article/128461-Como-gerar-links-de-produtos-ou-lojas).
- Até cinco subIDs são permitidos no gerador manual para campanha/canal; devem ser escolhidos como rótulos operacionais, não dados pessoais. [Ajuda de subIDs](https://help.shopee.com.br/portal/10/article/127556?previousPage=other+articles).
- WhatsApp e Telegram são canais explicitamente mencionados. [Onde divulgar](https://help.shopee.com.br/portal/10/article/170264-%5BFAQ%5D%20Onde%20posso%20divulgar%20meus%20links%20de%20Afiliado%3F).

### Contrato candidato a conferir na conta

O bloco abaixo é um plano técnico candidato, amplamente presente em clientes independentes. **Não foi possível atestar os detalhes em documentação oficial legível nesta sessão.** Não deve sustentar o selo “validado em produção”. O domínio `affiliateshopee.com.br`, que aparece em buscas, se declara não oficial e não deve ser confundido com `affiliate.shopee.com.br`.

```ts
// CANDIDATO: confirmar no Explorer autenticado antes de ativar.
const body = JSON.stringify({
  query: 'mutation { generateShortLink(input: { originUrl: "https://shopee.com.br/product/123/456", subIds: ["promobridge", "whatsapp"] }) { shortLink } }'
});
const timestamp = String(Math.floor(Date.now() / 1000));
// Signature candidata = SHA256(appId + timestamp + body + secret), hex.
// Header candidato:
// Authorization: SHA256 Credential=<appId>, Timestamp=<timestamp>, Signature=<hex>
// POST candidato: https://open-api.affiliate.shopee.com.br/graphql
// Content-Type: application/json
// Resposta candidata: { data: { generateShortLink: { shortLink: '<opaque-url>' } } }
```

Ao implementar, manter o body exatamente igual ao que foi assinado; não usar HMAC para substituir uma concatenação SHA256 sem conferir o contrato. Consultar `errors` mesmo com HTTP 200. O retorno opaco deve ficar associado ao `shopId.itemId` original e ao fingerprint da conta que gerou a requisição. Um único link de calibração não prova que outro shortlink pertence à mesma conta.

`productOfferV2` é um candidato útil para obter produto, preço, imagem, comissão e `offerLink`; só solicitar recursos confirmados pelo schema aprovado. Não reconstruir “preço anterior” por divisão de um percentual arredondado e apresentá-lo como fato.

## AliExpress

### O que é verificável publicamente

A documentação oficial legada descreve `aliexpress.affiliate.link.generate` com parâmetros `promotion_link_type`, `source_values` e `tracking_id`; `app_signature` é opcional. `promotion_link_type=0` significa link normal. O resultado inclui `resp_code`, `resp_msg`, `result.tracking_id` e uma coleção com `promotion_link`/`source_value`. A árvore está explicitamente marcada **Affiliate API (deprecated)**. Isso comprova a estrutura histórica, sem assegurar disponibilidade atual no aplicativo do usuário. [Contrato oficial legado](https://open.alitrip.com/docs/doc.htm?articleId=45804&docType=2&treeId=674).

Payload lógico do método legado, sem presumir gateway ativo:

```json
{"method":"aliexpress.affiliate.link.generate","promotion_link_type":"0","source_values":"https://www.aliexpress.com/item/1005000000000001.html","tracking_id":"<tracking-id>"}
```

Envelope histórico reduzido:

```json
{"aliexpress_affiliate_link_generate_response":{"resp_result":{"resp_code":200,"resp_msg":"success","result":{"tracking_id":"<tracking-id>","promotion_links":{"promotion_link":[{"source_value":"https://www.aliexpress.com/item/1005000000000001.html","promotion_link":"https://s.click.aliexpress.com/e/<opaque>"}]}}}}}
```

O parser deve rejeitar sucesso sem `promotion_link`, `source_value` de outro produto, erro de negócio dentro de HTTP 200 e retorno com outro tracking ID. Nunca considerar o `tracking_id` inserido no pedido como prova de que um link que não foi retornado pelo servidor ganhou atribuição.

### Não misturar famílias de assinatura

| Família | Contrato oficial encontrado | Consequência |
|---|---|---|
| TOP legado | Parâmetros ordenados por ASCII; concatenar nome+valor, excluindo `sign`; MD5 com secret antes/depois, ou HMAC-MD5; hex maiúsculo; timestamp GMT+8 `yyyy-MM-dd HH:mm:ss`; gateway de época `https://eco.taobao.com/router/rest` | Somente implementar se o app/SDK oficial ainda indicar essa família. |
| Open Platform `/rest` | Endpoint `https://api-sg.aliexpress.com/rest`; ordenar parâmetros, prefixar nome/caminho da API e usar HMAC-SHA256; `sign_method=sha256`; timestamp ISO UTC ou número em milissegundos | Não transplantar o nome pontuado do método legado para uma URL REST por dedução. |
| Migração `/sync` | Não encontrado contrato primário público legível nesta pesquisa | Presente em SDKs independentes, mas precisa confirmação do SDK/explorer fornecido à conta. Não descrever como suporte oficial validado. |

[Assinatura TOP oficial](https://open.alitrip.com/docs/doc.htm?articleId=118934&docType=1&treeId=674), [endpoint REST oficial](https://open.alitrip.com/docs/doc.htm?articleId=120689&docType=1&treeId=727), [assinatura REST oficial](https://open.alitrip.com/docs/doc.htm?articleId=120692&docType=1&treeId=727), [parâmetros REST oficiais](https://open.alitrip.com/docs/doc.htm?articleId=120691&docType=1&treeId=727). Esses documentos são de 2022 e precisam ser confrontados com o contrato atual da conta.

O console trabalha com grupos de permissões; chaves existentes não significam que a API necessária está ativa. O operador documenta grupos Active/Inactive e solicitação no App Overview → API Permission Group. [Permissões oficiais](https://open.alitrip.com/docs/doc.htm?articleId=120676&docType=1&treeId=727). Usar [AliExpress Portals](https://portals.aliexpress.com/) para a afiliação e [Open Service](https://openservice.aliexpress.com/) para a documentação/console atuais; os detalhes protegidos por login não foram acessados nesta sessão.

## Atribuição e redirecionamentos opacos

Recomendações de projeto, não promessas das lojas:

- Separar **identidade do produto**, **origem do link**, **conta utilizada**, **estado técnico do pedido** e **comissão**. “Link gerado” não equivale a “comissão garantida”.
- Evidência mínima de API: produto canônico de entrada, conta/configuração sem segredos ou seu fingerprint, URL retornada exata, método, horário e ID da requisição se fornecido. Revalidar quando a conta muda.
- Cadastro manual: chave por plataforma+produto+marketplace e URL afiliada exata. O usuário confirma a origem no próprio painel oficial; mostrar isso como confirmação do operador, não como resposta autenticada da loja.
- Expandir links recebidos com limite de saltos, validação de hostname e endereço IP em cada redirecionamento. HTTPS e hostname conhecido isolados não provam afiliado nem garantem que o shortlink aponta para o item informado.
- Quando o shortlink opaco não pode ser ligado ao mesmo produto por resposta autenticada ou verificação do operador, manter na revisão. Nunca completar com `?affiliate_id=`, `utm_source`, `tracking_id` ou outro parâmetro arbitrário.
- Não obter uma “validação” visitando periodicamente links afiliados e criando cliques. Fazer a prova estrutural/criptográfica ou a consulta oficial que não simule um cliente.

## Critérios de aceitação para o código

- Cliente HTTP de autenticação separado de links/conteúdo; chaves somente no worker e omitidas de logs, backups e respostas da API.
- Timeout, limite de resposta, retry com backoff para falhas transitórias; nunca repetir de modo indefinido credencial/permissão inválida.
- Fixtures baseadas nos envelopes acima, mais erro HTTP 200, resultado incompleto, produto divergente, host malicioso e troca de credenciais. Esses testes comprovam o cliente, não a aprovação da conta.
- Diagnóstico no painel: “conta não configurada”, “acesso não autorizado”, “produto sem link”, “link manual confirmado” ou “API respondeu”. Evitar um único selo verde para condições distintas.
- Smoke test real só poderá ser concluído depois da configuração das credenciais do usuário. Registrar data, operação e resultado real antes de anunciar integração validada.
