import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock } };
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('writes an entry with only the provided optional fields', async () => {
    service.log({
      userId: 'u1',
      action: 'message.sent',
      resourceType: 'message',
      resourceId: 'm1',
    });
    await Promise.resolve();

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: { userId: 'u1', action: 'message.sent', resourceType: 'message', resourceId: 'm1' },
    });
  });

  it('never throws when the write fails (best-effort)', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db gone'));
    const errorLog = jest.spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );

    expect(() => service.log({ userId: 'u1', action: 'x' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Failed to write audit'));
  });

  it('clamps the query limit to 200', async () => {
    await service.getUserActivity('u1', 10_000);

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' }, take: 200 }),
    );
  });
});
