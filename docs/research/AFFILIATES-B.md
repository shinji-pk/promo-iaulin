# Pesquisa de afiliação: Mercado Livre, Magalu, SHEIN e Temu

Consulta em 18/10/2026, horário de São Paulo. Fontes primárias oficiais. Este documento registra evidência e recomendações; não afirma que credenciais, atribuição de comissão ou contas reais foram testadas.

## Resultado para o produto

As quatro lojas oferecem geração de links no próprio portal/aplicativo. Não foi localizada documentação pública oficial de uma API de **geração de links afiliados** que possa ser implementada com um identificador público nestas quatro integrações. Isso é um limite da evidência encontrada, não uma afirmação de inexistência de APIs comerciais ou de parceria.

O caminho viável sem pedir senhas é incorporar a abertura do gerador oficial e a importação do link gerado para **aquele produto**. O PromoBridge pode conferir HTTPS, domínio, redirecionamentos e igualdade do produto, conservar o link completo e registrar a declaração da usuária de que o gerou na própria conta. Essa conferência não prova a titularidade da afiliação nem comissão. Não chamar esse estado de “afiliação comprovada”. Se a identidade ou a atribuição exigida pela política do app não puder ser confirmada, manter pendência/revisão, com motivo específico.

| Loja | Geração oficial encontrada | Implementação viável agora | Lacuna para automação integral |
| --- | --- | --- | --- |
| Mercado Livre | Gerador de Links, Barra de Afiliados ou Central | Importar link original e link gerado do mesmo produto; conservar todo o rastreamento | Contrato/API autorizada de afiliação e acesso real da conta |
| Magalu | “Gerar link” na página do produto da própria loja | Importar link da loja e produto, conferir o identificador da loja e do produto | Documentação autorizada para geração em lote/links do divulgador |
| SHEIN | Produto recomendado no Centro de Afiliados novo | Importar exatamente o link de produto gerado nesse centro | API autorizada e elegibilidade do produto na conta |
| Temu | Portal e produtos com rastreamento no app | Importar link do produto; separar campanhas e códigos | API afiliada autorizada; semântica da campanha e conta |

## Mercado Livre Brasil

### Evidência oficial

- O [guia de geração](https://www.mercadolivre.com.br/l/afiliados-gere-seus-links) orienta colar a URL do produto no Gerador de Links do portal no computador, ou ativar a Barra de Afiliados e usar Compartilhar pelo computador/aplicativo. Não publica um endpoint nem regra de montagem de URL nessa página. A abertura direta retornou 403 nesta pesquisa; o conteúdo oficial foi recuperado pelo índice de busca.
- O [guia de direcionamento](https://www.mercadolivre.com.br/l/afiliados-direcionamento-de-visitas) determina usar links gerados pelas ferramentas do programa e não abrir automaticamente páginas do Mercado Livre para visitantes.
- A [lista de páginas não permitidas](https://www.mercadolivre.com.br/l/afiliados-paginas-nao-permitidas) exige produto específico; páginas iniciais, buscas/categorias, carrinho, vendedores e diversos serviços não são substitutos válidos de um link de produto comissionável. Não converter listas em um único produto.
- O [checklist oficial](https://www.mercadolivre.com.br/l/checklist) descreve os canais públicos de divulgação. As [boas práticas](https://www.mercadolivre.com.br/l/boas-praticas-links) informam limites para grupos privados/chats fechados e canais não declarados, além da identificação clara de publicidade. A interface deve mostrar essa orientação no contexto de destinos do Mercado Livre, sem prometer ganho em qualquer grupo.
- A [documentação de identificadores](https://developers.mercadolivre.com.br/pt_br/identificadores-de-produtos) documenta `GET https://api.mercadolibre.com/items/{ITEM_ID}?include_attributes=all`, com access token Bearer. O [guia in-house](https://developers.mercadolivre.com.br/devcenter/desenvolvimento-in-house) descreve troca OAuth por `POST https://api.mercadolibre.com/oauth/token`, com `grant_type=authorization_code`, `client_id`, `client_secret`, `code` e `redirect_uri`. São APIs da plataforma/marketplace; essas páginas não documentam criação de link de afiliado. Um token de vendedor não deve aparecer na UI como credencial suficiente para afiliação.

### Identidade do produto e limitações atuais

O adaptador existente reconhece anúncios `MLB-<número>` e catálogo `/p/MLB<número>`, corretamente separados. Falta reconhecer User Products `/up/MLBU<número>`, que aparecem em páginas reais do próprio domínio. A [documentação de preços](https://developers.mercadolivre.com.br/pt_br/servicos-gerenciamento-de-contatos/precos-liquidos) retorna `id`, `user_product_id` e `catalog_product_id` como entidades distintas. Não remover o `U`, nem equiparar catálogo e anúncio por coincidência numérica. Só uma consulta oficial pode provar a correspondência entre namespaces.

Um [exemplo de página oficial com User Product](https://www.mercadolivre.com.br/erp-para-empresas--2024--envio-imediato-24h--152-modulos/up/MLBU2321504314) demonstra o formato de rota. É evidência de URL, não recomendação do produto nem validação de elegibilidade.

Parâmetros como `matt_tool`, etiquetas e links curtos não podem ser reinventados a partir de um exemplo. Uma URL resolvida pode comprovar o destino do produto, mas não que o link pertence à usuária. Copiar cookies de sessão e reproduzir endpoints internos vistos em tutoriais de terceiros não equivale a uma API oficial documentada.

Cadastro/portal: [Programa de Afiliados e Criadores](https://www.mercadolivre.com.br/l/afiliados-home). O [guia de acesso](https://www.mercadolivre.com.br/l/afiliados-portal-do-afiliado) explica entrar na própria conta e abrir Afiliados. Isso deve acontecer no navegador oficial, sem coleta da senha pelo PromoBridge.

## Influenciador Magalu

### Evidência oficial

- O [artigo oficial de códigos de produtos](https://www.magazinevoce.com.br/blog/artigo/como-usar-os-codigos-de-produto), atualizado em 30/09/2025, orienta pesquisar o código na própria loja, abrir o produto e clicar em “Gerar link”. Seleções de vários produtos possuem outro fluxo; não tratá-las como link de produto único.
- Os [termos oficiais](https://www.magazinevoce.com.br/termos-de-uso/), definições e seção 3, identificam `magazinevoce.com.br` e `influenciadormagalu.com.br` como sites do programa, uma URL de loja customizada ao influenciador e links específicos extraídos da loja. A seção 7 vincula remuneração a vendas elegíveis; um identificador público da loja não comprova aprovação da conta ou pagamento.
- O [portal Magalu Devs](https://developers.magalu.com/docs/) descreve APIs de produtos, pedidos e outros domínios com OAuth2/ID Magalu. Não foi encontrada ali documentação pública para gerar links do Influenciador. Não confundir essas APIs com a afiliação.
- A [central oficial do divulgador](https://divulgador-magalu.zendesk.com/hc/pt-br) orienta usar o painel para vendas/comissões e confirma que o estoque da loja acompanha o estoque da plataforma. O PromoBridge não deve fabricar métricas de vendas a partir de cliques ou mensagens publicadas.

### Identidade do produto e implementação

O adaptador atual aceita `magazineluiza.com.br` e `magalu.com`, porém rejeita os dois domínios de loja do programa citados nos termos. Acrescentar identificação nesses domínios, preservando a loja da URL como dado separado da identidade do produto.

Uma [página real no domínio oficial](https://www.magazinevoce.com.br/magazinecatvirtual/kit-4-livros-infantis-educativos-comportamento-e-aprendendo-valores-on-line/p/bc1g05fhc9/li/kdli/?seller_id=machadolivrariaepapelaria) mostra `/<loja>/<slug>/p/<id>/<categorias>/`. O ID de produto pode ser comparado ao link original; `seller_id`, variantes e condições precisam ser preservados para não anunciar preço de outro vendedor. O exemplo não comprova titularidade de qualquer loja da usuária.

É possível verificar que um link importado pertence ao **nome de loja configurado**, mas a configuração desse nome continua sendo uma declaração pública da usuária. Não há prova criptográfica de propriedade. Não generalizar um `promoter_id` observado em uma URL para todos os produtos sem documentação e teste autorizado da conta. Conservar o link exato retornado pelo gerador é o primeiro suporte confiável.

Cadastro: [Influenciador Magalu](https://www.magazinevoce.com.br/), opção de criação de loja. Login ocorre na loja oficial.

## SHEIN Brasil

### Evidência oficial decisiva

A [comunicação oficial brasileira do programa](https://m.shein.com/br/campus--a-1500.html) informa o encerramento do programa antigo em 29/08/2024 e invalidação dos códigos antigos. O programa novo exige novo registro e validação de rede social. Produtos precisam ser selecionados no Centro de Afiliados, onde o link é gerado; compartilhamentos comuns do site/aplicativo não entram no cálculo da comissão. Campanhas podem gerar link e código, mas produto recomendado gera link de produto. A fonte é uma comunicação de migração; taxas/prazos vigentes devem ser confirmados na conta atual, sem fixá-los no código.

O cadastro indicado pela própria SHEIN é [Nova Plataforma de Afiliados](https://onelink.shein.com/3/3usk7i1vyedb), ou pesquisar “afiliado” no aplicativo. O suporte novo citado é `affiliateprogram@shein.com`.

### Implementação e limites

O ID numérico em `...-p-<id>.html` é observável em [páginas oficiais brasileiras de produto](https://br.shein.com/Food-Packaging-Paper-p-109498494.html). A identificação atual é compatível com esse padrão. Impedir ambiguidades quando existirem parâmetros de identidade conflitantes. Não considerar um ID global suficiente para igualar automaticamente marketplaces/países diferentes.

A importação deve conservar exatamente o link recebido do Centro de Afiliados. Não basta trocar `url_from`, adicionar um código herdado ou gerar um `onelink` com formato parecido. Links de campanha não são provas do produto anunciado. Caso um link opaco não exponha um produto verificável após os redirecionamentos, deixá-lo em revisão. A usuária pode fornecer a URL final para ajudar na conferência visual, mas isso não é uma resolução independente e não deve ser rotulado como prova automática.

Não foi localizada documentação pública oficial de geração de links afiliados brasileiros via API. O [portal de desenvolvedores SHEIN](https://open.sheincorp.com/) possui APIs comerciais; a existência de dados de comissão em APIs de conta/vendedor não demonstra uma API de geração de links do afiliado brasileiro.

## Temu Brasil

### Evidência oficial

O [FAQ oficial brasileiro de afiliados](https://www.temu.com/br/affiliate_question.html), seções Divulgação e links, descreve links de produto e campanha, códigos de indicação e materiais oficiais. Orienta obter links/códigos no portal, ou selecionar produtos no aplicativo com rastreamento habilitado. O destino pode ser produto, cupom, seleção ou campanha. O programa trabalha com novos usuários elegíveis e regras por mercado; o app não pode prometer comissão em toda compra. A verificação de tráfego é exigida para saque e ocorre na própria conta. Essas são condições distintas da conferência técnica do link pelo PromoBridge.

Cadastro: [Programa de Afiliados da Temu Brasil](https://www.temu.com/br/affiliate_recruit.html). A usuária informa os canais na própria plataforma e traz o link gerado para o app.

### API e identidade

A [documentação de endpoints da Partner Platform](https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303&sub_menu_code=8311de2b2d434e4d805e88413ab815d8) mostra roteadores regionais, por exemplo `https://openapi-b-global.temu.com/openapi/router`. A [documentação de autorização](https://partner.temu.com/documentation?menu_code=fb16b05f7a904765aac4af3a24b87d4a&sub_menu_code=8fb9a7179af64071a5a443b805fe3484) descreve autorização no Seller Center e chamada `bg.open.accesstoken.create` após receber um código. A documentação é voltada a comerciantes/soluções comerciais. Não é evidência de um endpoint de geração de links afiliados acessível à usuária. A navegação direta depende de JavaScript; títulos e trechos documentais foram recuperados pelo índice oficial.

O adaptador atual compara o número em `-g-<id>.html` ou `goods_id`, já rejeitando conflito entre path e query. O [domínio oficial apresenta rotas brasileiras com esse padrão](https://www.temu.com/br/mens-hip-hop-baggy-jeans-loose-street-style-pants-that-drag-on--trendy-multi--jeans-suitable-for--g-601099921270744.html), mas essa amostra retornou uma tela de login/404 ao indexador. Tratar o padrão como identificação sintática, sem prometer produto disponível ou preço atual. Evitar aceitar `goods_id` em qualquer página de campanha como se transformasse a campanha em produto.

Não foi localizada uma API pública oficial de geração de links de afiliados. Códigos de convite, links para cupons e parâmetros de campanha não devem ser aplicados arbitrariamente a todos os produtos.

## Fluxo mínimo recomendado no PromoBridge

1. Na loja, oferecer `Abrir gerador oficial` e uma explicação curta específica; sem campos de senha/cookie.
2. Na oferta pendente, oferecer `Usar meu link de afiliado`, com URL original e URL gerada naquela conta.
3. Resolver redirecionamentos com o resolvedor HTTPS existente, conferir domínio/plataforma e **mesma identidade**, recusando destinos de campanha/lista quando a oferta é de produto único.
4. Registrar link exato, URL final observada, produto, loja/identificador público quando verificável, momento da validação e origem da evidência. Separar `produto conferido`, `titularidade declarada` e `comissão não verificada`.
5. Vincular somente àquele produto e conta configurada. Reaproveitar exatamente o link salvo para o mesmo produto; não inferir um gerador universal do par de calibração.
6. Na fila, permitir uma ação concreta para resolver links pendentes e reprocessar a oferta após o vínculo. O restante do pipeline (pontuação, mensagem, deduplicação, agendamento e envio) pode permanecer automático.
7. Exibir métricas internas de processamento/envio como tais. Receitas, vendas e comissão ficam no portal oficial até existir integração autorizada que as retorne.

O limite de propriedade não se resolve comparando dois links fornecidos pela mesma pessoa. Se o contrato do app exigir titularidade comprovada antes de qualquer publicação, os links opacos destas lojas continuam bloqueados até integração oficial autenticada. Se o produto permitir aprovação manual, a declaração pode habilitar envio revisado com rótulo honesto e auditoria, sem promover esse estado a validação automática de afiliação.
