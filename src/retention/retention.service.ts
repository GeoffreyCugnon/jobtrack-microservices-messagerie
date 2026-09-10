import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Entier > 0 depuis l'env, sinon `dflt`. */
function positiveInt(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

interface RetentionResult {
  auditLogsDeleted: number;
  outboxPublishedDeleted: number;
  outboxFailedDeleted: number;
}

/**
 * Purge planifiée des tables append-only qui, sinon, croissent sans borne :
 *
 *  - `AuditLog` : supprimé au-delà de `MESSAGING_RETENTION_DAYS` (défaut 90).
 *  - `OutboxEvent` **publié** : idem (l'événement a été livré, la ligne n'est
 *    plus qu'un historique).
 *  - `OutboxEvent` **failed** : conservé plus longtemps
 *    (`MESSAGING_RETENTION_FAILED_DAYS`, défaut 180) — c'est une piste d'incident.
 *
 * Désactivable via `MESSAGING_RETENTION_ENABLED=false`. Best-effort : une erreur
 * est journalisée, jamais propagée (le job retentera le lendemain).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  private readonly enabled =
    process.env.MESSAGING_RETENTION_ENABLED?.trim().toLowerCase() !== 'false';
  private readonly days = positiveInt(process.env.MESSAGING_RETENTION_DAYS, 90);
  private readonly failedDays = positiveInt(process.env.MESSAGING_RETENTION_FAILED_DAYS, 180);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'retention-purge' })
  async scheduledPurge(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      const result = await this.purge();
      this.logger.log(
        `Retention purge: ${result.auditLogsDeleted} audit log(s), ` +
          `${result.outboxPublishedDeleted} published + ${result.outboxFailedDeleted} failed outbox row(s)`,
      );
    } catch (err) {
      this.logger.error(`Retention purge failed: ${(err as Error).message}`);
    }
  }

  /** Exécute la purge une fois et renvoie les décomptes. Exposé pour l'exploitation / les tests. */
  async purge(now: Date = new Date()): Promise<RetentionResult> {
    const cutoff = new Date(now.getTime() - this.days * DAY_MS);
    const failedCutoff = new Date(now.getTime() - this.failedDays * DAY_MS);

    // `{ lt: date }` sur une colonne nullable exclut déjà les NULL : une ligne
    // encore en attente (publishedAt / failedAt NULL) n'est jamais purgée.
    const [audit, published, failed] = await this.prisma.$transaction([
      this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.outboxEvent.deleteMany({ where: { publishedAt: { lt: cutoff } } }),
      this.prisma.outboxEvent.deleteMany({ where: { failedAt: { lt: failedCutoff } } }),
    ]);

    return {
      auditLogsDeleted: audit.count,
      outboxPublishedDeleted: published.count,
      outboxFailedDeleted: failed.count,
    };
  }
}
