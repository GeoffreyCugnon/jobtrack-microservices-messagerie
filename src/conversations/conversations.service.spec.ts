import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  FIXED_NOW,
  TEST_CONVERSATION_ID,
  TEST_USERS,
  makeConversation,
} from '../common/test-fixtures';
import { Prisma } from '../generated/prisma/client';
import { NatsPublisherService } from '../nats/nats-publisher.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';

/**
 * Tests unitaires du service : Prisma et NatsPublisherService entièrement mockés.
 * On vérifie la normalisation de paire, la gestion de la race condition P2002,
 * le décompte des non-lus et le contrôle d'accès participant.
 */
describe('ConversationsService', () => {
  let prisma: {
    conversation: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
    };
    message: { groupBy: jest.Mock };
  };
  let nats: { publish: jest.Mock };
  let service: ConversationsService;

  beforeEach(() => {
    prisma = {
      conversation: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
      },
      message: { groupBy: jest.fn() },
    };
    nats = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new ConversationsService(
      prisma as unknown as PrismaService,
      nats as unknown as NatsPublisherService,
    );
  });

  describe('findOrCreate', () => {
    it('rejects opening a conversation with yourself', async () => {
      await expect(service.findOrCreate(TEST_USERS.alice, TEST_USERS.alice)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    });

    it('creates a new conversation, normalising the pair and publishing the NATS event', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);
      const created = makeConversation();
      prisma.conversation.create.mockResolvedValue(created);

      // bob > alice : l'appel passe (bob, alice) mais la paire doit être normalisée.
      const result = await service.findOrCreate(TEST_USERS.bob, TEST_USERS.alice);

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: { userAId: TEST_USERS.alice, userBId: TEST_USERS.bob },
      });
      expect(nats.publish).toHaveBeenCalledWith(
        'messaging.conversation.created',
        expect.objectContaining({
          conversationId: created.id,
          userAId: TEST_USERS.alice,
          userBId: TEST_USERS.bob,
          createdAt: FIXED_NOW,
        }),
      );
      expect(result).toBe(created);
    });

    it('returns the existing conversation without creating or publishing', async () => {
      const existing = makeConversation();
      prisma.conversation.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreate(TEST_USERS.alice, TEST_USERS.bob);

      expect(result).toBe(existing);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(nats.publish).not.toHaveBeenCalled();
    });

    it('handles the P2002 race condition by returning the concurrently-created row', async () => {
      const concurrent = makeConversation();
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.conversation.findUniqueOrThrow.mockResolvedValue(concurrent);

      const result = await service.findOrCreate(TEST_USERS.alice, TEST_USERS.bob);

      expect(result).toBe(concurrent);
      // Pas d'événement d'intégration : ce n'est pas nous qui avons créé la ligne.
      expect(nats.publish).not.toHaveBeenCalled();
    });

    it('rethrows a non-P2002 Prisma error', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2010', clientVersion: 'test' }),
      );

      await expect(service.findOrCreate(TEST_USERS.alice, TEST_USERS.bob)).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    });
  });

  describe('listForUser', () => {
    it('returns an empty array (and skips the groupBy) when the user has no conversations', async () => {
      prisma.conversation.findMany.mockResolvedValue([]);

      expect(await service.listForUser(TEST_USERS.alice)).toEqual([]);
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });

    it('attaches unreadCount per conversation, defaulting to 0', async () => {
      const c1 = makeConversation({ id: 'conv-1' });
      const c2 = makeConversation({
        id: 'conv-2',
        userAId: TEST_USERS.alice,
        userBId: TEST_USERS.carol,
      });
      prisma.conversation.findMany.mockResolvedValue([c1, c2]);
      prisma.message.groupBy.mockResolvedValue([{ conversationId: 'conv-1', _count: { _all: 4 } }]);

      const result = await service.listForUser(TEST_USERS.alice);

      expect(result).toEqual([
        { ...c1, unreadCount: 4 },
        { ...c2, unreadCount: 0 },
      ]);
      expect(prisma.message.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['conversationId'],
          where: {
            conversationId: { in: ['conv-1', 'conv-2'] },
            senderId: { not: TEST_USERS.alice },
            readAt: null,
          },
        }),
      );
    });
  });

  describe('getParticipantConversation', () => {
    it('throws NotFoundException when the conversation does not exist', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.getParticipantConversation(TEST_CONVERSATION_ID, TEST_USERS.alice),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when the caller is not a participant', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());

      await expect(
        service.getParticipantConversation(TEST_CONVERSATION_ID, TEST_USERS.carol),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the conversation for a participant', async () => {
      const conversation = makeConversation();
      prisma.conversation.findUnique.mockResolvedValue(conversation);

      await expect(
        service.getParticipantConversation(TEST_CONVERSATION_ID, TEST_USERS.bob),
      ).resolves.toBe(conversation);
    });
  });
});
