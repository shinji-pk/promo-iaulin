# promo-iaulin — PromoBridge V1

> **Estado do repositório:** este checkout contém somente documentação e `package.json`. As pastas `src/`, `panel/`, `config/`, `scripts/` e `tests/` não foram enviadas ao GitHub. Por isso, `npm start`, `npm run check` e `npm test` falham por arquivos ausentes. É necessário recuperar o pacote original completo antes de instalar, iniciar ou publicar o painel. As funcionalidades abaixo descrevem o projeto esperado; não estão verificadas neste repositório incompleto.

Bot local para **captar mensagens de promoção em grupos do WhatsApp**, identificar links de lojas suportadas, remover rastreamento/afiliação anterior, aplicar a sua configuração de afiliado, reescrever a mensagem e encaminhar a oferta para o grupo de destino.

> **Importante:** a conexão com WhatsApp nesta V1 usa Baileys (integração não oficial via WhatsApp Web). Não é a API oficial da Meta. Existe risco de restrição da conta; use preferencialmente um número separado, sem spam e apenas nos grupos necessários.

## Funcionalidades descritas para a V1 completa

- Conecta por QR Code como dispositivo vinculado.
- Lista seus grupos automaticamente.
- Permite escolher **vários grupos de origem** pelo painel.
- Permite trocar o **grupo de destino** sem editar código.
- Permite desconectar e vincular **outro número** sem editar código.
- Detecta links de Amazon, Shopee, Mercado Livre, Magalu, AliExpress, SHEIN e Temu.
- Resolve links encurtados/redirecionados quando possível.
- Canonicaliza o produto e remove parâmetros comuns de rastreamento.
- Gera link afiliado quando a plataforma está corretamente configurada/calibrada.
- **Nunca publica no chute:** se a afiliação não for confiável, segura a oferta na fila.
- Reescreve promoção sem IA paga, em estilos Chamativo, Compacto ou Limpo.
- Fila de aprovação manual ou modo automático.
- SQLite local para histórico e anti-repetição.
- Limpeza automática do banco.
- Alertas de erro para seu número, se configurado.
- Painel em `http://localhost:3030`.

## Como instalar no Windows

1. Recupere os arquivos ausentes do pacote original completo. Os atalhos dos próximos passos ainda não existem neste checkout.
2. Instale **Node.js 22 ou superior**.
3. Extraia esta pasta.
4. Dê dois cliques em `scripts/01-INSTALAR.bat`.
5. Depois dê dois cliques em `scripts/02-INICIAR-BOT.bat`.
6. O painel abrirá no navegador.
7. Escaneie o QR Code do WhatsApp.
8. Escolha grupos, configure afiliados e salve.
9. Comece em **Modo Manual** até validar todos os links.

## Dados privados

A sessão do WhatsApp, banco SQLite e configurações reais são criados dentro de `data/`. Essa pasta está protegida pelo `.gitignore`, então **não deve ser enviada ao GitHub**.

Nunca coloque no repositório:

- senha;
- código SMS;
- QR Code/sessão do WhatsApp;
- cookies de login;
- token secreto;
- chaves privadas de APIs.

## Afiliados

### Amazon

Informe sua **tag de afiliado** no painel. O módulo gera a URL canônica do produto com a sua tag.

### Shopee, Mercado Livre, Magalu, AliExpress, SHEIN e Temu

A V1 possui uma etapa de **calibração**: informe um link original e um link afiliado seu do **mesmo produto**. O bot resolve os dois, confirma se apontam para o mesmo item e tenta identificar apenas parâmetros de afiliação reutilizáveis.

Se uma plataforma usar link opaco, assinatura temporária, cookie ou API privada, a V1 marca a loja como **integração específica necessária** e não publica aquela oferta. Isso é proposital para não trocar um link válido por um link que não gera comissão.

## GitHub

Recomendação:

- Repositório existente: `shinji-pk/promo-iaulin` (nome do produto: PromoBridge).
- Visibilidade: **Private**
- Descrição: `Bot local para identificar promoções, converter links de afiliados e publicar ofertas automaticamente no WhatsApp.`

Suba o projeto inteiro, **exceto o que já estiver bloqueado pelo `.gitignore`**.

## Vercel

O GitHub informa a URL `https://promo-iaulin-mkce.vercel.app`. Sua disponibilidade e o vínculo com o commit atual ainda não foram verificados; as requisições externas foram bloqueadas pela política de rede deste ambiente.

Após recuperar a pasta `panel/`, o projeto pode ter o **painel estático** publicado no Vercel escolhendo essa pasta como Root Directory. No checkout atual não existe uma página para publicar. O **motor do WhatsApp não deve rodar em Vercel Functions**, pois ele precisa manter uma conexão WebSocket contínua. O painel hospedado serve como interface/preview; para operar a V1, use o painel local aberto pelo próprio bot.

Para operação 24h sem deixar seu computador ligado, a evolução correta é mover o motor para um VPS/servidor persistente — não para uma função serverless comum.

## Estrutura pensada para atualizações por pasta

- `src/affiliate/` — módulos/conversão de lojas.
- `src/` — motor do bot.
- `panel/` — painel visual.
- `config/` — configuração padrão.
- `scripts/` — instaladores/atalhos Windows.
- `data/` — dados locais privados (não sobe para Git).

Nas próximas versões, alterações serão entregues como **pastas/arquivos prontos para substituir**, sem exigir que você programe manualmente.
