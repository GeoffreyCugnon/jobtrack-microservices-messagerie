import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { assertUuid } from '../common/assert';
import { Conversation, Prisma } from '../generated/prisma/client';
import { OutboxService } from '../nats/outbox.service';
import { NATS_SUBJECTS } from '../nats/nats.events';
import { PrismaService } from '../prisma/prisma.service';

/** Conversation enrichie du nombre de messages non lus pour l'appelant. */
export type ConversationWithUnread = Conversation & { unreadCount: number };

/** Page de conversations : `nextCursor` = id à repasser en `?cursor=`. */
export interface ConversationPage {
  items: ConversationWithUnread[];
  nextCursor: string | null;
}

/** Taille de page par défaut de `listForUser`. */
const DEFAULT_PAGE_SIZE = 30;
/** Borne dure, même si un appelant contourne le DTO. */
const MAX_PAGE_SIZE = 100;

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
    private readonly audit: AuditService,
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
   * Page de conversations non supprimées de l'utilisateur, les plus récemment
   * actives d'abord (`lastMessageAt` null en dernier), chacune avec `unreadCount`
   * = nombre de messages reçus (donc pas envoyés par lui) encore non lus. Le
   * décompte se fait en une seule requête `groupBy` sur les ids de la page
   * (index partiel `WHERE "readAt" IS NULL` en base).
   *
   * Pagination par curseur : `id` sert de tie-breaker stable. `lastMessageAt`
   * évoluant à chaque message, une conversation peut changer de page entre deux
   * requêtes — acceptable pour une liste de conversations (même compromis que la
   * pagination des messages).
   */
  async listForUser(
    userId: string,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<ConversationPage> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const take = safeLimit + 1;
    const rows = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }], deletedAt: null },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length === take;
    const conversations = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor = hasMore ? conversations[conversations.length - 1].id : null;

    if (conversations.length === 0) {
      return { items: [], nextCursor };
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

    return {
      items: conversations.map((conversation) => ({
        ...conversation,
        unreadCount: unreadByConversation.get(conversation.id) ?? 0,
      })),
      nextCursor,
    };
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
        const revived = await this.prisma.conversation.update({
          where: { id: existing.id },
          data: { deletedAt: null },
        });
        this.audit.log({
          userId,
          action: 'conversation.restored',
          resourceType: 'conversation',
          resourceId: revived.id,
        });
        return revived;
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
    this.audit.log({
      userId,
      action: 'conversation.created',
      resourceType: 'conversation',
      resourceId: created.id,
    });
    return created;
  }

  /**
   * Ids des autres participants de toutes les conversations non supprimées de
   * `userId`, dédupliqués. Sert à la présence WebSocket : l'arrivée / le départ
   * d'un utilisateur n'est notifié qu'aux personnes avec qui il a une
   * conversation.
   */
  async listPartnerIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }], deletedAt: null },
      select: { userAId: true, userBId: true },
    });
    const partners = new Set<string>();
    for (const row of rows) {
      partners.add(row.userAId === userId ? row.userBId : row.userAId);
    }
    return [...partners];
  }

  /**
   * Une conversation de l'appelant, avec son `unreadCount` (comme dans la liste).
   * Réservé à un participant ; 404 si inconnue ou supprimée.
   */
  async getOneForUser(id: string, userId: string): Promise<ConversationWithUnread> {
    const conversation = await this.getParticipantConversation(id, userId);
    const unread = await this.prisma.message.count({
      where: { conversationId: id, senderId: { not: userId }, readAt: null, deletedAt: null },
    });
    return { ...conversation, unreadCount: unread };
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

  /**
   * Soft-delete d'une conversation (masquée pour les deux participants).
   * Réservé à un participant. Idempotent (une conversation déjà supprimée
   * renvoie `{ deleted: true }`). Les messages ne sont pas touchés :
   * `findOrCreate` réactive la conversation si la paire la rouvre.
   */
  async softDelete(id: string, userId: string): Promise<{ deleted: true }> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userAId !== userId && conversation.userBId !== userId) {
      throw new ForbiddenException('You are not a participant of this conversation');
    }
    if (conversation.deletedAt) {
      return { deleted: true };
    }
    await this.prisma.conversation.update({ where: { id }, data: { deletedAt: new Date() } });
    this.audit.log({
      userId,
      action: 'conversation.deleted',
      resourceType: 'conversation',
      resourceId: id,
    });
    return { deleted: true };
  }

  /** Restaure une conversation soft-deletée. Réservé à un participant. Idempotent. */
  async restore(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userAId !== userId && conversation.userBId !== userId) {
      throw new ForbiddenException('You are not a participant of this conversation');
    }
    if (!conversation.deletedAt) {
      return conversation;
    }
    const restored = await this.prisma.conversation.update({
      where: { id },
      data: { deletedAt: null },
    });
    this.audit.log({
      userId,
      action: 'conversation.restored',
      resourceType: 'conversation',
      resourceId: id,
    });
    return restored;
  }
}
