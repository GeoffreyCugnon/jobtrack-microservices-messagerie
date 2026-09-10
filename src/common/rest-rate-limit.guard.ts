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
import { RateLimiter } from './rate-limiter/rate-limiter';
import { RateLimiterFactory } from './rate-limiter/rate-limiter.factory';
import { REST_THROTTLE } from './rate-limit.constants';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';

/**
 * Rate limiting REST, enregistré en `APP_GUARD` **avant** `AppAuthGuard` : un
 * flood est rejeté (429) avant même la vérification du JWT.
 *
 * Le backend (mémoire ou Redis partagé) est choisi par `RateLimiterFactory`
 * selon `MESSAGING_REDIS_URL`. Clé de bucket = `req.ip` (dérivé du
 * `X-Forwarded-For` grâce à `app.set('trust proxy', …)` posé dans `main.ts`).
 *
 * No-op hors contexte HTTP : les handlers `@SubscribeMessage` de la gateway ont
 * leur propre limitation (`WsRateLimiterService`).
 */
@Injectable()
export class RestRateLimitGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RestRateLimitGuard.name);
  private readonly limiter: RateLimiter;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly reflector: Reflector,
    limiterFactory: RateLimiterFactory,
  ) {
    this.limiter = limiterFactory.create('rest', REST_THROTTLE.limit, REST_THROTTLE.ttlMs);
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.limiter.sweep(), REST_THROTTLE.ttlMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    if (!(await this.limiter.hit(key))) {
      this.logger.warn(`REST rate limit hit for ${key}`);
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
