# Pesquisa operacional: WhatsApp e execução local

Pesquisa realizada em 18/10/2026, horário de Brasília, com documentação pública dos mantenedores do Baileys, código da versão fixada, npm, Node.js, Vercel e políticas do WhatsApp. Este documento audita a base 2.0.0 anterior às melhorias desta rodada. As observações abaixo são requisitos de implementação e validação; não são uma declaração de que todas as alterações já foram entregues.

## Conclusão

O app tem uma base real de execução local, mas o painel publicado na Vercel é uma demonstração estática. Sessão por QR, participação nos grupos e afiliação dependem das contas do usuário. Nenhuma pesquisa pública ou teste com transporte simulado substitui a conexão e um teste real de ponta a ponta nessas contas.

A prioridade é completar o caminho **receber → identificar → afiliar → revisar/agendar → publicar → conferir o resultado** dentro das telas existentes. Não é necessário redesenhar a interface para isso.

## Versões e segurança verificadas

| Evidência primária | Resultado consultado | Decisão recomendada |
| --- | --- | --- |
| Metadados npm de `@whiskeysockets/baileys` [1] | `latest` = `7.0.0-rc14`; `legacy` = `6.7.24`. As duas versões foram publicadas em 29/07/2026. | Manter `6.7.24` fixada enquanto se completa e verifica o fluxo atual. Não instalar `latest` silenciosamente. |
| Release `v6.7.24` e comparação com `v6.7.23` [2] | A atualização inclui a versão do WhatsApp Web e mudanças de publicação. | Usar a versão de protocolo incluída no pacote; tratar atualização como mudança controlada. |
| Advisory GHSA-qvv5-jq5g-4cgg / CVE-2026-48063 [3] | Spoofing de `messages.upsert`, histórico e corrupção de app state em versões anteriores a `6.7.22` / `7.0.0-rc12`. | A versão fixada já contém o patch. Manter também a defesa de ignorar `requestId` e não importar histórico automaticamente. |
| `npm audit --json`, lockfile atual | Zero vulnerabilidades reportadas; 428 dependências no relatório. | É um retrato do banco de advisories consultado, não prova de ausência de falhas. Atualizações futuras precisam repetir auditoria e testes. |
| Guia de migração v7 [4] | Mudanças de JIDs/LIDs, auth store, ESM e ACKs. | Migração futura precisa de teste de login, reconexão, grupos, mídia e recibos com conta real. |
| Guia v8 [5] | V8 em desenvolvimento e novo formato de autenticação. | Não converter uma sessão em uso com APIs ainda em desenvolvimento. |

Os endereços antigos `/docs/intro/` e `/docs/socket/...` retornaram 404 durante a pesquisa. A wiki atual usa `/introduction`, `/authentication/...`, `/concepts/...` e `/messaging/...`; o índice completo está em [6].

## O que a base já protege

- QR renderizado no painel, sem conteúdo secreto nos logs; geração e reset protegidos contra eventos atrasados.
- Eventos de sockets antigos descartados por geração e referência da conexão.
- Reconexão exponencial limitada, com parada em logout, sessão ruim, conexão substituída e proibição.
- Sessão local fora de Git e do backup operacional; diretório privado e arquivos com permissão restrita quando o sistema permite.
- Apenas grupos escolhidos; destino separado da origem; `fromMe`, broadcast, histórico, citação e mensagens de protocolo ignorados.
- Legendas de imagem, vídeo e documento e vários wrappers normalizados; várias URLs preservadas.
- Fila serial e claim SQLite persistente antes de acessar a rede.
- Envio interrompido recuperado como incerto; sem reenvio automático cego.
- Revalidação de afiliação, produto, destino, texto, deduplicação e limites imediatamente antes do envio.
- API vinculada a `127.0.0.1`, origem local, CSRF, limites e backup sem a sessão WhatsApp.

Esses pontos devem continuar cobertos pelos testes quando as funcionalidades forem ampliadas.

## Lacunas prioritárias e critérios de aceite

### P0 — Recuperar a fila quando terminar um impedimento temporário

Na base auditada, `processPromotion()` chama `evaluatePublication()` com a política automática. Silêncio, intervalo mínimo ou limite por hora fazem uma oferta virar `review`; `drainInternal()` só considera `approved`. Uma oferta válida recebida às 21h não volta sozinha à fila quando o silêncio termina. O mesmo acontece com a segunda oferta recebida durante o intervalo após a primeira publicação.

Separar validade da oferta e decisão de horário. Guardar ofertas elegíveis como aprovadas aguardando janela ou com agendamento persistente; recalcular o momento de envio usando o fuso configurado. Impedimentos de conta, afiliação ou conteúdo devem continuar exigindo correção. A fila precisa mostrar por que aguarda e o próximo horário possível.

**Aceite:** ao avançar um relógio controlado além do intervalo, fim do silêncio e fim da quota horária, a oferta elegível é enviada uma única vez, inclusive após reiniciar o worker. Pausa e modo manual continuam impedindo automação.

### P0 — Expiração e reprocessamento sem perder a identidade

Não há prazo de validade operacional da oferta. Uma oferta aprovada pode ficar dias pendente e ser enviada depois de a promoção acabar. Também não há ação para repetir resolução e afiliação após corrigir a loja; editar apenas a mensagem final não atualiza os campos estruturados.

Adicionar expiração configurável, próxima ação e motivo; nunca afirmar preço/estoque atuais sem confirmação de fonte oficial. Uma ação **Reprocessar** deve reaproveitar o mesmo registro e repetir parser, resolução, identidade, afiliação e pontuação com as configurações atuais. Não reprocessar como se fosse nova uma publicação confirmada ou incerta. Preservar fonte, ID da mensagem, alterações deliberadas e auditoria.

**Aceite:** corrigir afiliação e reprocessar uma oferta retida recupera o fluxo; reprocessar não elimina histórico nem libera duplicata; oferta vencida não é publicada automaticamente.

### P0 — Resultado do envio e resolução de incerteza

`WhatsAppService.sendText()` retorna o ID de mensagem gerado, mas `publishInternal()` o descarta. Estado `published` significa que o transporte retornou um ID, não que todos os integrantes receberam ou leram. `uncertain` bloqueia esse produto indefinidamente, sem ação assistida de conferência.

Persistir `providerMessageId`, destino e horário da tentativa; preparar um ID antes da rede se a API fixada permitir. Separar tentativa, aceitação, confirmação conhecida e conferência manual. Consumir `messages.update` e os eventos de recibo apenas para mensagens próprias conhecidas. Usar enums do protobuf instalado: não copiar números de status de exemplos narrativos da wiki.

Na revisão de uma incerteza, oferecer **Confirmei no grupo: foi enviado** e **Confirmei no grupo: não foi enviado**, com observação obrigatória e trilha de auditoria. A segunda opção pode devolver à revisão, exigindo novo comando explícito e todos os gates. Nunca repetir automaticamente uma tentativa que pode ter sido aceita.

**Aceite:** perda da conexão depois de uma aceitação não duplica mensagem; restart conserva tentativa e ID; confirmação manual encerra o bloqueio com evidência; recibo de outra mensagem/grupo não altera a oferta.

### P0 — Diagnóstico antes do primeiro envio

A lista atual de grupos contém apenas ID, nome e quantidade de participantes. Não informa se o número pode escrever em um grupo de anúncios ou se foi removido. O envio pode falhar antes de alcançar a rede e ser tratado como entrega incerta.

Buscar e guardar metadados suficientes para calcular participação e permissão de escrita, respeitando IDs PN/LID da versão usada. Revalidar o destino antes de reservar o envio; retornar bloqueios locais como falha anterior ao envio, não como resultado desconhecido. Só um erro depois de começar a operação de transporte deve criar uma incerteza. Indicar no painel: sessão, origem, destino disponível, permissão, afiliação e janela.

**Aceite:** destino inexistente, saída do grupo, falta de permissão e texto inválido geram ação corretiva clara sem consumir uma tentativa incerta. A indisponibilidade posterior ao começo do transporte continua protegida contra duplicação.

### P0 — Evitar espera circular entre reset e recebimento

Há duas filas: `WorkerRuntime.run()` serializa operações de negócio; `WhatsAppService.incoming` serializa os callbacks recebidos. `runtime.reset()` entra na primeira fila e aguarda `whatsapp.reset()`, que aguarda `incoming`. Ao avançar entre duas mensagens, a fila recebida pode já ter enfileirado a próxima `runtime.ingest()` depois do reset. Nesse caso, reset aguarda a entrada, a entrada aguarda ingestão e a ingestão aguarda reset. É um risco de espera circular por ordem de microtasks, a verificar com teste determinístico.

Cancelar a aceitação de entrada antes de aguardar a fila de negócio ou separar o lifecycle do transporte das operações de fila. Uma operação que retém a fila de negócio não pode aguardar um callback que precisa entrar nessa mesma fila.

**Aceite:** com um lote de duas mensagens, primeira ingestão mantida pendente, reset simultâneo e nova conexão, todas as promises terminam dentro do prazo; nenhuma mensagem ou credencial da sessão anterior ressuscita depois do reset.

### P1 — Imagem real, miniatura e mensagem com legenda

A base já extrai legenda de mídia, mas sempre devolve `imageUrl: null` e envia apenas `{text}`. Portanto, a existência de `Offer.imageUrl` e do componente de miniatura não entrega captura e envio da fotografia original.

Baileys suporta download e envio de imagens, buffers e streams [7]. Implementar armazenamento local com ID opaco, limite de bytes, prazo, MIME e assinatura verificados e thumbnail. Evitar URL de origem arbitrária para acessar rede interna. Servir apenas arquivos conhecidos por uma rota local; nunca aceitar caminho livre do navegador. A legenda reescrita deve acompanhar a imagem no destino; preview precisa corresponder ao conteúdo realmente enviado.

Usar stream limitado no download, prazo de conexão/leitura e `reuploadRequest` quando aplicável. Para thumbnail, a documentação recomenda `sharp` ou `jimp`; a dependência escolhida deve estar no artefato final e no teste Windows. Não tentar preservar uma fotografia para todos os produtos de um post com vários itens sem associação clara. Mídia de visualização única deve continuar sem republicação automática; oferecer o texto para revisão quando pertinente.

Se o download falhar, registrar que a imagem não foi capturada e permitir decidir pelo envio apenas do texto. Não informar que a imagem foi enviada se houve fallback.

**Aceite:** imagem comum com legenda atravessa captura → preview → envio; imagem grande é interrompida no limite; arquivo expirado tem recuperação ou fallback explícito; limpar histórico remove mídia não referenciada; backup não promete conter um arquivo que não exportou.

### P1 — Persistência de autenticação robusta

O guia atual dos mantenedores diz explicitamente que `useMultiFileAuthState` não é recomendado para produção e orienta implementar `AuthenticationState` sobre SQL/NoSQL [8]. A fila de writes e as permissões já implementadas reduzem riscos, mas não tornam múltiplos arquivos uma transação atômica. A leitura e escrita de Signal keys precisam completar antes de a biblioteca prosseguir.

Usar SQLite separado para credenciais e key store, com `BufferJSON`, commits atômicos e `makeCacheableSignalKeyStore`; manter fora do backup operacional e do Git. Migração da pasta antiga deve acontecer somente se os dados puderem ser lidos e gravados completamente; preservar original até sucesso e exigir novo QR se o estado estiver inválido. Guardar tipos de chaves desconhecidos de forma genérica para facilitar evolução PN/LID.

**Aceite:** reiniciar preserva login; queda durante gravação não corrompe metade da sessão; reset cancela writes e remove a sessão; erro de disco pausa o transporte com indicação clara; exportar dados nunca exporta credenciais silenciosamente.

### P1 — Grupos e reconexão atualizados

A documentação recomenda `cachedGroupMetadata`, invalidado por `groups.update` e `group-participants.update` [9]. Atualmente os grupos são buscados na abertura e por ação manual; uma remoção, mudança de nome ou de permissões pode ficar invisível até a próxima consulta.

Adicionar cache com TTL e invalidação por eventos, guardando apenas os dados necessários. Pré-checagem de escrita deve usar metadados atuais. Tratar `restartRequired` depois de escanear QR como transição esperada [10]; evitar consumir o orçamento de falhas normais nessa troca. Exibir estágio, próxima tentativa e botão de retomar após o limite.

**Aceite:** mudança no nome e no tipo de grupo se reflete sem novo login; sessões substituídas não reconectam em loop; reconexão não deixa dois sockets ativos; reset enquanto carrega QR não ressuscita uma sessão antiga.

### P1 — Recebimento confiável com limites explícitos

Descartar `append`, mensagens com `requestId` e o histórico é deliberado e possui respaldo no advisory. O filtro adicional `notBefore` descarta qualquer notificação cujo timestamp seja anterior ao momento de abertura menos cinco segundos. Isso também descarta promoções legítimas recebidas enquanto o computador estava offline.

Manter a política de não publicar backlog automaticamente. Informar na tela desde quando a captura está ativa, última mensagem processada e que o app precisa ficar em execução. Se houver recuperação futura, importar mensagens apenas por fluxo deliberado, com horizonte curto, origem autorizada, dedupe persistente e estado de revisão; não remover as defesas contra eventos forjados.

Recepção precisa de fila limitada ou persistente: a cadeia de promises atual pode crescer sem limite e todo o processamento/resolução de um post bloqueia os seguintes. Marcar uma mensagem como concluída no dedupe só depois de persistir o resultado; uma falha de ingestão não deve sumir silenciosamente. Manter orçamento de resolução por mensagem e limite de links.

**Aceite:** rajada mantém o painel responsivo e o consumo limitado; cada erro vira evento acionável sem conteúdo secreto; restart não duplica entrada nem perde item persistido; mensagens antigas ficam em revisão, se recuperadas.

### P1 — Saúde, alertas e volume do banco

O snapshot retorna no máximo mil ofertas, mas ingestão, dedupe e publicação frequentemente carregam todo o histórico e os feedbacks. Com semanas de uso, o custo e a latência crescem. Os índices atuais são uma boa base, mas precisam ser usados por consultas orientadas a janela/status em vez de parse de todos os JSONs.

Acrescentar consultas SQL por produto, fonte/mensagem, status, período e totais; paginação de histórico; última captura, último envio, heartbeat, disco e tamanho de mídia; estado da fila com próximo envio e motivo. Contadores de erros recorrentes precisam de alertas deduplicados no próprio painel, com botão que leva à correção. Notificações de desktop podem ser opcionais; não enviar mensagens externas sem configuração explícita do usuário.

**Aceite:** histórico com dezenas de milhares de registros não paralisa ingestão; erro de afiliação, queda de sessão e disco cheio são visíveis; um alerta não se repete a cada poll; backup e retenção não apagam evidência de envio incerto.

## Instalação sem pedir que o usuário programe

O instalador existente exige Node 24 manualmente e executa `npm ci` e build. O script de abrir espera quatro segundos fixos; se o worker demorar ou a porta estiver ocupada, o navegador abre sem diagnóstico. `npm start` depende de `tsx`, atualmente `devDependency`; uma instalação só de dependências de produção não inicia o app.

### Caminho de menor atrito

1. Gerar um pacote Windows x64 e, quando necessário, ARM64 com **Node 24 portátil**, painel já compilado e worker pronto para iniciar. Publicar com SHA-256 do arquivo e origem clara.
2. Compilar o worker para JavaScript ou incluir `tsx` como dependência de runtime. Não executar build ou baixar compiladores no computador do usuário a cada abertura.
3. Manter `data/` em diretório de usuário persistente, separado do programa. Atualização nunca deve substituir sessão, banco ou backup.
4. Incluir **ABRIR PROMOBRIDGE**: iniciar se necessário, verificar `/health` com timeout e só então abrir o navegador. Se já estiver aberto, reusar a instância; se a porta pertencer a outro processo, explicar sem encerrá-lo.
5. Incluir **DIAGNOSTICAR** com relatório sem tokens, QR, números completos, textos privados ou credenciais; permitir copiar pelo painel.
6. Início automático no login como preferência clara e reversível; mostrar que fechar o navegador não encerra o worker e como encerrar pelo aplicativo.
7. Atualização por pacote verificado, com backup e parada controlada. Não usar atualizador que executa um script remoto sem verificar artefato.

Node publica os hashes oficiais para as distribuições Windows [11]. Um instalador pode usá-los no build do artefato. Testar o pacote em Windows limpo, sem Node, npm, Git, Python ou VS Build Tools instalados; esse é o teste que distingue um pacote pronto de instruções de desenvolvimento.

## Hospedagem e operação real

O WebSocket do Baileys requer processo vivo e estado durável. A documentação atual da Vercel **já oferece WebSockets nativos em beta**, inclusive com Express e `ws` [12]; a afirmação antiga de ausência de suporte deixou de ser correta. Isso não transforma o worker atual em um serviço contínuo: uma conexão encerra na duração máxima da Function (Hobby: 300 segundos; Pro/Enterprise: 800 segundos, ou 1.800 na extensão beta), novas conexões podem chegar a outra instância e estado durável deve ficar fora do processo. Manter o frontend estático lá é adequado. Colocar a sessão WhatsApp e SQLite local dentro de uma Function, sem coordenação e retomada, não completa a operação.

Para o app pessoal atual, a menor mudança é um pacote local completo e onboarding guiado: abrir → conectar WhatsApp → escolher grupos → habilitar lojas → testar uma oferta → ativar automação. Para operar com o computador desligado, é necessário provisionar worker persistente com disco e política de reinício, autenticação do painel e canal seguro. A conexão GitHub/Vercel não provisiona esses recursos sozinha.

Baileys é um cliente comunitário e não é uma integração oficial Meta [13]. As políticas do WhatsApp abrangem grupos e podem restringir uso indevido de automação e spam [14]. O produto deve descrever o transporte como é, preservar limites e escolha explícita de grupos e não prometer risco zero de desconexão ou bloqueio. Migrar para uma API oficial exige confirmar se ela atende os grupos comuns já usados; não assumir equivalência sem essa checagem.

## Validação final necessária

É possível automatizar parser, política, banco, falhas de rede, replay, scheduler e interface. Ainda será necessário usar uma sessão autorizada e os grupos reais do usuário para verificar: QR → grupos → recebimento novo → afiliação aprovada → texto e imagem → envio ao destino → ID persistido → reconexão → confirmação no telefone.

Evidência de afiliação estrutural não comprova que a loja atribuiu comissão à conta. A validação final depende da conta e dos relatórios oficiais de cada programa. Enquanto isso, o painel deve distinguir **configurado**, **validado estruturalmente**, **testado no WhatsApp** e **atribuição confirmada**, sem declarar tudo pronto com base somente em testes simulados.

## Fontes primárias

1. [npm — metadados publicados de Baileys](https://registry.npmjs.org/@whiskeysockets/baileys).
2. [Release 6.7.24](https://github.com/WhiskeySockets/Baileys/releases/tag/v6.7.24) e [alterações desde 6.7.23](https://github.com/WhiskeySockets/Baileys/compare/v6.7.23...v6.7.24).
3. [Advisory oficial GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg).
4. [Baileys — migração v7](https://baileys.wiki/migration/v7).
5. [Baileys — plano de migração v8](https://baileys.wiki/migration/v8).
6. [Índice completo da documentação Baileys](https://baileys.wiki/llms.txt).
7. [Baileys — mensagens de mídia](https://baileys.wiki/messaging/media-messages) e [README da versão usada](https://github.com/WhiskeySockets/Baileys/blob/v6.7.24/README.md#downloading-media-messages).
8. [Baileys — persistência da sessão e auth state](https://baileys.wiki/authentication/session-management).
9. [Baileys — grupos e cache de metadados](https://baileys.wiki/features/groups).
10. [Baileys — QR e restartRequired](https://baileys.wiki/authentication/qr-code).
11. [Node.js — hashes oficiais do canal 24.x](https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt).
12. [Vercel — limites de Functions](https://vercel.com/docs/functions/limitations), [WebSockets nativos](https://vercel.com/docs/functions/websockets) e [guia de suporte atualizado em 01/10/2026](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections).
13. [Baileys — introdução e declaração de independência](https://baileys.wiki/introduction).
14. [WhatsApp — diretrizes de mensagens](https://www.whatsapp.com/legal/messaging-guidelines) e [termos de serviço](https://www.whatsapp.com/legal/terms-of-service).
15. [Baileys — eventos e recibos](https://baileys.wiki/concepts/events), [configuração do socket](https://baileys.wiki/concepts/socket-config), [data store / getMessage](https://baileys.wiki/concepts/data-store) e [sincronização do histórico](https://baileys.wiki/advanced/history-sync).
