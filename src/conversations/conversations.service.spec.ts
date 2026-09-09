import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TEST_CONVERSATION_ID, TEST_USERS, makeConversation } from '../common/test-fixtures';
import { Prisma } from '../generated/prisma/client';
import type { OutboxService } from '../nats/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';

/**
 * Tests unitaires du service : Prisma et OutboxService entièrement mockés.
 * `$transaction(cb)` exécute le callback avec le prisma mocké comme client tx.
 * On vérifie la normalisation de paire, la race condition P2002, la
 * réactivation d'une conversation soft-deletée, le décompte des non-lus et le
 * contrôle d'accès participant.
 */
describe('ConversationsService', () => {
  let prisma: {
    $transaction: jest.Mock;
    conversation: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
    };
    message: { groupBy: jest.Mock };
  };
  let outbox: { enqueueInTx: jest.Mock; wake: jest.Mock };
  let service: ConversationsService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
      conversation: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      message: { groupBy: jest.fn() },
    };
    outbox = { enqueueInTx: jest.fn().mockResolvedValue({ id: 'evt' }), wake: jest.fn() };
    service = new ConversationsService(
      prisma as unknown as PrismaService,
      outbox as unknown as OutboxService,
    );
  });

  describe('findOrCreate', () => {
    it('rejects opening a conversation with yourself', async () => {
      await expect(service.findOrCreate(TEST_USERS.alice, TEST_USERS.alice)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    });

    it('creates a new conversation, normalising the pair and enqueuing the outbox event in the tx', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);
      const created = makeConversation();
      prisma.conversation.create.mockResolvedValue(created);

      // bob > alice : l'appel passe (bob, alice) mais la paire doit être normalisée.
      const result = await service.findOrCreate(TEST_USERS.bob, TEST_USERS.alice);

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: { userAId: TEST_USERS.alice, userBId: TEST_USERS.bob },
      });
      expect(outbox.enqueueInTx).toHaveBeenCalledWith(
        prisma,
        'messaging.conversation.created',
        expect.objectContaining({
          conversationId: created.id,
          userAId: TEST_USERS.alice,
          userBId: TEST_USERS.bob,
          createdAt: created.createdAt.toISOString(),
        }),
      );
      expect(outbox.wake).toHaveBeenCalledTimes(1);
      expect(result).toBe(created);
    });

    it('returns an existing active conversation without creating or enqueuing', async () => {
      const existing = makeConversation();
      prisma.conversation.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreate(TEST_USERS.alice, TEST_USERS.bob);

      expect(result).toBe(existing);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(outbox.enqueueInTx).not.toHaveBeenCalled();
    });

    it('reactivates a soft-deleted conversation instead of creating a new one', async () => {
      const deleted = makeConversation({ deletedAt: new Date('2026-09-01T00:00:00Z') });
      prisma.conversation.findUnique.mockResolvedValue(deleted);
      const revived = makeConversation({ deletedAt: null });
      prisma.conversation.update.mockResolvedValue(revived);

      const result = await service.findOrCreate(TEST_USERS.alice, TEST_USERS.bob);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: deleted.id },
        data: { deletedAt: null },
      });
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(outbox.enqueueInTx).not.toHaveBeenCalled();
      expect(result).toBe(revived);
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
      expect(outbox.wake).not.toHaveBeenCalled();
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

    it('filters out soft-deleted conversations and attaches unreadCount, defaulting to 0', async () => {
      const c1 = makeConversation({ id: 'conv-1' });
      const c2 = makeConversation({
        id: 'conv-2',
        userAId: TEST_USERS.alice,
        userBId: TEST_USERS.carol,
      });
      prisma.conversation.findMany.mockResolvedValue([c1, c2]);
      prisma.message.groupBy.mockResolvedValue([{ conversationId: 'conv-1', _count: { _all: 4 } }]);

      const result = await service.listForUser(TEST_USERS.alice);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ userAId: TEST_USERS.alice }, { userBId: TEST_USERS.alice }],
            deletedAt: null,
          },
        }),
      );
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
            deletedAt: null,
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

    it('throws NotFoundException when the conversation is soft-deleted', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation({ deletedAt: new Date() }));

      await expect(
        service.getParticipantConversation(TEST_CONVERSATION_ID, TEST_USERS.bob),
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
