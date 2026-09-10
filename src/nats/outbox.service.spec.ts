import type { NatsConnection } from 'nats';
import type { PrismaService } from '../prisma/prisma.service';
import type { NatsConnectionManager } from './nats-connection.manager';
import { OutboxService } from './outbox.service';

/** Premier argument du premier appel d'un mock, typé sans passer par `any`. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown[][])[0][0] as T;
}

/**
 * OutboxService durable : Prisma et NatsConnectionManager mockés. On vérifie le
 * drain (publish + flush + marquage), le no-op quand NATS est down, le retry à
 * backoff, l'abandon après épuisement, et le best-effort (rien ne remonte).
 */
describe('OutboxService', () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'evt-1',
    subject: 'messaging.message.created',
    payload: { messageId: 'm1' },
    attempts: 0,
    publishedAt: null,
    nextAttemptAt: new Date('2026-09-09T10:00:00Z'),
    failedAt: null,
    lastError: null,
    createdAt: new Date('2026-09-09T10:00:00Z'),
    ...over,
  });

  let prisma: {
    outboxEvent: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };
  let conn: { publish: jest.Mock; flush: jest.Mock };
  let manager: { connection: NatsConnection | null; jetstream: jest.Mock };
  let outbox: OutboxService;

  beforeEach(() => {
    prisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    conn = { publish: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    // Par défaut : JetStream désactivé → chemin core NATS (publish + flush).
    manager = {
      connection: conn as unknown as NatsConnection,
      jetstream: jest.fn().mockReturnValue(null),
    };
    outbox = new OutboxService(
      prisma as unknown as PrismaService,
      manager as unknown as NatsConnectionManager,
    );
  });

  it('publishes pending rows, flushes, then marks them published', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    await outbox.drain();

    expect(conn.publish).toHaveBeenCalledTimes(2);
    expect(conn.flush).toHaveBeenCalledTimes(1);
    const args = firstArg<{ where: unknown; data: { publishedAt: unknown; lastError: unknown } }>(
      prisma.outboxEvent.updateMany,
    );
    expect(args.where).toEqual({ id: { in: ['a', 'b'] } });
    expect(args.data.publishedAt).toBeInstanceOf(Date);
    expect(args.data.lastError).toBeNull();
  });

  it('is a no-op when NATS is unavailable (nothing published, nothing failed)', async () => {
    manager.connection = null;
    prisma.outboxEvent.findMany.mockResolvedValue([row()]);

    await outbox.drain();

    expect(conn.publish).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('reschedules with backoff when publish throws, without marking published', async () => {
    conn.publish.mockImplementation(() => {
      throw new Error('nats down');
    });
    prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a', attempts: 0 })]);

    await outbox.drain();

    const args = firstArg<{ where: unknown; data: { attempts: unknown; nextAttemptAt: unknown } }>(
      prisma.outboxEvent.update,
    );
    expect(args.where).toEqual({ id: 'a' });
    expect(args.data.attempts).toBe(1);
    expect(args.data.nextAttemptAt).toBeInstanceOf(Date);
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('marks the row failed once the retry budget is exhausted', async () => {
    conn.publish.mockImplementation(() => {
      throw new Error('still down');
    });
    // 5 backoff steps -> attempts 5 already means the next failure is terminal.
    prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a', attempts: 5 })]);
    const errorLog = jest.spyOn(
      (outbox as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );

    await outbox.drain();

    const args = firstArg<{ where: unknown; data: { attempts: unknown; failedAt: unknown } }>(
      prisma.outboxEvent.update,
    );
    expect(args.where).toEqual({ id: 'a' });
    expect(args.data.attempts).toBe(6);
    expect(args.data.failedAt).toBeInstanceOf(Date);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Giving up'));
  });

  it('reschedules the whole batch when flush() rejects after publish', async () => {
    conn.flush.mockRejectedValue(new Error('flush timeout'));
    prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    await outbox.drain();

    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.update).toHaveBeenCalledTimes(2);
  });

  describe('JetStream mode', () => {
    it('publishes each row via js.publish (awaiting the ACK) and marks them, no flush', async () => {
      const js = { publish: jest.fn().mockResolvedValue({ seq: 1 }) };
      manager.jetstream.mockReturnValue(js);
      prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

      await outbox.drain();

      expect(js.publish).toHaveBeenCalledTimes(2);
      expect(conn.publish).not.toHaveBeenCalled();
      expect(conn.flush).not.toHaveBeenCalled();
      const args = firstArg<{ where: unknown }>(prisma.outboxEvent.updateMany);
      expect(args.where).toEqual({ id: { in: ['a', 'b'] } });
    });

    it('reschedules only the row whose js.publish rejected', async () => {
      const js = {
        publish: jest
          .fn()
          .mockResolvedValueOnce({ seq: 1 })
          .mockRejectedValueOnce(new Error('no stream')),
      };
      manager.jetstream.mockReturnValue(js);
      prisma.outboxEvent.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

      await outbox.drain();

      expect(prisma.outboxEvent.update).toHaveBeenCalledTimes(1);
      const args = firstArg<{ where: { id: string } }>(prisma.outboxEvent.update);
      expect(args.where).toEqual({ id: 'b' });
      const marked = firstArg<{ where: { id: { in: string[] } } }>(prisma.outboxEvent.updateMany);
      expect(marked.where).toEqual({ id: { in: ['a'] } });
    });
  });

  it('wake() never throws to the caller', () => {
    prisma.outboxEvent.findMany.mockRejectedValue(new Error('db gone'));
    expect(() => outbox.wake()).not.toThrow();
  });

  it('enqueueInTx writes the row through the transaction client', async () => {
    const tx = { outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-9' }) } };

    await outbox.enqueueInTx(tx as never, 'messaging.message.created', {
      messageId: 'm1',
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: { subject: 'messaging.message.created', payload: { messageId: 'm1' } },
      select: { id: true },
    });
  });

  it('countPending queries only unpublished, non-failed rows', async () => {
    prisma.outboxEvent.count.mockResolvedValue(4);

    await expect(outbox.countPending()).resolves.toBe(4);
    expect(prisma.outboxEvent.count).toHaveBeenCalledWith({
      where: { publishedAt: null, failedAt: null },
    });
  });
});
