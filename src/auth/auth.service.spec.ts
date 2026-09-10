import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

/**
 * `verifyToken` : identité (`sub`), rejets (absent / invalide / sans `sub`) et
 * extraction optionnelle du claim `roles` (ignoré s'il est absent ou malformé).
 */
describe('AuthService', () => {
  const secret = 'test-secret';
  const jwt = new JwtService({ secret, verifyOptions: { algorithms: ['HS256'] } });
  const service = new AuthService(jwt);
  const sign = (payload: object): string => jwt.sign(payload, { algorithm: 'HS256' });

  it('returns the caller id from the sub claim (no roles key when absent)', () => {
    const user = service.verifyToken(sign({ sub: 'user-1' }));
    expect(user).toEqual({ id: 'user-1' });
  });

  it('extracts a well-formed roles claim', () => {
    const user = service.verifyToken(sign({ sub: 'user-1', roles: ['recruiter', 'user'] }));
    expect(user).toEqual({ id: 'user-1', roles: ['recruiter', 'user'] });
  });

  it('ignores a malformed roles claim (not an array of non-empty strings)', () => {
    expect(service.verifyToken(sign({ sub: 'u', roles: 'admin' }))).toEqual({ id: 'u' });
    expect(service.verifyToken(sign({ sub: 'u', roles: [1, '', null] }))).toEqual({ id: 'u' });
  });

  it('rejects a missing, malformed, or sub-less token', () => {
    expect(() => service.verifyToken(undefined)).toThrow(UnauthorizedException);
    expect(() => service.verifyToken('not-a-jwt')).toThrow(UnauthorizedException);
    expect(() => service.verifyToken(sign({ foo: 'bar' }))).toThrow(UnauthorizedException);
  });
});
