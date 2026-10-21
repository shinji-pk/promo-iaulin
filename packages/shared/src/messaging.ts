import type { WhatsAppGroup, WhatsAppStatus } from './index.ts';

/**
 * Contrato do "motor" de envio. Todo o resto do sistema (fila, regras, ritmo,
 * aviso de risco) fala só com esta interface, nunca com a biblioteca do WhatsApp.
 *
 * - `whatsapp-qr`: conexão por QR Code (Baileys, não oficial). Usada hoje.
 * - `whatsapp-cloud-api`: API oficial da Meta. Planejada; ver docs/WHATSAPP-API-OFICIAL.md.
 *
 * Para trocar de motor, basta criar outra classe que implemente este contrato
 * e escolhê-la ao montar o worker. As regras de publicação não mudam.
 */
export type MessagingProviderId = 'whatsapp-qr' | 'whatsapp-cloud-api';

export interface MessagingCapabilities {
  /** Conecta lendo QR Code no celular (sem conta comercial). */
  qrPairing: boolean;
  /** Pode ler mensagens de grupos-fonte (curadoria de ofertas de outros grupos). */
  readsSourceGroups: boolean;
  /** Pode publicar em grupos grandes já existentes. */
  postsToExistingGroups: boolean;
  /** Cada mensagem é cobrada pelo provedor. */
  paidPerMessage: boolean;
}

export const messagingCapabilities: Record<MessagingProviderId, MessagingCapabilities> = {
  'whatsapp-qr': { qrPairing: true, readsSourceGroups: true, postsToExistingGroups: true, paidPerMessage: false },
  // Conferir de novo na Meta antes de implementar: em 2026 a Groups API oficial
  // limitava grupos a 8 participantes, criados pela própria empresa.
  'whatsapp-cloud-api': { qrPairing: false, readsSourceGroups: false, postsToExistingGroups: false, paidPerMessage: true },
};

export interface MessagingTransport {
  readonly provider?: MessagingProviderId;
  getStatus(): WhatsAppStatus;
  connect(): Promise<void>;
  reset(): Promise<void>;
  stop(): Promise<void>;
  refreshGroups(): Promise<WhatsAppGroup[]>;
  /** Devolve o id da mensagem no provedor. */
  sendText(groupId: string, text: string): Promise<string>;
  sendImage?(groupId: string, image: Buffer, caption: string): Promise<string>;
  /** Checagem local antes de reservar o envio (não transmite nada). */
  assertCanSend?(groupId: string, text: string): Promise<void>;
}
