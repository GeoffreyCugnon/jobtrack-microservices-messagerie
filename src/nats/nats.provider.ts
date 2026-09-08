import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection } from 'nats';
import { DEFAULT_NATS_URL, NATS_CONNECTION } from './nats.constants';

/**
 * Établit l'unique connexion NATS utilisée pour publier les événements
 * d'intégration.
 *
 * Si NATS est injoignable au démarrage, la factory résout `null` au lieu
 * d'échouer : le service doit continuer à servir le trafic REST/WebSocket même
 * quand le bus d'événements est indisponible. Les événements émis pendant ce
 * temps sont abandonnés (best-effort) jusqu'au prochain redémarrage.
 */
export const natsConnectionProvider: Provider = {
  provide: NATS_CONNECTION,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<NatsConnection | null> => {
    const logger = new Logger('NatsConnection');
    const servers = config.get<string>('MESSAGING_NATS_URL') ?? DEFAULT_NATS_URL;
    try {
      const connection = await connect({ servers, name: 'ms-messagerie' });
      logger.log(`Connected to NATS at ${servers}`);
      return connection;
    } catch (err) {
      logger.warn(
        `Could not connect to NATS at ${servers} (${(err as Error).message}). ` +
          'Integration events will be dropped until the service is restarted.',
      );
      return null;
    }
  },
};
