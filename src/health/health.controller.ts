import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { SkipRateLimit } from '../common/skip-rate-limit.decorator';
import { NatsConnectionManager } from '../nats/nats-connection.manager';
import { OutboxService } from '../nats/outbox.service';
import { PrismaService } from '../prisma/prisma.service';

type DepStatus = 'ok' | 'down';

interface HealthReport {
  status: 'ok' | 'degraded';
  database: DepStatus;
  nats: DepStatus;
  /** Événements d'intégration en attente de publication NATS (outbox durable). */
  outboxPending: number;
}

/** Course entre une promesse et un timeout ; rejette si `ms` est dépassé. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `GET /health` — sonde de liveness/readiness. Publique (pas de JWT) et exclue du
 * rate limiting. Ne bloque jamais plus d'une seconde par dépendance.
 *
 * Renvoie **503** dès que la base est injoignable (`status: 'degraded'`), pour
 * être exploitable comme *readiness probe* : un simple 200 « dégradé » laissait
 * l'orchestrateur router du trafic vers une instance incapable de servir.
 * NATS injoignable ne fait **pas** échouer la sonde (publication best-effort,
 * rejouée par l'outbox durable) : reporté dans le corps sans changer le code HTTP.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly nats: NatsConnectionManager,
  ) {}

  @Public()
  @SkipRateLimit()
  @Get()
  async check(): Promise<HealthReport> {
    const [database, outboxPending] = await Promise.all([this.checkDatabase(), this.checkOutbox()]);
    const report: HealthReport = {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      nats: this.nats.status,
      outboxPending,
    };
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  private async checkDatabase(): Promise<DepStatus> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, 1000);
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async checkOutbox(): Promise<number> {
    try {
      return await withTimeout(this.outbox.countPending(), 1000);
    } catch {
      return -1; // sonde indisponible (base lente) : -1 plutôt que de faire échouer /health
    }
  }
}
