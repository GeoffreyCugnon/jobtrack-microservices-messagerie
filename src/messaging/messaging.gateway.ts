import { Logger, OnModuleDestroy, OnModuleInit, UsePipes, ValidationPipe } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthUser } from '../auth/auth-user.interface';
import { AuthService } from '../auth/auth.service';
import { extractWsToken } from '../auth/extract-token';
import {
  CONVERSATION_READ,
  MESSAGE_CREATED,
  MESSAGE_READ,
  ConversationReadEvent,
  MessageCreatedEvent,
  MessageReadEvent,
} from '../common/events';
import { corsOriginCheck } from '../common/cors';
import { WS_CONNECT_THROTTLE, WS_SEND_THROTTLE } from '../common/rate-limit.constants';
import { MessagesService } from '../messages/messages.service';
import { WsConversationDto, WsSendMessageDto } from './dto/ws-messages.dto';
import { SlidingWindowRateLimiter } from './ws-rate-limit';

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

/** IP du client à l'origine du handshake (fallback si absente). */
const ipOf = (client: Socket): string =>
  (client.handshake as { address?: string }).address ?? 'unknown';

/**
 * Gateway temps réel (Socket.IO).
 *
 * Deux sens :
 *   - entrant  : `conversation:join` / `conversation:leave` / `message:send` ;
 *   - sortant  : `message:new` / `message:read`, poussés dans la room à la
 *     réception des événements internes émis par MessagesService.
 *
 * CORS Socket.IO : même liste blanche que le CORS HTTP (`corsOriginCheck`,
 * pilotée par `MESSAGING_CORS_ORIGINS`).
 */
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@WebSocketGateway({ cors: { origin: corsOriginCheck } })
export class MessagingGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingGateway.name);

  /** Tentatives de connexion (handshake) par IP. */
  private readonly connectLimiter = new SlidingWindowRateLimiter(
    WS_CONNECT_THROTTLE.limit,
    WS_CONNECT_THROTTLE.windowMs,
  );

  /** Événements `message:send` par utilisateur. */
  private readonly sendLimiter = new SlidingWindowRateLimiter(
    WS_SEND_THROTTLE.limit,
    WS_SEND_THROTTLE.windowMs,
  );

  /** Purge périodique des deux limiteurs (évite la fuite mémoire sur clés inactives). */
  private sweepTimer?: ReturnType<typeof setInterval>;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly authService: AuthService,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    // Fenêtre de connexion = la plus large : suffisant pour purger les deux.
    this.sweepTimer = setInterval(() => {
      this.connectLimiter.sweep();
      this.sendLimiter.sweep();
    }, WS_CONNECT_THROTTLE.windowMs);
    // Ne pas maintenir le process en vie juste pour ce timer.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  /**
   * Les guards ne s'exécutent pas sur l'événement de connexion : on valide donc
   * le JWT du handshake ici et on rejette le socket si besoin.
   */
  handleConnection(client: Socket): void {
    // Rate limit du handshake, par IP : coupe un flood de connexions avant
    // même la vérification JWT.
    if (!this.connectLimiter.hit(ipOf(client))) {
      this.logger.warn(`Rejected socket ${client.id}: connection rate limit for ${ipOf(client)}`);
      client.disconnect(true);
      return;
    }

    try {
      const user = this.authService.verifyToken(extractWsToken(client));
      (client.data as { user?: AuthUser }).user = user;
      // Room personnelle : permet de notifier cet utilisateur hors de toute
      // room de conversation (cf. `broadcastMessageCreated`).
      void client.join(userRoom(user.id));
    } catch (err) {
      this.logger.warn(`Rejected socket ${client.id}: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  // Les handlers @SubscribeMessage sont couverts par le guard global APP_GUARD
  // (AppAuthGuard), qui gère le cas `context.getType() === 'ws'`.

  /** Rejoint la room de la conversation. Réponse : événement `conversation:joined`. */
  @SubscribeMessage('conversation:join')
  join(@ConnectedSocket() client: Socket, @MessageBody() body: WsConversationDto) {
    void client.join(room(body.conversationId));
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
  sendMessage(@ConnectedSocket() client: Socket, @MessageBody() body: WsSendMessageDto) {
    const user = userOf(client);
    if (!user) {
      // Filet de sécurité : ne devrait pas arriver, handleConnection ayant déjà rejeté.
      throw new WsException('Unauthorized');
    }
    if (!this.sendLimiter.hit(user.id)) {
      throw new WsException('Message rate limit exceeded, slow down');
    }
    return this.messages.send(body.conversationId, user.id, {
      content: body.content,
      metadata: body.metadata,
    });
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
