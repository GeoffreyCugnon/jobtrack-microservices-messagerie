import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * @Global : `ConversationsService` et `MessagesService` injectent `AuditService`
 * sans réimporter le module (comme `OutboxService`).
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
