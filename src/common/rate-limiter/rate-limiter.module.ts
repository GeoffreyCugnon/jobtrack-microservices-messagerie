import { Global, Module } from '@nestjs/common';
import { RateLimiterFactory } from './rate-limiter.factory';

/**
 * @Global : `RateLimiterFactory` est injecté par `RestRateLimitGuard` (APP_GUARD,
 * résolu depuis le module racine) et par `WsRateLimiterService` (MessagingModule).
 */
@Global()
@Module({
  providers: [RateLimiterFactory],
  exports: [RateLimiterFactory],
})
export class RateLimiterModule {}
