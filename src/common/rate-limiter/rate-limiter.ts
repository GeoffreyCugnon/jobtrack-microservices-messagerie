import { SlidingWindowRateLimiter } from '../../messaging/ws-rate-limit';
import type Redis from 'ioredis';

/**
 * Limiteur de débit — abstraction commune au throttling REST et WebSocket.
 *
 * `hit()` est asynchrone pour couvrir le backend Redis (multi-instances). Le
 * backend mémoire reste le défaut (instance isolée par projet hôte, cf.
 * CLAUDE.md) ; Redis n'est utilisé que si `MESSAGING_REDIS_URL` est défini.
 */
export interface RateLimiter {
  /**
   * Enregistre une tentative pour `key`. `true` si elle est dans le quota,
   * `false` si le quota est déjà atteint (dans ce cas la tentative refusée
   * n'est pas comptée, pour ne pas prolonger le blocage).
   */
  hit(key: string): Promise<boolean>;
  /** Purge des clés inactives (backend mémoire). No-op côté Redis (TTL natif). */
  sweep(): void;
}

/** Backend mémoire : fenêtre glissante exacte, sans dépendance. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly inner: SlidingWindowRateLimiter;

  constructor(limit: number, windowMs: number) {
    this.inner = new SlidingWindowRateLimiter(limit, windowMs);
  }

  hit(key: string): Promise<boolean> {
    return Promise.resolve(this.inner.hit(key));
  }

  sweep(): void {
    this.inner.sweep();
  }
}

/**
 * Backend Redis : compteur à **fenêtre fixe** (`INCR` + `PEXPIRE`), atomique et
 * sans script Lua. Sémantique légèrement différente de la fenêtre glissante
 * mémoire (une rafale peut chevaucher deux fenêtres), acceptable pour de la
 * protection anti-flood. Partagé par toutes les instances derrière le LB.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly prefix: string,
  ) {}

  async hit(key: string): Promise<boolean> {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const redisKey = `ratelimit:${this.prefix}:${key}:${bucket}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      // TTL = 2 fenêtres : couvre le décalage d'horloge entre instances.
      await this.redis.pexpire(redisKey, this.windowMs * 2);
    }
    return count <= this.limit;
  }

  sweep(): void {
    /* Redis expire les clés tout seul. */
  }
}
