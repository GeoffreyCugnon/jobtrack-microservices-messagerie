import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler global appliqué en `APP_GUARD`.
 *
 * `ThrottlerGuard` de `@nestjs/throttler` ne sait raisonner que sur le contexte
 * HTTP (il lit `req.ip`). On court-circuite donc pour tout autre contexte : les
 * handlers `@SubscribeMessage` de la gateway ont leur propre limitation de débit
 * (`SlidingWindowRateLimiter` dans `MessagingGateway`).
 */
@Injectable()
export class RestThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.canActivate(context);
  }
}
