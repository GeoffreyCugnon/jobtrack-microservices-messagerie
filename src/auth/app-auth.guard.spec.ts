import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppAuthGuard } from './app-auth.guard';
import { AuthService } from './auth.service';

/**
 * Test unitaire du guard sur le chemin HTTP : token absent / mauvais secret /
 * token valide. Pas de base ni d'app Nest — on fabrique un ExecutionContext minimal.
 */

/** Faux ExecutionContext HTTP exposant seulement `headers`. */
function httpContext(headers: Record<string, string>): ExecutionContext {
  const request: Record<string, unknown> = { headers };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AppAuthGuard', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const guard = new AppAuthGuard(new AuthService(jwt));

  it('rejects a request without a token', () => {
    expect(() => guard.canActivate(httpContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', () => {
    const foreign = new JwtService({ secret: 'other-secret' }).sign({ sub: 'user-1' });
    expect(() => guard.canActivate(httpContext({ authorization: `Bearer ${foreign}` }))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a valid token and attaches the user', () => {
    const token = jwt.sign({ sub: 'user-123' });
    const ctx = httpContext({ authorization: `Bearer ${token}` });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
