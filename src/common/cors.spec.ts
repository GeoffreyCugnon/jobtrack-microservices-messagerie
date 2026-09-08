import { allowedOrigins, corsOriginCheck } from './cors';

/** Résout le callback style Express/Socket.IO en `{ allow, err }`. */
function check(origin: string | undefined): { allow: boolean; err: Error | null } {
  let result: { allow: boolean; err: Error | null } = { allow: false, err: null };
  corsOriginCheck(origin, (err, allow) => {
    result = { allow: allow ?? false, err: err ?? null };
  });
  return result;
}

describe('corsOriginCheck', () => {
  const ENV = process.env.MESSAGING_CORS_ORIGINS;

  afterEach(() => {
    if (ENV === undefined) {
      delete process.env.MESSAGING_CORS_ORIGINS;
    } else {
      process.env.MESSAGING_CORS_ORIGINS = ENV;
    }
  });

  it('allows the default Vite dev origins when the env var is unset', () => {
    delete process.env.MESSAGING_CORS_ORIGINS;
    expect(check('http://localhost:5173').allow).toBe(true);
    expect(check('http://localhost:5174').allow).toBe(true);
  });

  it('allows requests without an Origin header (curl / server-to-server / health check)', () => {
    delete process.env.MESSAGING_CORS_ORIGINS;
    expect(check(undefined).allow).toBe(true);
  });

  it('rejects an unknown origin (cross-origin browser request)', () => {
    delete process.env.MESSAGING_CORS_ORIGINS;
    const { allow, err } = check('https://evil.example.com');
    expect(allow).toBe(false);
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects an arbitrary localhost port once the whitelist is explicit', () => {
    delete process.env.MESSAGING_CORS_ORIGINS;
    expect(check('http://localhost:9999').allow).toBe(false);
  });

  it('honours MESSAGING_CORS_ORIGINS (comma-separated, trimmed)', () => {
    process.env.MESSAGING_CORS_ORIGINS = 'https://jobtrack.example.com , http://localhost:4000';
    expect(allowedOrigins()).toEqual(['https://jobtrack.example.com', 'http://localhost:4000']);
    expect(check('https://jobtrack.example.com').allow).toBe(true);
    expect(check('http://localhost:4000').allow).toBe(true);
    expect(check('http://localhost:5173').allow).toBe(false);
  });
});
