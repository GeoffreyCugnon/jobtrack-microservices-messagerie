/**
 * Fixtures partagées par les specs (unitaires et e2e).
 *
 * Uniquement des *données* : aucun mock de framework ici. Chaque factory accepte
 * un `overrides` partiel pour ajuster le cas de test sans reconstruire l'objet.
 */
import type { Conversation, Message } from '../generated/prisma/client';

/** Identifiants d'utilisateurs de test, au format UUID (comme les `sub` réels). */
export const TEST_USERS = {
  alice: '11111111-1111-1111-1111-111111111111',
  bob: '22222222-2222-2222-2222-222222222222',
  carol: '33333333-3333-3333-3333-333333333333',
} as const;

export const TEST_CONVERSATION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const TEST_MESSAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Date fixe pour des assertions déterministes. */
export const FIXED_NOW = new Date('2026-09-08T10:00:00.000Z');

/**
 * Ligne `Conversation` telle que Prisma la renverrait. Par défaut : paire
 * (alice, bob) déjà normalisée (`userAId < userBId`).
 */
export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: TEST_CONVERSATION_ID,
    userAId: TEST_USERS.alice,
    userBId: TEST_USERS.bob,
    lastMessageAt: null,
    createdAt: FIXED_NOW,
    metadata: null,
    ...overrides,
  };
}

/** Ligne `Message` telle que Prisma la renverrait. Par défaut : alice -> conversation, non lu. */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: TEST_MESSAGE_ID,
    conversationId: TEST_CONVERSATION_ID,
    senderId: TEST_USERS.alice,
    content: 'hello',
    readAt: null,
    createdAt: FIXED_NOW,
    metadata: null,
    ...overrides,
  };
}
