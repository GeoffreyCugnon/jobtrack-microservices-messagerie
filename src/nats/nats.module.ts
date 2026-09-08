import { Global, Module } from '@nestjs/common';
import { NatsPublisherService } from './nats-publisher.service';
import { NATS_CONNECTION } from './nats.constants';
import { natsConnectionProvider } from './nats.provider';
import { OutboxService } from './outbox.service';

/**
 * Possède la connexion NATS et expose NatsPublisherService.
 *
 * NATS sert uniquement au pub/sub sortant vers d'autres micro-services : il n'est
 * jamais utilisé pour des appels requête/réponse de l'application hôte vers ce
 * service (ceux-ci restent en REST).
 *
 * @Global pour que ConversationsService et MessagesService y accèdent sans
 * réimporter le module.
 */
@Global()
@Module({
  providers: [natsConnectionProvider, OutboxService, NatsPublisherService],
  // NATS_CONNECTION est exporté pour le healthcheck (GET /health).
  exports: [NatsPublisherService, NATS_CONNECTION],
})
export class NatsModule {}
