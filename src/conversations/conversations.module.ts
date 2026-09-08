import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/**
 * ConversationsService est exporté car MessagesModule le réutilise
 * (getParticipantConversation sert de contrôle d'accès aux messages).
 */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
