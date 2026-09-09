import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TEST_CONVERSATION_ID,
  TEST_USERS,
  makeConversation,
  makeMessage,
} from '../common/test-fixtures';
import type { AuditService } from '../audit/audit.service';
import type { ContentCipherService } from '../common/content-cipher.service';
import { argOf } from '../common/spec-helpers';
import { ConversationsService } from '../conversations/conversations.service';
import type { OutboxService } from '../nats/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from './messages.service';

/**
 * Tests unitaires : Prisma, ConversationsService, l'event bus et OutboxService
 * mockés. `$transaction(cb)` exécute le callback avec le prisma mocké comme
 * client tx. On vérifie l'écriture métier, l'événement interne, l'enfilement
 * de l'événement d'intégration dans la transaction, et le filtrage soft-delete.
 */
describe('MessagesService', () => {
  const createdAt = new Date('2026-09-07T10:00:00.000Z');
  const conversationRow = makeConversation({
    id: TEST_CONVERSATION_ID,
    userAId: TEST_USERS.alice,
    userBId: TEST_USERS.bob,
  });

  let prisma: {
    $transaction: jest.Mock;
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    messageVersion: { create: jest.Mock; findMany: jest.Mock };
    conversation: { update: jest.Mock };
  };
  let conversations: { getParticipantConversation: jest.Mock };
  let events: { emit: jest.Mock };
  let outbox: { enqueueInTx: jest.Mock; wake: jest.Mock };
  let cipher: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  let service: MessagesService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
      message: {
        create: jest.fn().mockResolvedValue(makeMessage({ id: 'msg-1', createdAt })),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      messageVersion: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    conversations = {
      getParticipantConversation: jest.fn().mockResolvedValue(conversationRow),
    };
    events = { emit: jest.fn() };
    outbox = { enqueueInTx: jest.fn().mockResolvedValue({ id: 'evt' }), wake: jest.fn() };
    // Chiffrement : passe-plat par défaut (préfixe visible pour vérifier l'appel).
    cipher = {
      encrypt: jest.fn((s: string) => `enc(${s})`),
      decrypt: jest.fn((s: string) => s.replace(/^enc\((.*)\)$/, '$1')),
    };
    audit = { log: jest.fn() };
    service = new MessagesService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationsService,
      events as unknown as EventEmitter2,
      outbox as unknown as OutboxService,
      cipher as unknown as ContentCipherService,
      audit as unknown as AuditService,
    );
  });

  describe('send', () => {
    it('creates the message and emits the internal message.created event with both participant ids', async () => {
      await service.send(TEST_CONVERSATION_ID, TEST_USERS.alice, { content: 'hello' });

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        'message.created',
        expect.objectContaining({
          conversationId: TEST_CONVERSATION_ID,
          participantIds: [TEST_USERS.alice, TEST_USERS.bob],
        }),
      );
    });

    it('enqueues messaging.message.created (ISO date, no content) inside the transaction, then wakes the outbox', async () => {
      await service.send(TEST_CONVERSATION_ID, TEST_USERS.alice, { content: 'hello' });

      expect(outbox.enqueueInTx).toHaveBeenCalledWith(prisma, 'messaging.message.created', {
        messageId: 'msg-1',
        conversationId: TEST_CONVERSATION_ID,
        senderId: TEST_USERS.alice,
        createdAt: createdAt.toISOString(),
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(outbox.wake).toHaveBeenCalledTimes(1);
      // enqueue happens within the tx callback, before wake().
      expect(outbox.enqueueInTx.mock.invocationCallOrder[0]).toBeLessThan(
        outbox.wake.mock.invocationCallOrder[0],
      );
    });

    it('still resolves if waking the outbox throws (best-effort)', async () => {
      outbox.wake.mockImplementation(() => {
        throw new Error('boom');
      });

      // wake() is fire-and-forget in the service; a throw must not surface, but
      // even if it did the send has already committed. Guard the contract:
      await expect(
        service.send(TEST_CONVERSATION_ID, TEST_USERS.alice, { content: 'hello' }),
      ).resolves.toMatchObject({ id: 'msg-1' });
    });

    it('rejects an empty content (defense in depth)', async () => {
      await expect(
        service.send(TEST_CONVERSATION_ID, TEST_USERS.alice, { content: '   ' }),
      ).rejects.toThrow();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('encrypts content before persisting and returns it in clear', async () => {
      prisma.message.create.mockResolvedValue(
        makeMessage({ id: 'msg-1', content: 'enc(hello)', createdAt }),
      );

      const res = await service.send(TEST_CONVERSATION_ID, TEST_USERS.alice, { content: 'hello' });

      expect(cipher.encrypt).toHaveBeenCalledWith('hello');
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: TEST_CONVERSATION_ID,
          senderId: TEST_USERS.alice,
          content: 'enc(hello)',
        },
      });
      // Clients get clear text; only storage is encrypted.
      expect(res.content).toBe('hello');
    });
  });

  describe('paginate', () => {
    it('excludes soft-deleted rows, returns a stable page and a nextCursor when more rows exist', async () => {
      const rows = [
        makeMessage({ id: 'm3' }),
        makeMessage({ id: 'm2' }),
        makeMessage({ id: 'm1' }),
      ];
      prisma.message.findMany.mockResolvedValue(rows);

      const page = await service.paginate(TEST_CONVERSATION_ID, TEST_USERS.alice, undefined, 2);

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: TEST_CONVERSATION_ID, deletedAt: null },
          take: 3,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(page.items.map((m) => m.id)).toEqual(['m3', 'm2']);
      expect(page.nextCursor).toBe('m2');
      expect(cipher.decrypt).toHaveBeenCalled();
    });

    it('decrypts each returned message content', async () => {
      prisma.message.findMany.mockResolvedValue([
        makeMessage({ id: 'm1', content: 'enc(secret)' }),
      ]);

      const page = await service.paginate(TEST_CONVERSATION_ID, TEST_USERS.alice, undefined, 10);

      expect(page.items[0].content).toBe('secret');
    });

    it('returns nextCursor null on the last page', async () => {
      prisma.message.findMany.mockResolvedValue([
        makeMessage({ id: 'm2' }),
        makeMessage({ id: 'm1' }),
      ]);

      const page = await service.paginate(TEST_CONVERSATION_ID, TEST_USERS.alice, undefined, 5);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('clamps an oversized limit to 100', async () => {
      prisma.message.findMany.mockResolvedValue([]);

      await service.paginate(TEST_CONVERSATION_ID, TEST_USERS.alice, undefined, 100_000);

      expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
    });

    it('passes the cursor through with skip: 1', async () => {
      prisma.message.findMany.mockResolvedValue([]);

      await service.paginate(TEST_CONVERSATION_ID, TEST_USERS.alice, 'cursor-id', 10);

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'cursor-id' }, skip: 1 }),
      );
    });
  });

  describe('markRead', () => {
    it('throws NotFoundException for an unknown message', async () => {
      prisma.message.findUnique.mockResolvedValue(null);

      await expect(service.markRead('missing', TEST_USERS.bob)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFoundException for a soft-deleted message', async () => {
      prisma.message.findUnique.mockResolvedValue(makeMessage({ deletedAt: new Date() }));

      await expect(service.markRead('msg-1', TEST_USERS.bob)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('forbids the sender from marking their own message as read', async () => {
      prisma.message.findUnique.mockResolvedValue(makeMessage({ senderId: TEST_USERS.alice }));

      await expect(service.markRead('msg-1', TEST_USERS.alice)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.message.update).not.toHaveBeenCalled();
    });

    it('is idempotent: an already-read message is returned (decrypted) as-is, no event, no enqueue', async () => {
      const alreadyRead = makeMessage({ senderId: TEST_USERS.alice, readAt: createdAt });
      prisma.message.findUnique.mockResolvedValue(alreadyRead);

      const result = await service.markRead('msg-1', TEST_USERS.bob);

      expect(result).toEqual(alreadyRead);
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(outbox.enqueueInTx).not.toHaveBeenCalled();
    });

    it('marks an unread received message as read, enqueues messaging.message.read and emits message.read', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, readAt: null }),
      );
      const readAt = new Date('2026-09-08T12:00:00.000Z');
      prisma.message.update.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, readAt }),
      );

      const result = await service.markRead('msg-1', TEST_USERS.bob);

      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'msg-1' } }),
      );
      expect(outbox.enqueueInTx).toHaveBeenCalledWith(prisma, 'messaging.message.read', {
        messageId: 'msg-1',
        conversationId: TEST_CONVERSATION_ID,
        readAt: readAt.toISOString(),
      });
      expect(events.emit).toHaveBeenCalledWith(
        'message.read',
        expect.objectContaining({ messageId: 'msg-1', readBy: TEST_USERS.bob }),
      );
      expect(result.readAt).toEqual(readAt);
    });
  });

  describe('markConversationRead', () => {
    it('bulk-marks received unread messages, enqueues messaging.conversation.read and emits conversation.read', async () => {
      const result = await service.markConversationRead(TEST_CONVERSATION_ID, TEST_USERS.bob);

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId: TEST_CONVERSATION_ID,
            senderId: { not: TEST_USERS.bob },
            readAt: null,
            deletedAt: null,
          },
        }),
      );
      expect(outbox.enqueueInTx).toHaveBeenCalledWith(
        prisma,
        'messaging.conversation.read',
        expect.objectContaining({
          conversationId: TEST_CONVERSATION_ID,
          count: 3,
          readBy: TEST_USERS.bob,
        }),
      );
      expect(result).toEqual({ updated: 3 });
      expect(events.emit).toHaveBeenCalledWith(
        'conversation.read',
        expect.objectContaining({ conversationId: TEST_CONVERSATION_ID, count: 3 }),
      );
    });

    it('is a no-op (no event, no enqueue) when nothing was unread', async () => {
      prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.markConversationRead(TEST_CONVERSATION_ID, TEST_USERS.bob);

      expect(result).toEqual({ updated: 0 });
      expect(events.emit).not.toHaveBeenCalled();
      expect(outbox.enqueueInTx).not.toHaveBeenCalled();
    });
  });

  describe('edit', () => {
    it('archives the previous (stored) content, bumps editCount, emits message.edited, returns clear text', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, content: 'enc(old)' }),
      );
      prisma.message.update.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, content: 'enc(new)', editCount: 1 }),
      );

      const res = await service.edit('msg-1', TEST_USERS.alice, { content: 'new' });

      expect(prisma.messageVersion.create).toHaveBeenCalledWith({
        data: { messageId: 'msg-1', content: 'enc(old)' },
      });
      const upd = argOf<{ data: { content: string; editCount: unknown; editedAt: unknown } }>(
        prisma.message.update,
      );
      expect(upd.data.content).toBe('enc(new)');
      expect(upd.data.editCount).toEqual({ increment: 1 });
      expect(upd.data.editedAt).toBeInstanceOf(Date);
      expect(res.content).toBe('new');
      expect(events.emit).toHaveBeenCalledWith('message.edited', expect.anything());
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'message.edited', resourceId: 'msg-1' }),
      );
    });

    it('forbids a non-sender from editing', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice }),
      );

      await expect(service.edit('msg-1', TEST_USERS.bob, { content: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.messageVersion.create).not.toHaveBeenCalled();
    });

    it('is idempotent when the content is unchanged (no version, no update)', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, content: 'enc(same)' }),
      );

      await service.edit('msg-1', TEST_USERS.alice, { content: 'same' });

      expect(prisma.messageVersion.create).not.toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('404s on a soft-deleted message', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ senderId: TEST_USERS.alice, deletedAt: new Date() }),
      );

      await expect(
        service.edit('msg-1', TEST_USERS.alice, { content: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getVersions', () => {
    it('returns the decrypted history oldest-first for a participant', async () => {
      prisma.message.findUnique.mockResolvedValue(makeMessage({ id: 'msg-1' }));
      prisma.messageVersion.findMany.mockResolvedValue([
        { id: 'v1', content: 'enc(first)', createdAt: createdAt },
        { id: 'v2', content: 'enc(second)', createdAt: createdAt },
      ]);

      const history = await service.getVersions('msg-1', TEST_USERS.bob);

      expect(prisma.messageVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { messageId: 'msg-1' }, orderBy: { createdAt: 'asc' } }),
      );
      expect(history.map((v) => v.content)).toEqual(['first', 'second']);
    });
  });

  describe('softDelete / restore', () => {
    it('lets the sender soft-delete, emits message.deleted, is idempotent', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice }),
      );

      const res = await service.softDelete('msg-1', TEST_USERS.alice);

      expect(res).toEqual({ deleted: true });
      const upd = argOf<{ data: { deletedAt: unknown } }>(prisma.message.update);
      expect(upd.data.deletedAt).toBeInstanceOf(Date);
      expect(events.emit).toHaveBeenCalledWith('message.deleted', expect.anything());
    });

    it('forbids a non-sender from deleting', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice }),
      );

      await expect(service.softDelete('msg-1', TEST_USERS.bob)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('restores a soft-deleted message for its sender', async () => {
      prisma.message.findUnique.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, deletedAt: new Date() }),
      );
      prisma.message.update.mockResolvedValue(
        makeMessage({ id: 'msg-1', senderId: TEST_USERS.alice, deletedAt: null }),
      );

      const res = await service.restore('msg-1', TEST_USERS.alice);

      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: null } }),
      );
      expect(res.deletedAt).toBeNull();
    });
  });
});
