import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertUuid } from '../common/assert';
import { Conversation, Prisma } from '../generated/prisma/client';
import { OutboxService } from '../nats/outbox.service';
import { NATS_SUBJECTS } from '../nats/nats.events';
import { PrismaService } from '../prisma/prisma.service';

/** Conversation enrichie du nombre de messages non lus pour l'appelant. */
export type ConversationWithUnread = Conversation & { unreadCount: number };

/**
 * Création et récupération des conversations one-to-one.
 *
 * `getParticipantConversation` est aussi le point de contrôle d'accès réutilisé
 * par MessagesService (vérifie existence + appartenance à la conversation).
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** Réveil de l'outbox, blindé : la conversation est déjà committée. */
  private safeWake(): void {
    try {
      this.outbox.wake();
    } catch (err) {
      this.logger.error(`Failed to wake outbox: ${(err as Error).message}`);
    }
  }

  /**
   * Ordonne la paire pour qu'une conversation entre X et Y mappe toujours la même
   * ligne, quel que soit qui l'ouvre. Combiné à la contrainte @@unique, cela
   * empêche les doublons.
   */
  private static orderPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  /**
   * Conversations non supprimées de l'utilisateur, les plus récemment actives
   * d'abord (null en dernier), chacune avec `unreadCount` = nombre de messages
   * reçus (donc pas envoyés par lui) encore non lus. Le décompte se fait en une
   * seule requête `groupBy` (index partiel `WHERE "readAt" IS NULL` en base).
   */
  async listForUser(userId: string): Promise<ConversationWithUnread[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }], deletedAt: null },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    if (conversations.length === 0) {
      return [];
    }

    const unreadGroups = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: conversations.map((c) => c.id) },
        senderId: { not: userId },
        readAt: null,
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const unreadByConversation = new Map(
      unreadGroups.map((group) => [group.conversationId, group._count._all]),
    );

    return conversations.map((conversation) => ({
      ...conversation,
      unreadCount: unreadByConversation.get(conversation.id) ?? 0,
    }));
  }

  /**
   * Retourne la conversation entre les deux utilisateurs, en la créant si besoin.
   * Une conversation soft-deletée est réactivée (`deletedAt` remis à null).
   * L'événement NATS `messaging.conversation.created` n'est publié qu'en cas de
   * création réelle (pas sur récupération / réactivation).
   */
  async findOrCreate(userId: string, otherUserId: string): Promise<Conversation> {
    // Défense en profondeur : `participantId` est déjà `@IsUUID` au niveau DTO.
    assertUuid(otherUserId, 'participantId');
    if (userId === otherUserId) {
      throw new ForbiddenException('Cannot open a conversation with yourself');
    }
    const [userAId, userBId] = ConversationsService.orderPair(userId, otherUserId);

    const existing = await this.prisma.conversation.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
    });
    if (existing) {
      if (existing.deletedAt) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: { deletedAt: null },
        });
      }
      return existing;
    }

    let created: Conversation;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.conversation.create({ data: { userAId, userBId } });
        // Événement d'intégration écrit dans la même transaction (outbox durable).
        await this.outbox.enqueueInTx(tx, NATS_SUBJECTS.conversationCreated, {
          conversationId: row.id,
          userAId: row.userAId,
          userBId: row.userBId,
          createdAt: row.createdAt.toISOString(),
        });
        return row;
      });
    } catch (err) {
      // Course perdue face à une création concurrente (P2002 = violation d'unicité) :
      // on renvoie la ligne existante, sans publier d'événement.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.conversation.findUniqueOrThrow({
          where: { userAId_userBId: { userAId, userBId } },
        });
      }
      throw err;
    }

    this.safeWake();
    return created;
  }

  /**
   * Charge une conversation non supprimée et vérifie que `userId` en est bien
   * participant.
   * @throws NotFoundException  conversation inconnue ou supprimée
   * @throws ForbiddenException  utilisateur non participant
   */
  async getParticipantConversation(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conversation || conversation.deletedAt) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userAId !== userId && conversation.userBId !== userId) {
      throw new ForbiddenException('You are not a participant of this conversation');
    }
    return conversation;
  }
}
