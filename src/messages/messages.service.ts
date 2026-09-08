import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Message, Prisma } from '../generated/prisma/client';
import {
  CONVERSATION_READ,
  MESSAGE_CREATED,
  MESSAGE_READ,
  ConversationReadEvent,
  MessageCreatedEvent,
  MessageReadEvent,
} from '../common/events';
import { ConversationsService } from '../conversations/conversations.service';
import { NatsPublisherService } from '../nats/nats-publisher.service';
import { NATS_SUBJECTS } from '../nats/nats.events';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';

/** Taille de page par défaut de la pagination par curseur. */
const DEFAULT_PAGE_SIZE = 30;

/** Résultat paginé : `nextCursor` est l'id à repasser en `?cursor=` pour la page suivante. */
export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
}

/**
 * Envoi, lecture et pagination des messages.
 *
 * Après chaque écriture réussie, deux diffusions *best-effort* (aucune ne peut
 * faire échouer la requête) :
 *   - événement interne -> MessagingGateway -> WebSocket (contenu inclus) ;
 *   - événement NATS -> autres micro-services (jamais le contenu).
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly events: EventEmitter2,
    private readonly nats: NatsPublisherService,
  ) {}

  /**
   * Émission de l'événement interne (fan-out WebSocket) en mode best-effort :
   * un listener défaillant ne doit pas transformer une écriture Prisma réussie
   * en réponse REST en erreur.
   */
  private safeEmit(
    event: string,
    payload: MessageCreatedEvent | MessageReadEvent | ConversationReadEvent,
  ): void {
    try {
      this.events.emit(event, payload);
    } catch (err) {
      this.logger.error(`Failed to emit "${event}": ${(err as Error).message}`);
    }
  }

  /**
   * Pagination par curseur, message le plus récent en premier.
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

    const take = limit + 1;
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      // `id` en second critère : ordre stable si deux messages ont le même createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length === take;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Crée un message, met à jour `lastMessageAt`, puis diffuse (WebSocket + NATS). */
  async send(conversationId: string, senderId: string, dto: SendMessageDto): Promise<Message> {
    const conversation = await this.conversations.getParticipantConversation(
      conversationId,
      senderId,
    );

    // `metadata` n'est posé que s'il est fourni (évite d'écrire `null` explicitement).
    const data: Prisma.MessageUncheckedCreateInput = {
      conversationId,
      senderId,
      content: dto.content,
    };
    if (dto.metadata !== undefined) {
      data.metadata = dto.metadata as Prisma.InputJsonValue;
    }

    const message = await this.prisma.message.create({ data });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });

    // Événement interne -> diffusion WebSocket (room de la conversation pour le
    // fil ouvert + rooms `user:<id>` des deux participants pour rafraîchir leur
    // liste, même conversation fermée).
    this.safeEmit(MESSAGE_CREATED, {
      conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      message,
    } satisfies MessageCreatedEvent);

    // Événement d'intégration NATS, après l'écriture réussie. Sans `content`.
    await this.nats.publish(NATS_SUBJECTS.messageCreated, {
      messageId: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      createdAt: message.createdAt,
    });

    return message;
  }

  /**
   * Marque un message comme lu.
   *
   * Règles : seul un participant peut le faire, et jamais l'expéditeur lui-même.
   * Idempotent : si le message est déjà lu, on le renvoie tel quel sans réémettre
   * d'événement.
   */
  async markRead(messageId: string, userId: string): Promise<Message> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
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
      return message;
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { readAt: new Date() },
    });

    // Événement interne -> accusé de lecture en WebSocket.
    this.safeEmit(MESSAGE_READ, {
      conversationId: updated.conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      messageId: updated.id,
      readAt: updated.readAt as Date,
      readBy: userId,
    } satisfies MessageReadEvent);

    // Événement d'intégration NATS, après l'écriture réussie.
    await this.nats.publish(NATS_SUBJECTS.messageRead, {
      messageId: updated.id,
      conversationId: updated.conversationId,
      readAt: updated.readAt as Date,
    });

    return updated;
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
    const { count } = await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      data: { readAt },
    });
    if (count === 0) {
      return { updated: 0 };
    }

    // Pas de publication NATS ici : le contrat `messaging.message.read` est
    // par message (un `messageId`), pas par lot. Les consommateurs externes qui
    // ont besoin du détail passent par `markRead` unitaire.

    // Événement interne -> WebSocket (room de la conversation + rooms perso).
    this.safeEmit(CONVERSATION_READ, {
      conversationId,
      participantIds: [conversation.userAId, conversation.userBId],
      readBy: userId,
      readAt,
      count,
    } satisfies ConversationReadEvent);

    return { updated: count };
  }
}
