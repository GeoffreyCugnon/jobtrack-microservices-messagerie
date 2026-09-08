import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { MessagingGateway } from './messaging.gateway';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Enregistre la gateway et son limiteur de débit WebSocket. Importe
 * MessagesModule pour que la gateway puisse traiter l'événement entrant
 * `message:send` via MessagesService.
 *
 * Le sens inverse (métier -> diffusion) passe par le bus d'événements interne
 * (@OnEvent dans la gateway), d'où l'absence de dépendance de MessagesModule
 * vers ce module.
 */
@Module({
  imports: [MessagesModule],
  providers: [MessagingGateway, WsRateLimiterService],
})
export class MessagingModule {}
