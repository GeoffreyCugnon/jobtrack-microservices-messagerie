import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

/**
 * Importe ConversationsModule pour le contrôle d'accès
 * (ConversationsService.getParticipantConversation).
 *
 * Aucune dépendance vers MessagingModule : la diffusion WebSocket passe par le
 * bus d'événements interne, ce qui évite une dépendance circulaire.
 * MessagesService est exporté car la gateway l'appelle pour l'événement `message:send`.
 */
@Module({
  imports: [ConversationsModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
