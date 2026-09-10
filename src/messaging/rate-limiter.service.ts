import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  WS_CONNECT_THROTTLE,
  WS_SEND_THROTTLE,
  WS_TYPING_THROTTLE,
} from '../common/rate-limit.constants';
import { RateLimiter } from '../common/rate-limiter/rate-limiter';
import { RateLimiterFactory } from '../common/rate-limiter/rate-limiter.factory';

/**
 * Rate limiting des vecteurs WebSocket que le throttling REST (HTTP only) ne
 * couvre pas : le handshake de connexion (par IP), l'événement `message:send`
 * (par utilisateur) et l'indicateur `typing:*` (par utilisateur, plus permissif).
 *
 * Backend mémoire ou Redis partagé selon `MESSAGING_REDIS_URL` (via
 * `RateLimiterFactory`). Injectable pour être mockable dans les tests de la gateway.
 */
@Injectable()
export class WsRateLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsRateLimiterService.name);

  private readonly connectLimiter: RateLimiter;
  private readonly sendLimiter: RateLimiter;
  private readonly typingLimiter: RateLimiter;

  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(limiterFactory: RateLimiterFactory) {
    this.connectLimiter = limiterFactory.create(
      'ws-connect',
      WS_CONNECT_THROTTLE.limit,
      WS_CONNECT_THROTTLE.windowMs,
    );
    this.sendLimiter = limiterFactory.create(
      'ws-send',
      WS_SEND_THROTTLE.limit,
      WS_SEND_THROTTLE.windowMs,
    );
    this.typingLimiter = limiterFactory.create(
      'ws-typing',
      WS_TYPING_THROTTLE.limit,
      WS_TYPING_THROTTLE.windowMs,
    );
  }

  onModuleInit(): void {
    // Purge périodique des clés inactives (fenêtre de connexion = la plus large).
    this.sweepTimer = setInterval(() => {
      this.connectLimiter.sweep();
      this.sendLimiter.sweep();
      this.typingLimiter.sweep();
    }, WS_CONNECT_THROTTLE.windowMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  /** `true` = handshake autorisé pour cette IP. */
  async allowConnection(ip: string): Promise<boolean> {
    const allowed = await this.connectLimiter.hit(ip);
    if (!allowed) {
      this.logger.warn(`Connection rate limit hit for ${ip}`);
    }
    return allowed;
  }

  /**
   * `true` = l'envoi est autorisé. Clé = `userId` si présent, sinon `socket:<id>`
   * en repli (ne devrait pas arriver : `handleConnection` rejette les sockets non
   * authentifiées).
   */
  async allowMessage(userId: string | undefined, socketId: string): Promise<boolean> {
    const key = userId ?? `socket:${socketId}`;
    const allowed = await this.sendLimiter.hit(key);
    if (!allowed) {
      this.logger.warn(`message:send rate limit hit for ${key}`);
    }
    return allowed;
  }

  /**
   * `true` = l'événement `typing:*` est relayé. Silencieux au refus (un typing
   * perdu est sans conséquence) : on se contente de ne pas diffuser.
   */
  async allowTyping(userId: string | undefined, socketId: string): Promise<boolean> {
    const key = userId ?? `socket:${socketId}`;
    return this.typingLimiter.hit(key);
  }
}
