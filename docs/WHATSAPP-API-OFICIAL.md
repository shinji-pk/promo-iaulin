# Plano: sair do QR Code e ir para a API oficial do WhatsApp

**Estado em 21/10/2026:** planejado, não implementado. Hoje o envio usa a conexão por QR Code (Baileys, não oficial).
**Lembrete:** a dona do produto pediu para ser lembrada deste plano. Ele também está no roadmap do Emet (`shinji-pk/Emet-Hub`, `docs/ROADMAP.md`).

## Por que mudar
- A conexão por QR Code não é oficial. O WhatsApp pode restringir ou banir o número que envia muito, recebe denúncias ou parece automático.
- A API oficial (WhatsApp Business Platform / Cloud API, da Meta) não depende de celular ligado nem de QR Code, e é o caminho aceito pela Meta para empresas.

## O que já está pronto no código
- **Motor trocável.** Todo o sistema fala com o contrato `MessagingTransport` (`packages/shared/src/messaging.ts`). O motor atual é `WhatsAppService` (`provider: 'whatsapp-qr'`). Um motor oficial só precisa implementar o mesmo contrato (`getStatus`, `connect`, `reset`, `stop`, `refreshGroups`, `sendText`, `sendImage`, `assertCanSend`).
- **Regras independentes do motor.** Fila, aprovação, ritmo de envio, variação aleatória, horário de silêncio, deduplicação e o aviso obrigatório ficam no `packages/core` e valem para qualquer motor.
- **Capacidades declaradas.** `messagingCapabilities` diz o que cada motor consegue (ler grupos-fonte, postar em grupos existentes, cobrança por mensagem). A interface deve usar isso para esconder o que o motor escolhido não suporta.

## Ponto de atenção antes de implementar (conferir de novo na Meta)
Segundo um resumo de terceiros da documentação da Meta (Unipile, conferido em agosto/2026), a **Groups API oficial** tem limites que não servem para grupos de promoção grandes:
- no máximo **8 participantes por grupo**;
- os grupos são criados pela própria empresa, e as pessoas entram por link de convite com aprovação;
- exige conta comercial oficial (Official Business Account) na Cloud API;
- cada mensagem é cobrada.

Ou seja: **a API oficial não substitui, hoje, a postagem em grupos grandes já existentes**, nem a leitura de grupos-fonte de outras pessoas. Caminhos possíveis com a API oficial:
1. **Lista de transmissão por opt-in** (modelos de marketing aprovados, enviados para cada pessoa que aceitou receber). Pago por mensagem, mas oficial.
2. **Grupos pequenos** (até 8) para clientes VIP.
3. Manter o QR Code como opção "por sua conta e risco", com o aviso e o ritmo já implementados.

Antes de começar, conferir a documentação atual da Meta (Cloud API, Groups API, preços por país) e decidir o caminho.

## Passos quando for implementar
1. Criar `apps/worker/src/whatsapp-cloud.ts` com `implements MessagingTransport` (`provider: 'whatsapp-cloud-api'`), usando token e número de telefone do WhatsApp Business guardados no cofre do servidor (nunca no navegador).
2. Webhook para status de entrega (`server_ack`, `delivered`, `read`) mapeado para `WhatsAppDelivery`.
3. Escolha do motor em Configurações (QR Code × API oficial), com explicação de custo e limites.
4. Para empresas no Emet: o motor oficial roda no servidor, não no computador da pessoa, então funciona sem o programa local.
5. Testes de contrato iguais para os dois motores.

## Fontes
- [WhatsApp Group API 2026: Limits, Endpoints & Alternatives (Unipile)](https://www.unipile.com/whatsapp-group-api/)
