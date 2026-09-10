import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { AuthUser } from './auth-user.interface';
import { RolesGuard } from './roles.guard';

/** Contexte HTTP simulé portant `request.user`. */
function httpContext(user?: AuthUser): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    switchToWs: () => ({ getClient: () => ({ data: {} }) }),
  } as unknown as ExecutionContext;
}

function wsContext(user?: AuthUser): ExecutionContext {
  return {
    getType: () => 'ws',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToWs: () => ({ getClient: () => ({ data: { user } }) }),
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows any request when the handler carries no @Roles()', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(httpContext())).toBe(true);
  });

  it('allows when the user has at least one of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue(['recruiter', 'admin']);
    expect(guard.canActivate(httpContext({ id: 'u1', roles: ['user', 'recruiter'] }))).toBe(true);
  });

  it('throws ForbiddenException (HTTP) when the user has none of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(() => guard.canActivate(httpContext({ id: 'u1', roles: ['user'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException (HTTP) when the token has no roles claim at all', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(() => guard.canActivate(httpContext({ id: 'u1' }))).toThrow(ForbiddenException);
  });

  it('throws WsException in a WebSocket context', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(() => guard.canActivate(wsContext({ id: 'u1', roles: [] }))).toThrow(WsException);
  });
});
