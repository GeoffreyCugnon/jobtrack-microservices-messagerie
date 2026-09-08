import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Expose `GET /health`. PrismaService (global) et NATS_CONNECTION (exporté par
 * NatsModule, global) sont injectés directement dans le contrôleur.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
