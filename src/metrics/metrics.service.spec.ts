import type { OutboxService } from '../nats/outbox.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let outbox: { countPending: jest.Mock };
  let metrics: MetricsService;

  beforeEach(() => {
    outbox = { countPending: jest.fn().mockResolvedValue(7) };
    metrics = new MetricsService(outbox as unknown as OutboxService);
  });

  it('renders the Prometheus exposition with the custom + default metrics', async () => {
    metrics.recordHttp('GET', '/conversations', 200, 0.012);
    metrics.incWsConnection();
    metrics.incWsMessage();

    const body = await metrics.render();

    expect(metrics.contentType).toContain('text/plain');
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('ws_connections_active 1');
    expect(body).toContain('ws_messages_sent_total 1');
    // Jauge « pull » : recalculée au scrape via OutboxService.countPending().
    expect(body).toContain('outbox_pending_events 7');
    expect(outbox.countPending).toHaveBeenCalled();
    // Métriques process par défaut.
    expect(body).toContain('process_cpu_user_seconds_total');
  });

  it('decWsConnection brings the gauge back down', async () => {
    metrics.incWsConnection();
    metrics.incWsConnection();
    metrics.decWsConnection();
    const body = await metrics.render();
    expect(body).toContain('ws_connections_active 1');
  });
});
