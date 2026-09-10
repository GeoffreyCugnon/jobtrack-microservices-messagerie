import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JSONCodec } from 'nats';
import { OutboxEvent, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NatsConnectionManager } from './nats-connection.manager';

/** Backoff avant chaque nouvelle tentative, en ms. `length` = nombre de retries. */
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000] as const;
/** Fréquence du job de drain. Surchargeable par env. */
const DRAIN_INTERVAL_MS = (() => {
  const n = Number(process.env.MESSAGING_OUTBOX_DRAIN_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
})();
/** Nombre de lignes traitées par passe de drain. */
const DRAIN_BATCH = 100;

/**
 * Outbox **transactionnel durable** pour les événements d'intégration NATS.
 *
 * `enqueueInTx()` insère la ligne `OutboxEvent` dans la MÊME transaction Prisma
 * que l'écriture métier : soit les deux commitent, soit aucun. Un crash entre
 * l'écriture et la publication ne perd donc plus l'événement (l'ancienne file en
 * mémoire, elle, le perdait — cf. CLAUDE.md §0 ter #1).
 *
 * `drain()` (périodique + réveillé par `wake()` après chaque commit) publie les
 * lignes `publishedAt IS NULL` sur NATS, avec retry à backoff exponentiel. Après
 * épuisement des tentatives, la ligne est marquée `failedAt` (inspection
 * manuelle, jamais supprimée). Best-effort de bout en bout : rien ne remonte
 * vers l'écriture métier.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private readonly codec = JSONCodec();
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nats: NatsConnectionManager,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.timer.unref?.();
    void this.drain();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    // Dernière passe pour vider ce qui peut l'être avant l'arrêt.
    await this.drain();
  }

  /**
   * À appeler **dans** une transaction Prisma, juste après l'écriture métier.
   * La ligne d'outbox commit atomiquement avec elle.
   */
  enqueueInTx(
    tx: Prisma.TransactionClient,
    subject: string,
    payload: Prisma.InputJsonValue,
  ): Promise<{ id: string }> {
    return tx.outboxEvent.create({ data: { subject, payload }, select: { id: true } });
  }

  /** Déclenche un drain immédiat (à appeler après le commit). Ne jette jamais. */
  wake(): void {
    void this.drain();
  }

  /** Événements encore en attente de publication (observabilité / `GET /health`). */
  countPending(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null, failedAt: null } });
  }

  async drain(now: Date = new Date()): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      const conn = this.nats.connection;
      if (!conn) {
        return; // NATS injoignable : on retentera au prochain tick
      }

      const batch = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null, failedAt: null, nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: DRAIN_BATCH,
      });
      if (batch.length === 0) {
        return;
      }

      const js = this.nats.jetstream();
      const sent: string[] = [];

      if (js) {
        // JetStream : chaque `publish()` attend l'ACK serveur (persistance dans
        // le stream confirmée). Pas de flush séparé.
        for (const evt of batch) {
          try {
            await js.publish(evt.subject, this.codec.encode(evt.payload));
            sent.push(evt.id);
          } catch (err) {
            await this.reschedule(evt, err);
          }
        }
      } else {
        // Core NATS : `publish()` est fire-and-forget ; un `flush()` global
        // attend l'ack serveur et fait remonter une erreur AVANT le marquage.
        for (const evt of batch) {
          try {
            conn.publish(evt.subject, this.codec.encode(evt.payload));
            sent.push(evt.id);
          } catch (err) {
            await this.reschedule(evt, err);
          }
        }
        if (sent.length > 0) {
          try {
            await conn.flush();
          } catch (err) {
            for (const evt of batch) {
              if (sent.includes(evt.id)) {
                await this.reschedule(evt, err);
              }
            }
            sent.length = 0;
          }
        }
      }

      if (sent.length > 0) {
        try {
          await this.prisma.outboxEvent.updateMany({
            where: { id: { in: sent } },
            data: { publishedAt: new Date(), lastError: null },
          });
        } catch (err) {
          for (const evt of batch) {
            if (sent.includes(evt.id)) {
              await this.reschedule(evt, err);
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`Outbox drain failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async reschedule(evt: OutboxEvent, err: unknown): Promise<void> {
    const attempts = evt.attempts + 1;
    const backoff = RETRY_BACKOFF_MS[attempts - 1];
    const reason = err instanceof Error ? err.message : 'unknown error';

    if (backoff === undefined) {
      await this.prisma.outboxEvent.update({
        where: { id: evt.id },
        data: { attempts, failedAt: new Date(), lastError: reason },
      });
      this.logger.error(
        `Giving up on "${evt.subject}" (${evt.id}) after ${attempts} attempt(s): ${reason}`,
      );
      return;
    }

    await this.prisma.outboxEvent.update({
      where: { id: evt.id },
      data: { attempts, nextAttemptAt: new Date(Date.now() + backoff), lastError: reason },
    });
    this.logger.warn(
      `Publish of "${evt.subject}" failed (${reason}); ` +
        `retry ${attempts}/${RETRY_BACKOFF_MS.length} in ${backoff}ms`,
    );
  }
}
