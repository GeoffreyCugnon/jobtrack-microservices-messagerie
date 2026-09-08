import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JSONCodec, NatsConnection } from 'nats';
import { NATS_CONNECTION } from './nats.constants';

/**
 * Encapsule le client NATS pour la publication des événements d'intégration.
 * Appelé par ConversationsService et MessagesService après chaque écriture réussie.
 */
@Injectable()
export class NatsPublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(NatsPublisherService.name);
  /** Encodage JSON des payloads ; les Date sont sérialisées en ISO 8601. */
  private readonly codec = JSONCodec();

  constructor(@Inject(NATS_CONNECTION) private readonly connection: NatsConnection | null) {}

  /**
   * Publie un événement d'intégration sur `subject`.
   *
   * Best-effort : ne relance jamais vers l'appelant et ne bloque pas la
   * transaction métier. Un événement abandonné est loggé, pas rejoué. Retourne
   * une Promise pour que la signature puisse plus tard porter une publication
   * JetStream sans toucher aux appelants.
   *
   * TODO : ajouter une livraison at-least-once (outbox transactionnel + retry) si
   * un consommateur en aval a besoin de garanties plus fortes.
   */
  publish(subject: string, payload: unknown): Promise<void> {
    if (!this.connection) {
      this.logger.warn(`NATS unavailable, dropping event "${subject}"`);
      return Promise.resolve();
    }
    try {
      this.connection.publish(subject, this.codec.encode(payload));
    } catch (err) {
      this.logger.error(`Failed to publish "${subject}": ${(err as Error).message}`);
    }
    return Promise.resolve();
  }

  /** Vide les messages en attente puis ferme la connexion à l'arrêt du service. */
  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
    }
  }
}
