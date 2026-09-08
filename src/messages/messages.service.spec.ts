import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NatsConnection } from 'nats';
import { ConversationsService } from '../conversations/conversations.service';
import { NatsPublisherService } from '../nats/nats-publisher.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from './messages.service';

/**
 * Vérifie que l'événement d'intégration NATS est bien publié APRÈS l'écriture
 * Prisma, et que l'échec de publication ne casse pas l'envoi (best-effort).
 * Tout est mocké : Prisma, ConversationsService, l'event bus, et le client NATS.
 */
describe('MessagesService integration events', () => {
  const conversationId = '11111111-1111-1111-1111-111111111111';
  const createdAt = new Date('2026-09-07T10:00:00.000Z');

  const messageRow = {
    id: 'msg-1',
    conversationId,
    senderId: 'user-a',
    content: 'hello',
    readAt: null,
    createdAt,
    metadata: null,
  };

  let natsClient: { publish: jest.Mock };
  let prisma: {
    message: { create: jest.Mock; updateMany: jest.Mock };
    conversation: { update: jest.Mock };
  };
  let conversations: { getParticipantConversation: jest.Mock };
  let events: { emit: jest.Mock };
  let publisher: NatsPublisherService;
  let service: MessagesService;

  beforeEach(() => {
    natsClient = { publish: jest.fn() };
    prisma = {
      message: {
        create: jest.fn().mockResolvedValue(messageRow),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    conversations = {
      getParticipantConversation: jest
        .fn()
        .mockResolvedValue({ id: conversationId, userAId: 'user-a', userBId: 'user-b' }),
    };
    events = { emit: jest.fn() };

    // Vrai NatsPublisherService, mais avec une connexion NATS mockée.
    publisher = new NatsPublisherService(natsClient as unknown as NatsConnection);

    service = new MessagesService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationsService,
      events as unknown as EventEmitter2,
      publisher,
    );
  });

  it('emits the internal message.created event with both participant ids', async () => {
    await service.send(conversationId, 'user-a', { content: 'hello' });

    expect(events.emit).toHaveBeenCalledWith('message.created', {
      conversationId,
      participantIds: ['user-a', 'user-b'],
      message: messageRow,
    });
  });

  describe('markConversationRead', () => {
    it('bulk-marks received unread messages and emits conversation.read', async () => {
      const result = await service.markConversationRead(conversationId, 'user-b');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId, senderId: { not: 'user-b' }, readAt: null },
        }),
      );
      expect(result).toEqual({ updated: 3 });
      expect(events.emit).toHaveBeenCalledWith(
        'conversation.read',
        expect.objectContaining({
          conversationId,
          participantIds: ['user-a', 'user-b'],
          readBy: 'user-b',
          count: 3,
        }),
      );
    });

    it('is a no-op (no event) when nothing was unread', async () => {
      prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.markConversationRead(conversationId, 'user-b');

      expect(result).toEqual({ updated: 0 });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('publishes messaging.message.created after the message is written', async () => {
    const publishSpy = jest.spyOn(publisher, 'publish');

    await service.send(conversationId, 'user-a', { content: 'hello' });

    expect(prisma.message.create).toHaveBeenCalledTimes(1);

    // Bon sujet + payload sans `content`.
    expect(publishSpy).toHaveBeenCalledWith('messaging.message.created', {
      messageId: 'msg-1',
      conversationId,
      senderId: 'user-a',
      createdAt,
    });

    // Le client NATS mocké a bien reçu l'appel.
    expect(natsClient.publish).toHaveBeenCalledTimes(1);
    expect(natsClient.publish).toHaveBeenCalledWith('messaging.message.created', expect.anything());

    // Ordre : la publication vient APRÈS l'écriture Prisma.
    expect(prisma.message.create.mock.invocationCallOrder[0]).toBeLessThan(
      publishSpy.mock.invocationCallOrder[0],
    );
  });

  it('does not fail the send when NATS publish throws (best-effort)', async () => {
    natsClient.publish.mockImplementation(() => {
      throw new Error('nats down');
    });

    await expect(service.send(conversationId, 'user-a', { content: 'hello' })).resolves.toEqual(
      messageRow,
    );
  });
});
