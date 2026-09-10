import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { clientIpFromHandshake } from '../common/trust-proxy';
import { WsExceptionFilter } from './ws-exception.filter';
import { AuthUser } from '../auth/auth-user.interface';
import { AuthService } from '../auth/auth.service';
import { extractWsToken } from '../auth/extract-token';
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
import { corsOriginCheck } from '../common/cors';
import { MetricsService } from '../metrics/metrics.service';
import { MessagesService } from '../messages/messages.service';
import { WsConversationDto, WsSendMessageDto } from './dto/ws-messages.dto';
import { WsRateLimiterService } from './rate-limiter.service';

/** Nom de la room Socket.IO pour une conversation donnée. */
const room = (conversationId: string): string => `conversation:${conversationId}`;

/**
 * Room Socket.IO propre à un utilisateur : chaque socket la rejoint dès la
 * connexion. Sert à pousser un événement à quelqu'un qui n'a aucune
 * conversation ouverte (donc dans aucune room `conversation:*`) — p. ex. pour
 * qu'il découvre une conversation toute neuve ou un message reçu panneau fermé.
 */
const userRoom = (userId: string): string => `user:${userId}`;

/** Utilisateur attaché au socket par handleConnection / AppAuthGuard. */
const userOf = (client: Socket): AuthUser | undefined => (client.data as { user?: AuthUser }).user;

/**
 * IP du client à l'origine du handshake. Derrière un reverse proxy, prend la
 * première entrée de `X-Forwarded-For` (cf. src/common/trust-proxy.ts) plutôt que
 * l'IP du proxy — sinon toutes les connexions partagent un seul bucket.
 */
const ipOf = (client: Socket): string => clientIpFromHandshake(client.handshake);

/**
 * Gateway temps réel (Socket.IO).
 *
 * Deux sens :
 *   - entrant  : `conversation:join` / `conversation:leave` / `message:send` /
 *     `typing:start` / `typing:stop` ;
 *   - sortant  : `message:new` / `message:read` / `typing`, poussés dans la room
 *     à la réception des événements internes émis par MessagesService.
 *
 * CORS Socket.IO : même liste blanche que le CORS HTTP (`corsOriginCheck`,
 * pilotée par `MESSAGING_CORS_ORIGINS`).
 */
@UseFilters(new WsExceptionFilter())
@UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
@WebSocketGateway({ cors: { origin: corsOriginCheck } })
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagingGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly authService: AuthService,
    private readonly messages: MessagesService,
    private readonly rateLimiter: WsRateLimiterService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Les guards ne s'exécutent pas sur l'événement de connexion : on valide donc
   * le JWT du handshake ici et on rejette le socket si besoin.
   */
  async handleConnection(client: Socket): Promise<void> {
    // Rate limit du handshake, par IP : coupe un flood de connexions avant
    // même la vérification JWT.
    if (!(await this.rateLimiter.allowConnection(ipOf(client)))) {
      this.logger.warn(`Rejected socket ${client.id}: connection rate limit`);
      client.disconnect(true);
      return;
    }

    try {
      const user = this.authService.verifyToken(extractWsToken(client));
      (client.data as { user?: AuthUser }).user = user;
      // Room personnelle : permet de notifier cet utilisateur hors de toute
      // room de conversation (cf. `broadcastMessageCreated`).
      void client.join(userRoom(user.id));
      this.metrics.incWsConnection();
    } catch (err) {
      this.logger.warn(`Rejected socket ${client.id}: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  /** Décrémente la jauge — uniquement pour les sockets qui avaient été authentifiées. */
  handleDisconnect(client: Socket): void {
    if (userOf(client)) {
      this.metrics.decWsConnection();
    }
  }

  // Les handlers @SubscribeMessage sont couverts par le guard global APP_GUARD
  // (AppAuthGuard), qui gère le cas `context.getType() === 'ws'`.

  /**
   * Rejoint la room de la conversation, après avoir vérifié que l'appelant en est
   * bien participant (les routes REST font ce contrôle partout ; la room WS doit
   * l'avoir aussi, sinon n'importe quelle socket authentifiée peut écouter le fil
   * d'autrui). Réponse : événement `conversation:joined`. Erreur mappée en
   * `WsException` (403 / 404) par `WsExceptionFilter`.
   */
  @SubscribeMessage('conversation:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: WsConversationDto) {
    const user = userOf(client);
    if (!user) {
      throw new WsException('Unauthorized');
    }
    await this.messages.assertParticipant(body.conversationId, user.id);
    await client.join(room(body.conversationId));
    return { event: 'conversation:joined', data: body.conversationId };
  }

  /** Quitte la room. Réponse : événement `conversation:left`. */
  @SubscribeMessage('conversation:leave')
  leave(@ConnectedSocket() client: Socket, @MessageBody() body: WsConversationDto) {
    void client.leave(room(body.conversationId));
    return { event: 'conversation:left', data: body.conversationId };
  }

  /** Équivalent WebSocket de `POST /conversations/:id/messages`. */
  @SubscribeMessage('message:send')
  async sendMessage(@ConnectedSocket() client: Socket, @MessageBody() body: WsSendMessageDto) {
    const user = userOf(client);
    if (!user) {
      // Filet de sécurité : ne devrait pas arriver, handleConnection ayant déjà rejeté.
      throw new WsException('Unauthorized');
    }
    if (!(await this.rateLimiter.allowMessage(user.id, client.id))) {
      throw new WsException('Message rate limit exceeded, slow down');
    }
    this.metrics.incWsMessage();
    return this.messages.send(body.conversationId, user.id, {
      content: body.content,
      metadata: body.metadata,
    });
  }

  /**
   * Indicateur « en train d'écrire ». Éphémère : rien n'est persisté, l'événement
   * `typing` est simplement relayé aux AUTRES sockets de la room de la
   * conversation (le client doit débouncer et émettre `typing:stop` à l'arrêt de
   * frappe / à l'envoi). Un refus de rate limit est silencieux.
   */
  @SubscribeMessage('typing:start')
  typingStart(@ConnectedSocket() client: Socket, @MessageBody() body: WsConversationDto) {
    return this.relayTyping(client, body.conversationId, true);
  }

  @SubscribeMessage('typing:stop')
  typingStop(@ConnectedSocket() client: Socket, @MessageBody() body: WsConversationDto) {
    return this.relayTyping(client, body.conversationId, false);
  }

  private async relayTyping(
    client: Socket,
    conversationId: string,
    typing: boolean,
  ): Promise<void> {
    const user = userOf(client);
    if (!user) {
      throw new WsException('Unauthorized');
    }
    if (!(await this.rateLimiter.allowTyping(user.id, client.id))) {
      return;
    }
    // Empêche d'usurper un fil dont on n'est pas participant : sans ce contrôle,
    // une socket pourrait pousser un faux « typing » dans la room d'autrui.
    await this.messages.assertParticipant(conversationId, user.id);
    client.to(room(conversationId)).emit('typing', { conversationId, userId: user.id, typing });
  }

  // --- Relais des événements internes vers la room -------------------------- //

  @OnEvent(MESSAGE_CREATED)
  broadcastMessageCreated(event: MessageCreatedEvent): void {
    // Fil ouvert : le message complet, dans la room de la conversation.
    this.server.to(room(event.conversationId)).emit('message:new', event.message);
    // Chaque participant, où qu'il soit dans l'app : un signal léger pour
    // réactualiser sa liste de conversations (badge non lus / MessagingFab),
    // même s'il n'est dans aucune room `conversation:*`.
    this.notifyParticipants(event.participantIds, event.conversationId);
  }

  @OnEvent(MESSAGE_READ)
  broadcastMessageRead(event: MessageReadEvent): void {
    this.server.to(room(event.conversationId)).emit('message:read', event);
    this.notifyParticipants(event.participantIds, event.conversationId);
  }

  @OnEvent(MESSAGE_EDITED)
  broadcastMessageEdited(event: MessageEditedEvent): void {
    this.server.to(room(event.conversationId)).emit('message:edited', event.message);
    this.notifyParticipants(event.participantIds, event.conversationId);
  }

  @OnEvent(MESSAGE_DELETED)
  broadcastMessageDeleted(event: MessageDeletedEvent): void {
    this.server.to(room(event.conversationId)).emit('message:deleted', {
      conversationId: event.conversationId,
      messageId: event.messageId,
      deletedBy: event.deletedBy,
    });
    this.notifyParticipants(event.participantIds, event.conversationId);
  }

  @OnEvent(CONVERSATION_READ)
  broadcastConversationRead(event: ConversationReadEvent): void {
    this.server.to(room(event.conversationId)).emit('conversation:read', event);
    this.notifyParticipants(event.participantIds, event.conversationId);
  }

  /** Pousse `conversation:updated` dans la room personnelle de chaque participant. */
  private notifyParticipants(participantIds: string[], conversationId: string): void {
    for (const userId of participantIds) {
      this.server.to(userRoom(userId)).emit('conversation:updated', { conversationId });
    }
  }
}
