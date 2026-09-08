import { SlidingWindowRateLimiter } from './ws-rate-limit';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to `limit` hits inside the window, then blocks', () => {
    const limiter = new SlidingWindowRateLimiter(3, 10_000);
    const t0 = 1_000_000;

    expect(limiter.hit('user-a', t0)).toBe(true);
    expect(limiter.hit('user-a', t0 + 1)).toBe(true);
    expect(limiter.hit('user-a', t0 + 2)).toBe(true);
    expect(limiter.hit('user-a', t0 + 3)).toBe(false);
  });

  it('keys are independent', () => {
    const limiter = new SlidingWindowRateLimiter(1, 10_000);
    const t0 = 1_000_000;

    expect(limiter.hit('user-a', t0)).toBe(true);
    expect(limiter.hit('user-b', t0)).toBe(true);
    expect(limiter.hit('user-a', t0)).toBe(false);
  });

  it('lets the window slide: old hits stop counting', () => {
    const limiter = new SlidingWindowRateLimiter(2, 10_000);
    const t0 = 1_000_000;

    expect(limiter.hit('k', t0)).toBe(true);
    expect(limiter.hit('k', t0 + 5_000)).toBe(true);
    expect(limiter.hit('k', t0 + 6_000)).toBe(false);
    // t0 hit is now outside the 10s window -> one slot frees up.
    expect(limiter.hit('k', t0 + 10_001)).toBe(true);
  });

  it('a blocked attempt does not extend the block indefinitely', () => {
    const limiter = new SlidingWindowRateLimiter(1, 10_000);
    const t0 = 1_000_000;

    expect(limiter.hit('k', t0)).toBe(true);
    expect(limiter.hit('k', t0 + 9_000)).toBe(false); // blocked, not recorded
    // Original hit expires at t0 + 10_000; since the blocked one was not
    // recorded, the next call just after is allowed.
    expect(limiter.hit('k', t0 + 10_001)).toBe(true);
  });

  it('sweep() drops keys with no hits left in the window', () => {
    const limiter = new SlidingWindowRateLimiter(5, 10_000);
    const t0 = 1_000_000;

    limiter.hit('k', t0);
    limiter.sweep(t0 + 20_000);
    // After sweep the key is gone -> full quota available again.
    for (let i = 0; i < 5; i++) {
      expect(limiter.hit('k', t0 + 20_000 + i)).toBe(true);
    }
    expect(limiter.hit('k', t0 + 20_010)).toBe(false);
  });
});
