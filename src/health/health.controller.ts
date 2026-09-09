import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { NatsConnection } from 'nats';
import { Public } from '../auth/public.decorator';
import { SkipRateLimit } from '../common/skip-rate-limit.decorator';
import { NATS_CONNECTION } from '../nats/nats.constants';
import { OutboxService } from '../nats/outbox.service';
import { PrismaService } from '../prisma/prisma.service';

type DepStatus = 'ok' | 'down' | 'disabled';

interface HealthReport {
  status: 'ok' | 'degraded';
  database: DepStatus;
  nats: DepStatus;
  /** Événements d'intégration en attente de publication NATS (outbox). */
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
 * rejouée par l'outbox) : c'est reporté dans le corps sans changer le code HTTP.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Inject(NATS_CONNECTION) private readonly nats: NatsConnection | null,
  ) {}

  @Public()
  @SkipRateLimit()
  @Get()
  async check(): Promise<HealthReport> {
    const [database, nats] = await Promise.all([
      this.checkDatabase(),
      Promise.resolve(this.checkNats()),
    ]);
    const report: HealthReport = {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      nats,
      outboxPending: this.outbox.pendingCount,
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

  private checkNats(): DepStatus {
    if (!this.nats) {
      return 'disabled';
    }
    return this.nats.isClosed() ? 'down' : 'ok';
  }
}
