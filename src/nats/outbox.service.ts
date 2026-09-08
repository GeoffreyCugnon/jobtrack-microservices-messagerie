import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JSONCodec, NatsConnection } from 'nats';
import { NATS_CONNECTION } from './nats.constants';

/** Backoff avant chaque nouvelle tentative, en ms (1 s → 5 s → 30 s). */
const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
/** Tentatives totales : 1 immédiate + `RETRY_BACKOFF_MS.length` retries. */
const MAX_ATTEMPTS = 1 + RETRY_BACKOFF_MS.length;
/** Fréquence du job qui rejoue les entrées dont l'échéance de retry est atteinte. */
const DRAIN_INTERVAL_MS = 30_000;
/** Garde-fou mémoire : au-delà, on abandonne les nouveaux événements. */
const MAX_PENDING = 10_000;

interface OutboxEntry {
  id: number;
  subject: string;
  payload: unknown;
  attempts: number;
  /** Timestamp (ms) à partir duquel la prochaine tentative est permise. */
  nextAttemptAt: number;
}

/**
 * File de sortie des événements d'intégration NATS, avec retry à backoff
 * exponentiel.
 *
 * Chaque événement est mis en file puis publié immédiatement ; en cas d'échec
 * (broker injoignable ou erreur de publication) il reste en file et est rejoué
 * par `drain()` jusqu'à `MAX_ATTEMPTS`, après quoi il est abandonné (loggé).
 *
 * ⚠️ File **en mémoire** : un crash du process perd les événements non publiés.
 * Une durabilité stricte (table `OutboxEvent` écrite dans la même transaction
 * Prisma que le message) reste un chantier Phase 3 — cf. CLAUDE.md §2.5.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private readonly codec = JSONCodec();
  private readonly pending = new Map<number, OutboxEntry>();
  private seq = 0;
  private drainTimer?: ReturnType<typeof setInterval>;

  constructor(@Inject(NATS_CONNECTION) private readonly connection: NatsConnection | null) {}

  onModuleInit(): void {
    this.drainTimer = setInterval(() => this.drain(), DRAIN_INTERVAL_MS);
    // Ne pas maintenir le process en vie juste pour ce timer.
    this.drainTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
    }
    // Dernière tentative synchrone puis fermeture propre de la connexion.
    this.drain();
    if (this.connection) {
      await this.connection.drain();
    }
  }

  /** Nombre d'événements encore en attente de publication (observabilité / tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Enfile un événement et tente une publication immédiate. Ne relance jamais
   * vers l'appelant (best-effort) : l'écriture métier ne doit pas dépendre de NATS.
   */
  enqueue(subject: string, payload: unknown): void {
    if (this.pending.size >= MAX_PENDING) {
      this.logger.error(`Outbox full (${MAX_PENDING} pending), dropping "${subject}"`);
      return;
    }
    const entry: OutboxEntry = {
      id: ++this.seq,
      subject,
      payload,
      attempts: 0,
      nextAttemptAt: 0,
    };
    this.pending.set(entry.id, entry);
    this.tryPublish(entry);
  }

  /** Rejoue les entrées dont l'échéance de retry est atteinte. */
  drain(now: number = Date.now()): void {
    for (const entry of this.pending.values()) {
      if (entry.nextAttemptAt <= now) {
        this.tryPublish(entry, now);
      }
    }
  }

  private tryPublish(entry: OutboxEntry, now: number = Date.now()): void {
    entry.attempts += 1;

    if (!this.connection) {
      this.scheduleOrDrop(entry, now, 'NATS unavailable');
      return;
    }
    try {
      this.connection.publish(entry.subject, this.codec.encode(entry.payload));
      this.pending.delete(entry.id);
    } catch (err) {
      this.scheduleOrDrop(entry, now, err instanceof Error ? err.message : 'unknown error');
    }
  }

  private scheduleOrDrop(entry: OutboxEntry, now: number, reason: string): void {
    const backoff = RETRY_BACKOFF_MS[entry.attempts - 1];
    if (backoff === undefined) {
      this.pending.delete(entry.id);
      this.logger.error(
        `Giving up on "${entry.subject}" after ${entry.attempts} attempt(s): ${reason}`,
      );
      return;
    }
    entry.nextAttemptAt = now + backoff;
    this.logger.warn(
      `Publish of "${entry.subject}" failed (${reason}); ` +
        `retry ${entry.attempts}/${MAX_ATTEMPTS - 1} scheduled in ${backoff}ms`,
    );
  }
}
