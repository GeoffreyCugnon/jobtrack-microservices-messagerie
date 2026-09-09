import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { assertMessageContent, assertUuid } from '../common/assert';
import { Message, MessageVersion, Prisma } from '../generated/prisma/client';
import {
  CONVERSATION_READ,
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_EDITED,
  MESSAGE_READ,
  ConversationReadEvent,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageEditedEvent,
  MessageReadEvent,
} from '../common/events';
import { AuditService } from '../audit/audit.service';
import { ContentCipherService } from '../common/content-cipher.service';
import { ConversationsService } from '../conversations/conversations.service';
import { OutboxService } from '../nats/outbox.service';
import { NATS_SUBJECTS } from '../nats/nats.events';
import { PrismaService } from '../prisma/prisma.service';
import { EditMessageDto } from './dto/edit-message.dto';
import { SendMessageDto } from './dto/send-message.dto';

/** Taille de page par défaut de la pagination par curseur. */
const DEFAULT_PAGE_SIZE = 30;
/** Borne dure de la taille de page, même si un appelant contourne le DTO. */
const MAX_PAGE_SIZE = 100;

/** Résultat paginé : `nextCursor` est l'id à repasser en `?cursor=` pour la page suivante. */
export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}

/** Version archivée d'un message, contenu déchiffré. */
export interface MessageVersionView {
  id: string;
  content: string;
  createdAt: Date;
}

type MessageEvent =
  | MessageCreatedEvent
  | MessageReadEvent
  | ConversationReadEvent
  | MessageEditedEvent
  | MessageDeletedEvent;

/**
 * Envoi, lecture et pagination des messages.
 *
 * Chaque écriture métier s'exécute dans une transaction Prisma qui inclut la
 * ligne `OutboxEvent` de l'événement d'intégration NATS (outbox durable). Après
 * commit, deux diffusions best-effort :
 *   - événement interne -> MessagingGateway -> WebSocket (contenu inclus) ;
 *   - réveil de l'outbox -> publication NATS -> autres micro-services (jamais le contenu).
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly events: EventEmitter2,
    private readonly outbox: OutboxService,
    private readonly cipher: ContentCipherService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Renvoie une copie du message avec `content` déchiffré (lecture).
   *
   * Tolérant : si le déchiffrement échoue (clé absente/rotée, ligne corrompue),
   * on ne fait pas planter la lecture — le message est renvoyé avec un contenu
   * de remplacement et l'erreur est journalisée. Un `GET /messages` qui renvoie
   * `[message indisponible]` reste préférable à un 500 sur toute la page.
   */
  private decrypted(message: Message): Message {
    try {
      return { ...message, content: this.cipher.decrypt(message.content) };
    } catch (err) {
      this.logger.error(`Failed to decrypt message ${message.id}: ${(err as Error).message}`);
      return { ...message, content: '[contenu indisponible]' };
    }
  }

  /**
   * Vérifie que `userId` est bien participant de `conversationId`. Utilisé par la
   * gateway avant de laisser une socket rejoindre la room d'une conversation
   * (les routes REST font ce contrôle partout ; la room WS doit l'avoir aussi).
   * @throws NotFoundException / ForbiddenException (mappées en WsException par le filtre)
   */
  async assertParticipant(conversationId: string, userId: string): Promise<void> {
    assertUuid(conversationId, 'conversationId');
    await this.conversations.getParticipantConversation(conversationId, userId);
  }

  /**
   * Émission de l'événement interne (fan-out WebSocket) en mode best-effort :
   * un listener défaillant ne doit pas transformer une écriture Prisma réussie
   * en réponse REST en erreur.
   */
  private safeEmit(event: string, payload: MessageEvent): void {
    try {
      this.events.emit(event, payload);
    } catch (err) {
      this.logger.error(`Failed to emit "${event}": ${(err as Error).message}`);
    }
  }

  /** Réveil de l'outbox, blindé : une écriture métier committée ne doit jamais échouer ici. */
  private safeWake(): void {
    try {
      this.outbox.wake();
    } catch (err) {
      this.logger.error(`Failed to wake outbox: ${(err as Error).message}`);
    }
  }

  /** Déchiffrement tolérant d'une chaîne isolée (contenu de `MessageVersion`). */
  private safeDecrypt(stored: string, ref: string): string {
    try {
      return this.cipher.decrypt(stored);
    } catch (err) {
      this.logger.error(`Failed to decrypt ${ref}: ${(err as Error).message}`);
      return '[contenu indisponible]';
    }
  }

  /**
   * Pagination par curseur, message le plus récent en premier. Exclut les
   * messages soft-deletés.
   *
   * On demande `limit + 1` lignes : la ligne excédentaire sert uniquement à
   * savoir s'il reste une page (et à calculer `nextCursor`), elle n'est pas
   * renvoyée. `skip: 1` exclut la ligne pointée par le curseur.
   */
  async paginate(
    conversationId: string,
    userId: string,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<MessagePage> {
    await this.conversations.getParticipantConversation(conversationId, userId);

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const take = safeLimit + 1;
    const rows = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null },
      // `id` en second critère : ordre stable si deux messages ont le même createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length === take;
    const items = (hasMore ? rows.slice(0, safeLimit) : rows).map((m) => this.decrypted(m));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Crée un message + `lastMessageAt` + ligne d'outbox dans une transaction, puis diffuse. */
  async send(conversationId: string, senderId: string, dto: SendMessageDto): Promise<Message> {
    // Défense en profondeur : DTO (`@IsUUID`, `@MinLength/@MaxLength`) et
    // `ParseUUIDPipe` valident déjà en amont sur les chemins REST et WS.
    assertUuid(conversationId, 'conversationId');
    assertMessageContent(dto.content);

    const conversation = await this.conversations.getParticipantConversation(
      conversationId,
      senderId,
    );

    // `metadata` n'est posé que s'il est fourni (évite d'écrire `null` explicitement).
    // `content` est chiffré au repos si une clé est configurée (no-op sinon).
    const data: Prisma.MessageUncheckedCreateInput = {
      conversationId,
      senderId,
      content: this.cipher.encrypt(dto.content),
    };
    if (dto.metadata !== undefined) {
      data.metadata = dto.metadata as Prisma.InputJsonValue;
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({ data });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt },
      });
      await this.outbox.enqueueInTx(tx, NATS_SUBJECTS.messageCreated, {
        messageId: created.id,
        conversationId: created.conversationId,
        senderId: created.senderId,
        createdAt: created.createdAt.toISOString(),
      });
      return created;
    });

    this.safeWake();

    // Les clients (REST + WebSocket) reçoivent toujours le contenu en clair ;
    // seul le stockage est chiffré.
    const plain: Message = { ...message, content: dto.content };

    // Événement interne -> diffusion WebSocket (room de la conversation pour le
    // fil ouvert + rooms `user:<id>` des deux participants pour rafraîchir leur
    // liste, même conversation fermée).
    this.safeEmit(MESSAGE_CREATED, {
      conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      message: plain,
    } satisfies MessageCreatedEvent);

    this.audit.log({
      userId: senderId,
      action: 'message.sent',
      resourceType: 'message',
      resourceId: plain.id,
      details: { conversationId },
    });

    return plain;
  }

  /**
   * Marque un message comme lu.
   *
   * Règles : seul un participant peut le faire, et jamais l'expéditeur lui-même.
   * Idempotent : si le message est déjà lu, on le renvoie tel quel sans réémettre
   * d'événement. Un message soft-deleté est traité comme introuvable.
   */
  async markRead(messageId: string, userId: string): Promise<Message> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) {
      throw new NotFoundException('Message not found');
    }
    const conversation = await this.conversations.getParticipantConversation(
      message.conversationId,
      userId,
    );
    if (message.senderId === userId) {
      throw new ForbiddenException('The sender cannot mark their own message as read');
    }
    if (message.readAt) {
      return this.decrypted(message);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.message.update({
        where: { id: messageId },
        data: { readAt: new Date() },
      });
      await this.outbox.enqueueInTx(tx, NATS_SUBJECTS.messageRead, {
        messageId: row.id,
        conversationId: row.conversationId,
        readAt: (row.readAt as Date).toISOString(),
      });
      return row;
    });

    this.safeWake();

    // Événement interne -> accusé de lecture en WebSocket.
    this.safeEmit(MESSAGE_READ, {
      conversationId: updated.conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      messageId: updated.id,
      readAt: updated.readAt as Date,
      readBy: userId,
    } satisfies MessageReadEvent);

    this.audit.log({
      userId,
      action: 'message.read',
      resourceType: 'message',
      resourceId: updated.id,
      details: { conversationId: updated.conversationId },
    });

    return this.decrypted(updated);
  }

  /**
   * Marque d'un coup tous les messages reçus non lus d'une conversation comme
   * lus (appelé à l'ouverture du fil). Idempotent : `{ updated: 0 }` et aucun
   * événement si rien n'était non lu. Ne touche jamais les messages envoyés par
   * l'appelant.
   */
  async markConversationRead(conversationId: string, userId: string): Promise<{ updated: number }> {
    const conversation = await this.conversations.getParticipantConversation(
      conversationId,
      userId,
    );

    const readAt = new Date();
    const count = await this.prisma.$transaction(async (tx) => {
      const res = await tx.message.updateMany({
        where: { conversationId, senderId: { not: userId }, readAt: null, deletedAt: null },
        data: { readAt },
      });
      if (res.count > 0) {
        // Accusé de lecture agrégé : `messaging.message.read` est unitaire, ce
        // sujet couvre la lecture en masse (cf. nats.events.ts).
        await this.outbox.enqueueInTx(tx, NATS_SUBJECTS.conversationRead, {
          conversationId,
          readBy: userId,
          readAt: readAt.toISOString(),
          count: res.count,
        });
      }
      return res.count;
    });

    if (count === 0) {
      return { updated: 0 };
    }

    this.safeWake();

    // Événement interne -> WebSocket (room de la conversation + rooms perso).
    this.safeEmit(CONVERSATION_READ, {
      conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      readBy: userId,
      readAt,
      count,
    } satisfies ConversationReadEvent);

    this.audit.log({
      userId,
      action: 'conversation.read',
      resourceType: 'conversation',
      resourceId: conversationId,
      details: { count },
    });

    return { updated: count };
  }

  /**
   * Édite le contenu d'un message. Seul l'expéditeur peut éditer. Le contenu
   * antérieur est archivé dans `MessageVersion` (dans la même transaction),
   * `editCount` incrémenté, `editedAt` mis à jour. Idempotent : si le nouveau
   * contenu est identique à l'actuel, aucune version n'est créée.
   */
  async edit(messageId: string, userId: string, dto: EditMessageDto): Promise<Message> {
    assertMessageContent(dto.content);
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) {
      throw new NotFoundException('Message not found');
    }
    const conversation = await this.conversations.getParticipantConversation(
      message.conversationId,
      userId,
    );
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender can edit this message');
    }
    // Idempotence : si l'actuel est illisible, on ne court-circuite pas — on
    // laisse l'édition écraser (safeDecrypt renvoie un sentinel non égal au DTO).
    if (this.safeDecrypt(message.content, `message ${message.id}`) === dto.content) {
      return this.decrypted(message);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Archive le contenu ACTUEL tel que stocké (donc déjà chiffré si clé active).
      await tx.messageVersion.create({
        data: { messageId, content: message.content },
      });
      return tx.message.update({
        where: { id: messageId },
        data: {
          content: this.cipher.encrypt(dto.content),
          editedAt: new Date(),
          editCount: { increment: 1 },
        },
      });
    });

    const plain: Message = { ...updated, content: dto.content };

    this.safeEmit(MESSAGE_EDITED, {
      conversationId: updated.conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      message: plain,
    } satisfies MessageEditedEvent);

    this.audit.log({
      userId,
      action: 'message.edited',
      resourceType: 'message',
      resourceId: messageId,
      details: { conversationId: updated.conversationId, editCount: updated.editCount },
    });

    return plain;
  }

  /**
   * Historique d'édition d'un message (le plus ancien en premier). Accessible
   * aux deux participants de la conversation.
   */
  async getVersions(messageId: string, userId: string): Promise<MessageVersionView[]> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) {
      throw new NotFoundException('Message not found');
    }
    await this.conversations.getParticipantConversation(message.conversationId, userId);

    const versions = await this.prisma.messageVersion.findMany({
      where: { messageId },
      orderBy: { createdAt: 'asc' },
    });
    return versions.map((v: MessageVersion) => ({
      id: v.id,
      content: this.safeDecrypt(v.content, `version ${v.id}`),
      createdAt: v.createdAt,
    }));
  }

  /**
   * Soft-delete d'un message. Seul l'expéditeur peut supprimer son message.
   * Idempotent : un message déjà supprimé renvoie `{ deleted: true }` sans rien
   * réémettre. Les `MessageVersion` associées suivront le message si celui-ci
   * est un jour purgé physiquement (cascade en base).
   */
  async softDelete(messageId: string, userId: string): Promise<{ deleted: true }> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    const conversation = await this.conversations.getParticipantConversation(
      message.conversationId,
      userId,
    );
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender can delete this message');
    }
    if (message.deletedAt) {
      return { deleted: true };
    }

    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });

    this.safeEmit(MESSAGE_DELETED, {
      conversationId: message.conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      messageId,
      deletedBy: userId,
    } satisfies MessageDeletedEvent);

    this.audit.log({
      userId,
      action: 'message.deleted',
      resourceType: 'message',
      resourceId: messageId,
      details: { conversationId: message.conversationId },
    });

    return { deleted: true };
  }

  /** Restaure un message soft-deleté. Expéditeur uniquement. Idempotent. */
  async restore(messageId: string, userId: string): Promise<Message> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    await this.conversations.getParticipantConversation(message.conversationId, userId);
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender can restore this message');
    }
    if (!message.deletedAt) {
      return this.decrypted(message);
    }

    const restored = await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: null },
    });

    this.audit.log({
      userId,
      action: 'message.restored',
      resourceType: 'message',
      resourceId: messageId,
      details: { conversationId: message.conversationId },
    });

    return this.decrypted(restored);
  }
}
