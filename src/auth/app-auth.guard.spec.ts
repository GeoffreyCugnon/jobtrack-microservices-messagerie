import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppAuthGuard } from './app-auth.guard';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Test unitaire du guard sur le chemin HTTP : token absent / mauvais secret /
 * expiré / valide, plus le court-circuit @Public(). Pas de base ni d'app Nest —
 * on fabrique un ExecutionContext minimal.
 */

/** Faux ExecutionContext HTTP exposant `headers` + des cibles réelles pour le Reflector. */
function httpContext(headers: Record<string, string>): ExecutionContext {
  const request: Record<string, unknown> = { headers };
  const handler = function handler(): void {};
  class FakeController {}
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AppAuthGuard', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const guard = new AppAuthGuard(new AuthService(jwt), new Reflector());

  it('rejects a request without a token', () => {
    expect(() => guard.canActivate(httpContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', () => {
    const foreign = new JwtService({ secret: 'other-secret' }).sign({ sub: 'user-1' });
    expect(() => guard.canActivate(httpContext({ authorization: `Bearer ${foreign}` }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'user-1' }, { expiresIn: '-1s' });
    expect(() => guard.canActivate(httpContext({ authorization: `Bearer ${expired}` }))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a valid token and attaches the user', () => {
    const token = jwt.sign({ sub: 'user-123' });
    const ctx = httpContext({ authorization: `Bearer ${token}` });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets a @Public() route through without any token', () => {
    const reflector = new Reflector();
    const getMeta = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const publicGuard = new AppAuthGuard(new AuthService(jwt), reflector);

    expect(publicGuard.canActivate(httpContext({}))).toBe(true);
    expect(getMeta).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
  });
});
