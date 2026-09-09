import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REST_THROTTLE } from './rate-limit.constants';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';
import { SlidingWindowRateLimiter } from '../messaging/ws-rate-limit';

/**
 * Rate limiting REST, enregistré en `APP_GUARD` **avant** `AppAuthGuard` : un
 * flood est rejeté (429) avant même la vérification du JWT.
 *
 * Remplace `@nestjs/throttler` (qui n'avait pas encore de version compatible
 * NestJS 12) en réutilisant le `SlidingWindowRateLimiter` déjà en place pour le
 * WebSocket — même algo, une seule implémentation à tester, aucune dépendance.
 *
 * Clé de bucket = `req.ip`. Avec `app.set('trust proxy', …)` posé dans `main.ts`,
 * Express dérive `req.ip` du `X-Forwarded-For` : derrière un reverse proxy, la
 * limite s'applique donc bien par client final et non par IP de proxy.
 *
 * No-op hors contexte HTTP : les handlers `@SubscribeMessage` de la gateway ont
 * leur propre limitation (`WsRateLimiterService`).
 */
@Injectable()
export class RestRateLimitGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RestRateLimitGuard.name);
  private readonly limiter = new SlidingWindowRateLimiter(REST_THROTTLE.limit, REST_THROTTLE.ttlMs);
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly reflector: Reflector) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.limiter.sweep(), REST_THROTTLE.ttlMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ ip?: string; socket?: { remoteAddress?: string } }>();
    const key = request.ip ?? request.socket?.remoteAddress ?? 'unknown';

    if (!this.limiter.hit(key)) {
      this.logger.warn(`REST rate limit hit for ${key}`);
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
