/**
 * Contrat d'intégration ouvert publié sur NATS (pub/sub uniquement).
 *
 * N'importe quel micro-service peut s'abonner à ces sujets pour réagir, sans
 * dépendance directe à ce service et sans jamais interroger sa base. Les payloads
 * excluent volontairement le contenu des messages et toute donnée sensible.
 *
 * TODO : la livraison est best-effort (fire-and-forget). Une sémantique
 * at-least-once (outbox transactionnel, retries, clés d'idempotence) est hors
 * périmètre de ce squelette et à ajouter plus tard si un consommateur l'exige.
 */

export const NATS_SUBJECTS = {
  conversationCreated: 'messaging.conversation.created',
  messageCreated: 'messaging.message.created',
  messageRead: 'messaging.message.read',
} as const;

/** `messaging.conversation.created` — émis à la création réelle d'une conversation. */
export interface ConversationCreatedEvent {
  conversationId: string;
  userAId: string;
  userBId: string;
  createdAt: Date;
}

/** `messaging.message.created` — émis après l'envoi d'un message. Sans `content`. */
export interface MessageCreatedIntegrationEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  createdAt: Date;
}

/** `messaging.message.read` — émis au passage effectif d'un message à l'état lu. */
export interface MessageReadIntegrationEvent {
  messageId: string;
  conversationId: string;
  readAt: Date;
}
