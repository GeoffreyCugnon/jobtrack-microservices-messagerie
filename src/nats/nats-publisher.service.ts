import { Injectable } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Façade de publication des événements d'intégration, appelée par
 * ConversationsService et MessagesService après chaque écriture réussie.
 *
 * Délègue à `OutboxService`, qui met l'événement en file, tente une publication
 * immédiate et rejoue avec backoff en cas d'échec. Best-effort : ne relance
 * jamais vers l'appelant, ne bloque pas la transaction métier. La Promise
 * retournée permet de garder les `await` existants côté services et pourra
 * porter une publication JetStream sans toucher aux appelants.
 */
@Injectable()
export class NatsPublisherService {
  constructor(private readonly outbox: OutboxService) {}

  publish(subject: string, payload: unknown): Promise<void> {
    this.outbox.enqueue(subject, payload);
    return Promise.resolve();
  }
}
