import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Expose `GET /health`. PrismaService (global) ainsi que NatsConnectionManager et
 * OutboxService (exportés par NatsModule, global) sont injectés directement dans
 * le contrôleur.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
