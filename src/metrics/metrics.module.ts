import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * @Global : `MetricsService` est injecté par `MetricsInterceptor` (APP_INTERCEPTOR,
 * résolu depuis le module racine) et par `MessagingGateway` (métriques WS).
 * `OutboxService` (jauge `outbox_pending_events`) vient du `NatsModule` global.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
