import { Injectable, Logger } from '@nestjs/common';
import { AuditLog, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  /** Acteur (claim `sub`), ou `system`. */
  userId: string;
  /** Verbe métier, ex. `message.sent`. */
  action: string;
  resourceType?: 'conversation' | 'message';
  resourceId?: string;
  /** Contexte non sensible — jamais le contenu d'un message. */
  details?: Prisma.InputJsonValue;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const clamp = (n: number | undefined): number =>
  Math.min(Math.max(Math.trunc(n ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);

/**
 * Journal d'audit **best-effort** : `log()` n'attend pas l'écriture et n'échoue
 * jamais l'opération appelante (une panne d'audit ne doit pas casser un envoi de
 * message). Aucune route de lecture n'est exposée pour l'instant — les méthodes
 * `getXxx` servent à l'exploitation (script, console) et aux tests.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Enregistre une entrée d'audit sans bloquer l'appelant. */
  log(entry: AuditEntry): void {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      userId: entry.userId,
      action: entry.action,
    };
    if (entry.resourceType) {
      data.resourceType = entry.resourceType;
    }
    if (entry.resourceId) {
      data.resourceId = entry.resourceId;
    }
    if (entry.details !== undefined) {
      data.details = entry.details;
    }
    void this.prisma.auditLog.create({ data }).catch((err: unknown) => {
      this.logger.error(
        `Failed to write audit "${entry.action}": ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });
  }

  getUserActivity(userId: string, limit?: number): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: clamp(limit),
    });
  }

  getResourceActivity(
    resourceType: AuditEntry['resourceType'],
    resourceId: string,
    limit?: number,
  ): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { resourceType, resourceId },
      orderBy: { createdAt: 'desc' },
      take: clamp(limit),
    });
  }

  getByAction(action: string, limit?: number): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: clamp(limit),
    });
  }
}
