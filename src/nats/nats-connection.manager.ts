import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection } from 'nats';
import { DEFAULT_NATS_URL } from './nats.constants';

/** Intervalle de re-tentative quand NATS était injoignable au démarrage. */
const RECONNECT_PROBE_MS = 10_000;

/**
 * Propriétaire de l'unique connexion NATS.
 *
 * Corrige le défaut de l'ancien provider (`natsConnectionProvider`) qui, sur
 * échec de `connect()` au démarrage, renvoyait `null` **définitivement** — même
 * si le broker revenait ensuite.
 *
 * Ici :
 *   - `connect()` est non bloquant (le service sert REST/WS même sans NATS) ;
 *   - une fois connecté, `{ reconnect: true, maxReconnectAttempts: -1 }` laisse
 *     la lib nats se reconnecter indéfiniment ;
 *   - si le tout premier `connect()` échoue, un timer re-tente toutes les
 *     `RECONNECT_PROBE_MS` jusqu'à réussir.
 *
 * Les consommateurs (`OutboxService`, `HealthController`) lisent `connection` à
 * chaque usage — jamais une référence capturée une fois pour toutes.
 */
@Injectable()
export class NatsConnectionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsConnectionManager.name);
  private readonly servers: string;
  private conn: NatsConnection | null = null;
  private connecting = false;
  private stopped = false;
  private probeTimer?: ReturnType<typeof setInterval>;

  constructor(config: ConfigService) {
    this.servers = config.get<string>('MESSAGING_NATS_URL') ?? DEFAULT_NATS_URL;
  }

  onModuleInit(): void {
    void this.tryConnect();
    this.probeTimer = setInterval(() => {
      if (!this.conn && !this.connecting && !this.stopped) {
        void this.tryConnect();
      }
    }, RECONNECT_PROBE_MS);
    this.probeTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
    }
    const conn = this.conn;
    this.conn = null;
    if (conn && !conn.isClosed()) {
      try {
        await conn.drain();
      } catch {
        /* fermeture best-effort */
      }
    }
  }

  /** Connexion utilisable, ou `null` tant que NATS n'a pas (encore) été joint. */
  get connection(): NatsConnection | null {
    return this.conn && !this.conn.isClosed() ? this.conn : null;
  }

  /** Pour `GET /health`. `disabled` n'existe plus : on retente toujours. */
  get status(): 'ok' | 'down' {
    return this.connection ? 'ok' : 'down';
  }

  private async tryConnect(): Promise<void> {
    if (this.connecting || this.conn || this.stopped) {
      return;
    }
    this.connecting = true;
    try {
      const conn = await connect({
        servers: this.servers,
        name: 'ms-messagerie',
        reconnect: true,
        maxReconnectAttempts: -1,
        waitOnFirstConnect: false,
      });
      this.conn = conn;
      this.logger.log(`Connected to NATS at ${this.servers}`);
      void conn.closed().then((err?: void | Error) => {
        if (this.conn === conn) {
          this.conn = null;
        }
        this.logger.warn(
          `NATS connection closed${err instanceof Error ? `: ${err.message}` : ''}` +
            (this.stopped ? '' : '; will re-probe'),
        );
      });
    } catch (err) {
      this.logger.warn(
        `NATS unreachable at ${this.servers} (${(err as Error).message}); ` +
          `retrying every ${RECONNECT_PROBE_MS}ms`,
      );
    } finally {
      this.connecting = false;
    }
  }
}
