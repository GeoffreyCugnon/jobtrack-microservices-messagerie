import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MemoryRateLimiter, RateLimiter, RedisRateLimiter } from './rate-limiter';

/**
 * Fabrique de limiteurs. Choisit le backend une fois au démarrage :
 *  - `MESSAGING_REDIS_URL` défini → `RedisRateLimiter` (buckets partagés entre
 *    instances) ;
 *  - sinon → `MemoryRateLimiter` (comportement historique, instance unique).
 *
 * La connexion Redis est unique et partagée par tous les limiteurs créés, et
 * fermée à l'arrêt du module.
 */
@Injectable()
export class RateLimiterFactory implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterFactory.name);
  private readonly redis: Redis | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('MESSAGING_REDIS_URL')?.trim();
    if (url) {
      this.redis = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        // Ne pas faire tomber le process si Redis est momentanément indisponible.
        enableOfflineQueue: true,
      });
      this.redis.on('error', (err: Error) => this.logger.warn(`Redis error: ${err.message}`));
      this.logger.log('Rate limiting backend: Redis (shared across instances)');
    } else {
      this.redis = null;
      this.logger.log('Rate limiting backend: in-memory (single instance)');
    }
  }

  /** `name` sert de préfixe de clé Redis (`rest`, `ws-connect`, `ws-send`, `ws-typing`). */
  create(name: string, limit: number, windowMs: number): RateLimiter {
    return this.redis
      ? new RedisRateLimiter(this.redis, limit, windowMs, name)
      : new MemoryRateLimiter(limit, windowMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => this.redis?.disconnect());
    }
  }
}
