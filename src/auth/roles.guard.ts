import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { AuthedRequest, AuthedSocket, AuthUser } from './auth-user.interface';
import { ROLES_KEY } from './roles.decorator';

/**
 * Guard d'autorisation par rôle, enregistré en APP_GUARD **après** `AppAuthGuard`
 * (qui a déjà posé `user`). N'agit que sur les handlers/contrôleurs décorés
 * `@Roles(...)` : partout ailleurs il laisse passer.
 *
 * Règle : l'utilisateur doit porter **au moins un** des rôles requis. Le claim
 * `roles` est optionnel dans le JWT ; s'il est absent, un handler `@Roles(...)`
 * renvoie 403 (HTTP) / `WsException` (WS).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const user = this.userOf(context);
    const roles = user?.roles ?? [];
    if (roles.some((r) => required.includes(r))) {
      return true;
    }

    const message = `Requires one of the following roles: ${required.join(', ')}`;
    if (context.getType() === 'ws') {
      throw new WsException(message);
    }
    throw new ForbiddenException(message);
  }

  private userOf(context: ExecutionContext): AuthUser | undefined {
    if (context.getType() === 'ws') {
      return context.switchToWs().getClient<AuthedSocket>().data.user;
    }
    return context.switchToHttp().getRequest<AuthedRequest>().user;
  }
}
