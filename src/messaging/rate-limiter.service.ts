import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WS_CONNECT_THROTTLE, WS_SEND_THROTTLE } from '../common/rate-limit.constants';
import { SlidingWindowRateLimiter } from './ws-rate-limit';

/**
 * Rate limiting des deux vecteurs WebSocket que `ThrottlerGuard` (HTTP only) ne
 * couvre pas : le handshake de connexion (par IP) et l'événement `message:send`
 * (par utilisateur). Injectable pour être mockable dans les tests de la gateway.
 */
@Injectable()
export class WsRateLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsRateLimiterService.name);

  private readonly connectLimiter = new SlidingWindowRateLimiter(
    WS_CONNECT_THROTTLE.limit,
    WS_CONNECT_THROTTLE.windowMs,
  );

  private readonly sendLimiter = new SlidingWindowRateLimiter(
    WS_SEND_THROTTLE.limit,
    WS_SEND_THROTTLE.windowMs,
  );

  private sweepTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    // Purge périodique des clés inactives (fenêtre de connexion = la plus large).
    this.sweepTimer = setInterval(() => {
      this.connectLimiter.sweep();
      this.sendLimiter.sweep();
    }, WS_CONNECT_THROTTLE.windowMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  /** `true` = handshake autorisé pour cette IP. */
  allowConnection(ip: string): boolean {
    const allowed = this.connectLimiter.hit(ip);
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
  allowMessage(userId: string | undefined, socketId: string): boolean {
    const key = userId ?? `socket:${socketId}`;
    const allowed = this.sendLimiter.hit(key);
    if (!allowed) {
      this.logger.warn(`message:send rate limit hit for ${key}`);
    }
    return allowed;
  }
}
