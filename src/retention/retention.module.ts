import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

/**
 * Job de purge planifié (`AuditLog` / `OutboxEvent`). `ScheduleModule.forRoot()`
 * est importé une fois dans `AppModule`. `PrismaService` vient du module global.
 */
@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
