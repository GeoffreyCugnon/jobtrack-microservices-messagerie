import type { ConfigService } from '@nestjs/config';
import { connect } from 'nats';
import { NatsConnectionManager } from './nats-connection.manager';

jest.mock('nats', () => ({
  connect: jest.fn(),
  JSONCodec: jest.fn(),
}));

const connectMock = connect as jest.MockedFunction<typeof connect>;

describe('NatsConnectionManager', () => {
  const config = { get: jest.fn().mockReturnValue('nats://localhost:4222') };
  const makeConn = () => {
    let resolveClosed: (v?: void | Error) => void = () => {};
    return {
      isClosed: jest.fn().mockReturnValue(false),
      drain: jest.fn().mockResolvedValue(undefined),
      closed: jest.fn().mockReturnValue(new Promise<void | Error>((r) => (resolveClosed = r))),
      _closeNow: (err?: Error) => resolveClosed(err),
    };
  };

  let manager: NatsConnectionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    manager = new NatsConnectionManager(config as unknown as ConfigService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('exposes the connection once connect() succeeds', async () => {
    const conn = makeConn();
    connectMock.mockResolvedValue(conn as never);

    manager.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({ reconnect: true, maxReconnectAttempts: -1 }),
    );
    expect(manager.connection).toBe(conn);
    expect(manager.status).toBe('ok');
  });

  it('keeps connection null when the broker is down, and re-probes on the timer', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    manager.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.connection).toBeNull();
    expect(manager.status).toBe('down');

    // Broker comes back: next probe tick connects.
    const conn = makeConn();
    connectMock.mockResolvedValueOnce(conn as never);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(manager.connection).toBe(conn);
  });

  it('drops the reference when the connection closes', async () => {
    const conn = makeConn();
    connectMock.mockResolvedValue(conn as never);

    manager.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.connection).toBe(conn);

    conn._closeNow();
    await Promise.resolve();

    expect(manager.connection).toBeNull();
  });

  it('drains the connection on shutdown', async () => {
    const conn = makeConn();
    connectMock.mockResolvedValue(conn as never);

    manager.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    await manager.onModuleDestroy();

    expect(conn.drain).toHaveBeenCalledTimes(1);
  });
});
