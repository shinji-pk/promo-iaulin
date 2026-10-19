# Contratos da evolução 2.1

Preservar estética e navegação. Todos os dados cotidianos no painel, segredos apenas na instalação local, nunca em demonstração/localStorage/backup. Raiz coordena shared, db, core, api.ts e arquivos globais. Imports relativos .ts; novos tipos em packages/shared/src/features.ts.

## Persistência genérica (raiz implementa)

Database recebe migration v2 e métodos `putRecord(namespace:string,id:string,value:unknown):void`, `getRecord<T>(namespace,id):T|undefined`, `listRecords<T>(namespace):T[]`, `deleteRecord(namespace,id):void`, `clearRecords(namespace):void`. Namespaces para recibos e biblioteca de links. Não guardar segredos nesses registros; vault separado.

Offer ganha opcionais affiliateReceiptId, affiliateMethod, requiresManualApproval, manuallyApprovedAt, scheduledAt, expiresAt, providerMessageId, mediaId. SQLite schema offerSchema será atualizado pela raiz. Novos registros não entram no backup V1; biblioteca pode exportar separadamente sem recibos. Restore limpa recibos para impedir confiança em JSON restaurado.

## Serviço de afiliados

Novo apps/worker/src/affiliates.ts exporta AffiliateService({database:Database,vault:SecretVault,getSettings:()=>Settings,resolveUrl?:(url)=>Promise<string>,providers?:...}) implementando AffiliatePort (features.ts): convert(Product) -> AffiliateConversion; validate(receiptId,Product,url) -> Validation. Método `validateOffer(offer,settings)` é opcional wrapper. API oficial gera link e recibo local, não abre o novo link afiliado para simular clique. Validar source product + resposta API autenticada e produto da URL quando legível; links curtos só de domínios permitidos por loja, nunca landing/campanha.

Biblioteca: listLinks(platform?), importLink({platform,originalUrl,affiliateUrl,title?,ownerConfirmed:true}) -> ApprovedLink; removeLink(id). Cada par é exato, não generalizar regras. Links opacos exigem confirmação humana de mesmo produto e titularidade, nunca autoEligible; core exige aprovação explícita para owner-reviewed. Link direto, se identificável, precisa ter mesmo productKey. Resolver pode abrir original para identificar produto; não seguir automaticamente link afiliado de saída. Erros legíveis sem credenciais.

Credentials métodos da API de AffiliateService: credentialStatuses():CredentialStatus[]; saveCredentials(platform,values:Record<string,string>); removeCredentials(platform); testConnection(platform,{originalUrl?}) -> {valid,reason}. `getIntegrationGuides()` retorna IntegrationGuide[] com fontes oficiais/etapas. Credenciais de API não são senha de marketplace. Dados retornados apenas metadados, jamais valores.

Vault em apps/worker/src/secret-vault.ts: SecretVault({directory?:string}) com get(platform),set(platform,values),remove(platform),status(platform) retornando CredentialStatus. Criptografia AES-GCM, chave local protegida/fora git/backup. Construtor permite memória/temp para testes. Só endpoints POST locais com CSRF. Cliente de API fixado em domínios oficiais, timeout/limite de resposta, sem redirects de credenciais. Não solicitar segredos em chat.

Core: processPromotion context adiciona affiliatePort?:AffiliatePort. Worker fornece serviço; simulation nunca usa APIs reais, só tag Amazon estrutural. evaluatePublication options adiciona affiliatePort?:AffiliatePort, ignoreTemporary?:boolean. validate receipt para APIs/manuais; fallback Amazon existente. Manual receipt exige manuallyApprovedAt e `automatic:false`; auto nunca usa mera declaração de dono. `ignoreTemporary` ignora pausa/horários/limites, não identidade/score/afiliação. Permite deixar approved aguardando janela e drenar depois. Produto direto reconhecido pode ser canonicalizado sem visitar link afiliado.

## API adicionada pela raiz

GET /setup ->SetupStatus. GET /affiliates/guides ->IntegrationGuide[]. GET /affiliates/credentials ->CredentialStatus[]. POST /affiliates/:platform/credentials {values}; DELETE /affiliates/:platform/credentials. POST /affiliates/:platform/test {originalUrl?}. GET /affiliate-links?platform ->ApprovedLink[]. POST /affiliate-links {platform,originalUrl,affiliateUrl,title?,ownerConfirmed:true}. DELETE /affiliate-links/:id. GET /affiliate-links/export -> JSON de pares sem recibos/segredos.

POST /ingest {text} entrada real manual (sourceId='manual'), sempre revisão e requiresManualApproval. POST /offers/:id/reprocess {} ->Offer. POST /offers/:id/details {title?,price?,previousPrice?,coupon?,category?,expiresAt?} correção estruturada/feedback; refaz score e renderer, bloqueia de novo se afiliação não validar. POST /offers/:id/schedule {scheduledAt} exige approved; não fura gates, respeita validade. POST /offers/:id/reconcile {outcome:'published'|'not_sent',confirmed:true} somente uncertain; published registra manualmente, not_sent volta review sem enviar e exige nova aprovação.

GET /offers/history?... filtragem paginada se necessário; GET /media/:id conteúdo local limitado (sem URLs externas); UI recebe imageUrl nessa rota somente se disponível.

## WhatsApp / operações

Agente de operação pode editar whatsapp.ts + tests/whatsapp.test.ts e novos módulos isolados, sem api.ts/core/db/index.ts. Persistir última mensagem e grupo permissions conforme possível, cache grupos via eventos, timeout envio, delivery id. Mídia: thumbnail JPEG pequeno no IngestInput opcional imageThumbnailBase64/mime, raiz persiste em data/media com limite e oferece rota; nunca baixar URL arbitrária. sendImage opcional no transporte com Buffer local, caption segura; falha do envio não deve reenviar como texto automaticamente. Manter requestId/histórico/spoofing guard. Não migrar Baileys legacy para RC sem evidência.

## UI

Usar componentes/classes atuais. Novas funções em FeaturePanels.tsx para modal 'Conectar conta', biblioteca por produto, edição estruturada/reprocessamento/agendamento/conferência. Sem redesenhar hero/cards/sidebar/paleta. Extras em details/Avançado/contextuais. Navegação existente. Hospedagem usa conta online persistente; com o computador desconectado, preferências e simulações ficam na conta e envios reais aguardam pareamento. A demonstração estática é exclusiva do desenvolvimento; jamais guardar chaves nela. Campos de credenciais desabilitados com explicação no remoto. A evolução fica completa para configuração local, não afirmar conta conectada sem validação real.
