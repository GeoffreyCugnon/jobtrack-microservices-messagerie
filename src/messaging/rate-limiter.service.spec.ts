import type { ConfigService } from '@nestjs/config';
import { WS_SEND_THROTTLE } from '../common/rate-limit.constants';
import { RateLimiterFactory } from '../common/rate-limiter/rate-limiter.factory';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Le service enveloppe le backend de rate limiting (mémoire ici, `RateLimiterFactory`
 * sans `MESSAGING_REDIS_URL`). On vérifie le câblage : clés (userId vs repli
 * socket), indépendance connexion/message, respect de la limite `message:send`.
 */
describe('WsRateLimiterService', () => {
  let service: WsRateLimiterService;

  beforeEach(() => {
    const config = { get: () => undefined } as unknown as ConfigService;
    service = new WsRateLimiterService(new RateLimiterFactory(config));
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('allows message:send up to the configured limit per user, then blocks', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < WS_SEND_THROTTLE.limit + 1; i++) {
      results.push(await service.allowMessage('user-a', 'sock-1'));
    }
    expect(results.slice(0, WS_SEND_THROTTLE.limit)).toEqual(
      Array(WS_SEND_THROTTLE.limit).fill(true),
    );
    expect(results[WS_SEND_THROTTLE.limit]).toBe(false);
  });

  it('keys message limits by user, not by socket', async () => {
    for (let i = 0; i < WS_SEND_THROTTLE.limit; i++) {
      await service.allowMessage('user-a', `sock-${i}`);
    }
    // Même user, socket différent : toujours bloqué.
    expect(await service.allowMessage('user-a', 'sock-999')).toBe(false);
    // Autre user : quota intact.
    expect(await service.allowMessage('user-b', 'sock-1')).toBe(true);
  });

  it('falls back to the socket id when no user id is provided', async () => {
    for (let i = 0; i < WS_SEND_THROTTLE.limit; i++) {
      expect(await service.allowMessage(undefined, 'anon-sock')).toBe(true);
    }
    expect(await service.allowMessage(undefined, 'anon-sock')).toBe(false);
    // Repli indépendant d'un autre socket anonyme.
    expect(await service.allowMessage(undefined, 'other-anon-sock')).toBe(true);
  });

  it('tracks connection attempts independently from message sends', async () => {
    // Épuiser le quota message ne doit pas affecter les connexions.
    for (let i = 0; i < WS_SEND_THROTTLE.limit + 5; i++) {
      await service.allowMessage('user-a', 'sock-1');
    }
    expect(await service.allowConnection('10.0.0.1')).toBe(true);
  });

  it('keys the typing limiter by user and enforces its own (larger) quota', async () => {
    // Le quota typing est indépendant de celui de message:send.
    for (let i = 0; i < WS_SEND_THROTTLE.limit + 1; i++) {
      await service.allowMessage('user-a', 'sock-1');
    }
    expect(await service.allowTyping('user-a', 'sock-1')).toBe(true);
  });
});
