import type { NatsConnection } from 'nats';
import { OutboxService } from './outbox.service';

/**
 * OutboxService avec une connexion NATS mockée : publication immédiate, retry à
 * backoff, abandon après le nombre max de tentatives, et best-effort (aucune
 * exception ne remonte à l'appelant).
 */
describe('OutboxService', () => {
  const subject = 'messaging.message.created';
  const payload = { messageId: 'm1' };

  function makeConn(): { publish: jest.Mock; drain: jest.Mock } {
    return { publish: jest.fn(), drain: jest.fn().mockResolvedValue(undefined) };
  }

  it('publishes immediately and leaves nothing pending on success', () => {
    const conn = makeConn();
    const outbox = new OutboxService(conn as unknown as NatsConnection);

    outbox.enqueue(subject, payload);

    expect(conn.publish).toHaveBeenCalledTimes(1);
    expect(conn.publish).toHaveBeenCalledWith(subject, expect.anything());
    expect(outbox.pendingCount).toBe(0);
  });

  it('keeps the event pending when the immediate publish throws, then retries on drain', () => {
    const conn = makeConn();
    conn.publish.mockImplementationOnce(() => {
      throw new Error('nats down');
    });
    const outbox = new OutboxService(conn as unknown as NatsConnection);
    const t0 = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);

    outbox.enqueue(subject, payload);
    expect(outbox.pendingCount).toBe(1);

    // Avant l'échéance de retry (backoff 1s) : rien.
    outbox.drain(t0 + 500);
    expect(conn.publish).toHaveBeenCalledTimes(1);

    // Après l'échéance : re-tentative, cette fois le mock réussit.
    outbox.drain(t0 + 1_500);
    expect(conn.publish).toHaveBeenCalledTimes(2);
    expect(outbox.pendingCount).toBe(0);

    (Date.now as jest.Mock).mockRestore();
  });

  it('gives up after the maximum number of attempts (connection unavailable)', () => {
    const outbox = new OutboxService(null);
    const errorLog = jest.spyOn(
      (outbox as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );
    const t0 = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);

    outbox.enqueue(subject, payload); // attempt 1 -> backoff 1s
    expect(outbox.pendingCount).toBe(1);

    outbox.drain(t0 + 1_001); // attempt 2 -> backoff 5s
    outbox.drain(t0 + 6_002); // attempt 3 -> backoff 30s
    outbox.drain(t0 + 36_003); // attempt 4 -> no backoff left -> drop

    expect(outbox.pendingCount).toBe(0);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Giving up'));

    (Date.now as jest.Mock).mockRestore();
  });

  it('never throws to the caller even if publish blows up (best-effort)', () => {
    const conn = makeConn();
    conn.publish.mockImplementation(() => {
      throw new Error('boom');
    });
    const outbox = new OutboxService(conn as unknown as NatsConnection);

    expect(() => outbox.enqueue(subject, payload)).not.toThrow();
    expect(outbox.pendingCount).toBe(1);
  });

  it('drains the NATS connection on shutdown', async () => {
    const conn = makeConn();
    const outbox = new OutboxService(conn as unknown as NatsConnection);
    outbox.onModuleInit();

    await outbox.onModuleDestroy();

    expect(conn.drain).toHaveBeenCalledTimes(1);
  });
});
