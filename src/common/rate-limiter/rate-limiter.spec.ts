import type { ConfigService } from '@nestjs/config';
import { MemoryRateLimiter } from './rate-limiter';
import { RateLimiterFactory } from './rate-limiter.factory';

describe('MemoryRateLimiter', () => {
  it('allows up to the limit within the window, then blocks (refused hits not counted)', async () => {
    const rl = new MemoryRateLimiter(3, 1_000);
    expect(await rl.hit('k')).toBe(true);
    expect(await rl.hit('k')).toBe(true);
    expect(await rl.hit('k')).toBe(true);
    expect(await rl.hit('k')).toBe(false);
    expect(await rl.hit('k')).toBe(false);
  });

  it('keys are independent', async () => {
    const rl = new MemoryRateLimiter(1, 1_000);
    expect(await rl.hit('a')).toBe(true);
    expect(await rl.hit('a')).toBe(false);
    expect(await rl.hit('b')).toBe(true);
  });
});

describe('RateLimiterFactory', () => {
  const cfg = (url?: string): ConfigService =>
    ({
      get: (k: string) => (k === 'MESSAGING_REDIS_URL' ? url : undefined),
    }) as unknown as ConfigService;

  it('creates in-memory limiters when MESSAGING_REDIS_URL is unset', async () => {
    const factory = new RateLimiterFactory(cfg());
    const rl = factory.create('rest', 2, 1_000);
    expect(rl).toBeInstanceOf(MemoryRateLimiter);
    expect(await rl.hit('x')).toBe(true);
    await factory.onModuleDestroy();
  });
});
