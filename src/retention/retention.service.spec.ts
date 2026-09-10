import type { PrismaService } from '../prisma/prisma.service';
import { RetentionService } from './retention.service';

/** Premier argument du n-ième appel d'un mock, typé sans passer par `any`. */
function callArg<T>(mock: jest.Mock, callIndex: number): T {
  return (mock.mock.calls as unknown[][])[callIndex][0] as T;
}

/**
 * Purge de rétention : Prisma mocké. On vérifie les fenêtres de coupure
 * (audit / outbox publié = `days`, outbox failed = `failedDays`), l'agrégation
 * des décomptes, et le respect du drapeau de désactivation.
 */
describe('RetentionService', () => {
  const OLD = { ...process.env };

  let prisma: {
    $transaction: jest.Mock;
    auditLog: { deleteMany: jest.Mock };
    outboxEvent: { deleteMany: jest.Mock };
  };

  function build(): RetentionService {
    return new RetentionService(prisma as unknown as PrismaService);
  }

  beforeEach(() => {
    prisma = {
      auditLog: { deleteMany: jest.fn() },
      outboxEvent: { deleteMany: jest.fn() },
      $transaction: jest.fn(),
    };
    // $transaction reçoit un tableau de promesses et renvoie leurs résolutions.
    prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  afterEach(() => {
    process.env = { ...OLD };
  });

  it('deletes rows older than the configured windows and returns the counts', async () => {
    process.env.MESSAGING_RETENTION_DAYS = '30';
    process.env.MESSAGING_RETENTION_FAILED_DAYS = '90';
    prisma.auditLog.deleteMany.mockResolvedValue({ count: 3 });
    prisma.outboxEvent.deleteMany
      .mockResolvedValueOnce({ count: 5 }) // published
      .mockResolvedValueOnce({ count: 1 }); // failed

    const now = new Date('2026-09-10T12:00:00Z');
    const result = await build().purge(now);

    expect(result).toEqual({
      auditLogsDeleted: 3,
      outboxPublishedDeleted: 5,
      outboxFailedDeleted: 1,
    });

    const auditWhere = callArg<{ where: { createdAt: { lt: Date } } }>(
      prisma.auditLog.deleteMany,
      0,
    );
    expect(auditWhere.where.createdAt.lt).toEqual(new Date('2026-08-11T12:00:00Z'));

    const publishedWhere = callArg<{ where: { publishedAt: { lt: Date } } }>(
      prisma.outboxEvent.deleteMany,
      0,
    );
    expect(publishedWhere.where.publishedAt.lt).toEqual(new Date('2026-08-11T12:00:00Z'));

    const failedWhere = callArg<{ where: { failedAt: { lt: Date } } }>(
      prisma.outboxEvent.deleteMany,
      1,
    );
    expect(failedWhere.where.failedAt.lt).toEqual(new Date('2026-06-12T12:00:00Z'));
  });

  it('scheduledPurge does nothing when disabled', async () => {
    process.env.MESSAGING_RETENTION_ENABLED = 'false';

    await build().scheduledPurge();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('scheduledPurge swallows errors (best-effort)', async () => {
    prisma.auditLog.deleteMany.mockRejectedValue(new Error('db gone'));
    prisma.outboxEvent.deleteMany.mockResolvedValue({ count: 0 });

    await expect(build().scheduledPurge()).resolves.toBeUndefined();
  });
});
