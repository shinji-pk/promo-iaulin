import type { IntegrationGuide } from './features.ts';

const guides:IntegrationGuide[] = [
  {
    platform:'amazon',name:'Amazon',automatic:true,
    officialPortal:'https://associados.amazon.com.br/',
    documentationUrl:'https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl',
    steps:[
      'Entre na sua conta oficial de Associados. Configure sua tag pública e calibre um link do mesmo marketplace no painel.',
      'Se a conta tiver acesso à Creators API, crie a aplicação em Ferramentas → Creators API e copie Credential ID, Secret e Version para a conexão local.',
      'Habilite a loja, salve a tag e teste a conexão usando a URL direta de um produto. Só uma resposta autenticada para esse ASIN ativa a API.',
      'Sem Creators API, links diretos com sua tag continuam disponíveis após calibração; a validação é estrutural, sem comprovar titularidade ou comissão.'
    ],
    fields:[{key:'credentialId',label:'Credential ID',secret:false,required:true},{key:'credentialSecret',label:'Credential Secret',secret:true,required:true},{key:'credentialVersion',label:'Versão da credencial',secret:false,required:true,hint:'3.1, 3.2 ou 3.3, exatamente como aparece na conta.'}],
    note:'As credenciais ficam criptografadas somente no worker. A conta precisa de aprovação e acesso regional. A API nunca é testada abrindo seu link afiliado. Inclua a identificação de publicidade e a declaração exigida pela Amazon.'
  },
  {
    platform:'shopee',name:'Shopee',automatic:true,
    officialPortal:'https://affiliate.shopee.com.br/open_api',
    documentationUrl:'https://open-api.affiliate.shopee.com.br/explorer/v2',
    steps:[
      'Solicite acesso à Open API no portal oficial de afiliados do Brasil; isso é diferente da conta de vendedor.',
      'No Explorer autenticado, confira generateShortLink, endpoint /graphql e autorização SHA256 com App ID + timestamp + corpo exato + Secret.',
      'Somente se esse contrato for o exibido na sua conta, informe true na confirmação. Salve App ID e Secret no worker e teste uma URL direta de produto.',
      'A conexão é liberada somente após a API aceitar essa requisição. Se o contrato ou a permissão não estiver disponível, gere o link oficial no portal e importe aquele produto na biblioteca.'
    ],
    fields:[{key:'appId',label:'App ID',secret:false,required:true},{key:'secret',label:'Secret',secret:true,required:true},{key:'contractConfirmed',label:'Contrato conferido no Explorer',secret:false,required:true,hint:'Digite true somente após conferir o contrato acima na sua conta.'},{key:'subIds',label:'SubIDs de campanha (opcional)',secret:false,required:false,hint:'Até 5 rótulos separados por vírgula. Não use dados pessoais.'}],
    note:'O schema e a assinatura públicos são candidatos até a conferência no Explorer da conta. Esta instalação não foi validada com uma conta Shopee real. Cada link de API fica vinculado ao produto solicitado; a biblioteca exige aprovação manual por oferta.'
  },
  {
    platform:'mercadolivre',name:'Mercado Livre',automatic:false,
    officialPortal:'https://www.mercadolivre.com.br/l/afiliados-portal-do-afiliado',
    documentationUrl:'https://www.mercadolivre.com.br/l/afiliados-gere-seus-links',
    steps:[
      'Entre na sua conta oficial de Afiliados e Criadores; não informe senha, cookie ou token de vendedor no PromoBridge.',
      'Use Gerador de Links ou Barra de Afiliados para o produto específico.',
      'Importe a URL original e o link completo gerado na sua conta. Confirme que o link é do mesmo produto e que você é a titular.',
      'Reprocesse a oferta e aprove manualmente o envio. Confira no portal se o canal de divulgação está autorizado.'
    ],fields:[],
    note:'Não foi localizada API pública oficial para gerar links afiliados. A biblioteca conserva exatamente seu link por produto e exige revisão em cada oferta. Produtos de catálogo, anúncios MLB e User Products MLBU são identidades distintas. Confira as regras para grupos privados e canais declarados.'
  },
  {
    platform:'magalu',name:'Magalu',automatic:false,
    officialPortal:'https://www.magazinevoce.com.br/',
    documentationUrl:'https://www.magazinevoce.com.br/blog/artigo/como-usar-os-codigos-de-produto',
    steps:[
      'Abra sua loja oficial do Influenciador Magalu.',
      'Pesquise o produto e clique em Gerar link; confira produto, variante e vendedor.',
      'Importe o link original e a URL completa gerada na sua loja. Se preencher um identificador público, use o nome da loja, sem senha.',
      'Reprocesse a oferta e aprove manualmente. O link salvo vale somente para aquele produto.'
    ],fields:[],
    note:'Domínios de loja magazinevoce.com.br e influenciadormagalu.com.br são reconhecidos. O nome público da loja e a declaração da titular não comprovam comissão. Não usamos APIs comerciais de vendedor como se fossem APIs de afiliados.'
  },
  {
    platform:'aliexpress',name:'AliExpress',automatic:true,
    officialPortal:'https://portals.aliexpress.com/',
    documentationUrl:'https://open.alitrip.com/docs/doc.htm?articleId=45804&docType=2&treeId=674',
    steps:[
      'Abra AliExpress Portals para afiliação e confira as permissões da aplicação no Open Service.',
      'Este cliente implementa somente a família TOP legada: método aliexpress.affiliate.link.generate, gateway eco.taobao.com/router/rest, parâmetros ordenados e MD5 com secret antes e depois.',
      'A documentação oficial marca essa família como obsoleta. Digite true na confirmação apenas se o SDK/console oficial da sua aplicação ainda indicar exatamente esse contrato; não use credenciais REST ou /sync.',
      'Salve App Key, App Secret e Tracking ID no worker e teste o produto. A resposta precisa devolver o mesmo produto e Tracking ID. Sem acesso, use o gerador oficial e a biblioteca por produto.'
    ],
    fields:[{key:'appKey',label:'App Key (TOP legado)',secret:false,required:true},{key:'appSecret',label:'App Secret',secret:true,required:true},{key:'trackingId',label:'Tracking ID',secret:false,required:true},{key:'legacyContractConfirmed',label:'Contrato legado conferido',secret:false,required:true,hint:'Digite true somente se o console oficial confirmar esse gateway e a família TOP legada.'}],
    note:'Cliente legado opcional, sujeito à disponibilidade e às permissões reais da sua conta. Não mistura contratos TOP, REST e /sync. Não foi feita chamada com uma conta AliExpress real. Atribuição e comissão dependem das regras do programa.'
  },
  {
    platform:'shein',name:'SHEIN',automatic:false,
    officialPortal:'https://m.shein.com/br/campus--a-1500.html',
    documentationUrl:'https://m.shein.com/br/campus--a-1500.html',
    steps:[
      'No aplicativo SHEIN, pesquise afiliado e entre na nova plataforma. O programa antigo e seus códigos foram encerrados em 2024.',
      'Escolha o produto no Centro de Afiliados e gere ali o link específico do produto. O compartilhamento comum do site não é suficiente.',
      'Importe a URL original e o link completo gerado, confirmando mesmo produto e titularidade.',
      'Reprocesse e aprove manualmente a oferta; não use link de campanha ou cupom no lugar do produto anunciado.'
    ],fields:[],
    note:'Não foi localizada documentação pública de geração de links afiliados brasileiros via API. Links onelink são opacos; sua confirmação é registrada como revisão humana, nunca como prova automática de afiliação.'
  },
  {
    platform:'temu',name:'Temu',automatic:false,
    officialPortal:'https://www.temu.com/br/affiliate_recruit.html',
    documentationUrl:'https://www.temu.com/br/affiliate_question.html',
    steps:[
      'Cadastre e declare seus canais no portal oficial de afiliados da Temu.',
      'Gere no portal um link de produto ou compartilhe o produto pelo aplicativo com rastreamento habilitado.',
      'Importe a URL original e o link completo, confirmando que é o produto específico. Campanhas, convites e cupons não substituem esse link.',
      'Reprocesse e aprove manualmente a oferta. Confira elegibilidade e comissão no portal oficial.'
    ],fields:[],
    note:'Não foi localizada API pública oficial de geração de links afiliados. Credenciais de vendedor não ativam essa função. A biblioteca não promete comissão em toda compra nem transforma códigos de indicação em links universais.'
  }
];

/** Shared with the demo UI; contains only public instructions and official sources. */
export function getIntegrationGuides():IntegrationGuide[] { return structuredClone(guides); }
