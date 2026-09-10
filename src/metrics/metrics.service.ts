import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { OutboxService } from '../nats/outbox.service';

/**
 * Registre Prometheus du service + métriques applicatives. Exposé sur
 * `GET /metrics` (cf. `MetricsController`). Alimenté par `MetricsInterceptor`
 * (HTTP) et par `MessagingGateway` (WebSocket).
 *
 * `outbox_pending_events` est une jauge « pull » : sa valeur est recalculée à
 * chaque scrape via `OutboxService.countPending()` (même source que `/health`).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests: Counter<string>;
  readonly httpDuration: Histogram<string>;
  readonly wsConnections: Gauge<string>;
  readonly wsMessages: Counter<string>;

  constructor(private readonly outbox: OutboxService) {
    // Pas de label `service` ici : c'est le job Prometheus (scrape config) qui
    // porte l'identité de l'instance. Les logs pino, eux, ont déjà `service`.
    collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled, by method / route / status.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.wsConnections = new Gauge({
      name: 'ws_connections_active',
      help: 'Currently open authenticated Socket.IO connections.',
      registers: [this.registry],
    });

    this.wsMessages = new Counter({
      name: 'ws_messages_sent_total',
      help: 'Messages accepted through the WebSocket "message:send" event.',
      registers: [this.registry],
    });

    const outboxRef = this.outbox;
    new Gauge({
      name: 'outbox_pending_events',
      help: 'Integration events written but not yet published to NATS.',
      registers: [this.registry],
      async collect(): Promise<void> {
        try {
          this.set(await outboxRef.countPending());
        } catch {
          /* base lente : on garde la dernière valeur connue plutôt que d'échouer le scrape */
        }
      },
    });
  }

  recordHttp(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, seconds);
  }

  incWsConnection(): void {
    this.wsConnections.inc();
  }

  decWsConnection(): void {
    this.wsConnections.dec();
  }

  incWsMessage(): void {
    this.wsMessages.inc();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
