import type { Message } from '../generated/prisma/client';

/**
 * Événements du bus *interne au process* (@nestjs/event-emitter).
 *
 * Seul consommateur : MessagingGateway, qui les relaie en WebSocket vers la room
 * de la conversation. À ne pas confondre avec les événements NATS
 * (src/nats/nats.events.ts), destinés aux autres micro-services.
 *
 * Ici le payload peut contenir l'entité complète (contenu du message inclus) :
 * on reste dans le process et la diffusion cible les participants de la room.
 */

export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_READ = 'message.read';
export const MESSAGE_EDITED = 'message.edited';
export const MESSAGE_DELETED = 'message.deleted';
export const CONVERSATION_READ = 'conversation.read';

export interface MessageCreatedEvent {
  conversationId: string;
  /** Les deux participants de la conversation (`[userAId, userBId]`). */
  participantIds: string[];
  message: Message;
}

export interface MessageReadEvent {
  conversationId: string;
  /** Les deux participants de la conversation (`[userAId, userBId]`). */
  participantIds: string[];
  messageId: string;
  readAt: Date;
  readBy: string;
}

/** Émis après l'édition du contenu d'un message. Contenu en clair. */
export interface MessageEditedEvent {
  conversationId: string;
  participantIds: string[];
  message: Message;
}

/** Émis après le soft-delete d'un message. */
export interface MessageDeletedEvent {
  conversationId: string;
  participantIds: string[];
  messageId: string;
  deletedBy: string;
}

/**
 * Émis quand un participant marque d'un coup toute une conversation comme lue
 * (à l'ouverture du fil). Évite un `message.read` par message.
 */
export interface ConversationReadEvent {
  conversationId: string;
  /** Les deux participants de la conversation (`[userAId, userBId]`). */
  participantIds: string[];
  readBy: string;
  readAt: Date;
  /** Nombre de messages effectivement passés à l'état lu. */
  count: number;
}
