import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { MessagingGateway } from './messaging.gateway';
import { PresenceService } from './presence.service';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Enregistre la gateway, son limiteur de débit WebSocket et le suivi de
 * présence. Importe MessagesModule pour traiter l'événement entrant
 * `message:send` via MessagesService, et ConversationsModule pour résoudre les
 * interlocuteurs d'un utilisateur (diffusion de la présence).
 *
 * Le sens inverse (métier -> diffusion) passe par le bus d'événements interne
 * (@OnEvent dans la gateway), d'où l'absence de dépendance de MessagesModule
 * vers ce module.
 */
@Module({
  imports: [MessagesModule, ConversationsModule],
  providers: [MessagingGateway, WsRateLimiterService, PresenceService],
})
export class MessagingModule {}
