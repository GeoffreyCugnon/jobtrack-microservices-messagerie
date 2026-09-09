import { Global, Module } from '@nestjs/common';
import { NatsConnectionManager } from './nats-connection.manager';
import { OutboxService } from './outbox.service';

/**
 * Possède la connexion NATS (`NatsConnectionManager`) et l'outbox transactionnel
 * (`OutboxService`).
 *
 * NATS sert uniquement au pub/sub sortant vers d'autres micro-services : jamais
 * d'appel requête/réponse de l'hôte vers ce service (ceux-ci restent en REST).
 *
 * @Global : ConversationsService et MessagesService injectent `OutboxService`
 * sans réimporter le module ; `HealthController` injecte les deux.
 */
@Global()
@Module({
  providers: [NatsConnectionManager, OutboxService],
  exports: [NatsConnectionManager, OutboxService],
})
export class NatsModule {}
