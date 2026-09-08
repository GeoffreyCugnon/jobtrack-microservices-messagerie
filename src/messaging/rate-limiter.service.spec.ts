import { WS_SEND_THROTTLE } from '../common/rate-limit.constants';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Le service enveloppe SlidingWindowRateLimiter (testé à part). On vérifie ici le
 * câblage : clés (userId vs repli socket), indépendance connexion/message, et
 * respect de la limite configurée pour `message:send`.
 */
describe('WsRateLimiterService', () => {
  let service: WsRateLimiterService;

  beforeEach(() => {
    service = new WsRateLimiterService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('allows message:send up to the configured limit per user, then blocks', () => {
    const results: boolean[] = [];
    for (let i = 0; i < WS_SEND_THROTTLE.limit + 1; i++) {
      results.push(service.allowMessage('user-a', 'sock-1'));
    }
    expect(results.slice(0, WS_SEND_THROTTLE.limit)).toEqual(
      Array(WS_SEND_THROTTLE.limit).fill(true),
    );
    expect(results[WS_SEND_THROTTLE.limit]).toBe(false);
  });

  it('keys message limits by user, not by socket', () => {
    for (let i = 0; i < WS_SEND_THROTTLE.limit; i++) {
      service.allowMessage('user-a', `sock-${i}`);
    }
    // Même user, socket différent : toujours bloqué.
    expect(service.allowMessage('user-a', 'sock-999')).toBe(false);
    // Autre user : quota intact.
    expect(service.allowMessage('user-b', 'sock-1')).toBe(true);
  });

  it('falls back to the socket id when no user id is provided', () => {
    for (let i = 0; i < WS_SEND_THROTTLE.limit; i++) {
      expect(service.allowMessage(undefined, 'anon-sock')).toBe(true);
    }
    expect(service.allowMessage(undefined, 'anon-sock')).toBe(false);
    // Repli indépendant d'un autre socket anonyme.
    expect(service.allowMessage(undefined, 'other-anon-sock')).toBe(true);
  });

  it('tracks connection attempts independently from message sends', () => {
    // Épuiser le quota message ne doit pas affecter les connexions.
    for (let i = 0; i < WS_SEND_THROTTLE.limit + 5; i++) {
      service.allowMessage('user-a', 'sock-1');
    }
    expect(service.allowConnection('10.0.0.1')).toBe(true);
  });
});
