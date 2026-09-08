import { Global, Module } from '@nestjs/common';
import { NatsPublisherService } from './nats-publisher.service';
import { natsConnectionProvider } from './nats.provider';

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
  providers: [natsConnectionProvider, NatsPublisherService],
  exports: [NatsPublisherService],
})
export class NatsModule {}
