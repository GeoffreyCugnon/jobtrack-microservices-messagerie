/**
 * Contrat d'intégration ouvert publié sur NATS (pub/sub uniquement).
 *
 * N'importe quel micro-service peut s'abonner à ces sujets pour réagir, sans
 * dépendance directe à ce service et sans jamais interroger sa base. Les payloads
 * excluent volontairement le contenu des messages et toute donnée sensible.
 *
 * Livraison : **at-least-once**. Chaque événement est écrit dans la table
 * `OutboxEvent` au sein de la transaction de l'écriture métier, puis publié par
 * `OutboxService` avec retry à backoff (cf. src/nats/outbox.service.ts). Les
 * consommateurs doivent donc être idempotents (dédup sur `messageId` /
 * `conversationId`).
 *
 * Les dates sont sérialisées en ISO 8601 (chaîne).
 */

export const NATS_SUBJECTS = {
  conversationCreated: 'messaging.conversation.created',
  messageCreated: 'messaging.message.created',
  messageRead: 'messaging.message.read',
  conversationRead: 'messaging.conversation.read',
} as const;

/** `messaging.conversation.created` — émis à la création réelle d'une conversation. */
export interface ConversationCreatedEvent {
  conversationId: string;
  userAId: string;
  userBId: string;
  createdAt: string;
}

/** `messaging.message.created` — émis après l'envoi d'un message. Sans `content`. */
export interface MessageCreatedIntegrationEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  createdAt: string;
}

/** `messaging.message.read` — émis au passage effectif d'un message à l'état lu. */
export interface MessageReadIntegrationEvent {
  messageId: string;
  conversationId: string;
  readAt: string;
}

/**
 * `messaging.conversation.read` — émis quand un participant marque d'un coup
 * tous les messages reçus non lus d'une conversation (ouverture du fil). Couvre
 * le cas que `messaging.message.read` (unitaire) manquait sur les lectures en
 * masse. Pas de `messageId` : c'est un accusé de lecture agrégé.
 */
export interface ConversationReadIntegrationEvent {
  conversationId: string;
  readBy: string;
  readAt: string;
  count: number;
}
