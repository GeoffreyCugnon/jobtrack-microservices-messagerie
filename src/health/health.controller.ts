import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { NatsConnection } from 'nats';
import { Public } from '../auth/public.decorator';
import { NATS_CONNECTION } from '../nats/nats.constants';
import { PrismaService } from '../prisma/prisma.service';

type DepStatus = 'ok' | 'down' | 'disabled';

interface HealthReport {
  status: 'ok' | 'degraded';
  database: DepStatus;
  nats: DepStatus;
}

/** Course entre une promesse et un timeout ; rejette si `ms` est dépassé. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.()),
  ]);
}

/**
 * `GET /health` — sonde de liveness/readiness. Publique (pas de JWT) et exclue du
 * rate limiting. Ne bloque jamais plus d'une seconde par dépendance.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NATS_CONNECTION) private readonly nats: NatsConnection | null,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check(): Promise<HealthReport> {
    const [database, nats] = await Promise.all([
      this.checkDatabase(),
      Promise.resolve(this.checkNats()),
    ]);
    return { status: database === 'ok' ? 'ok' : 'degraded', database, nats };
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
