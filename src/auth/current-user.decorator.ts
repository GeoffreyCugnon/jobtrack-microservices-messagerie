import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest, AuthedSocket, AuthUser } from './auth-user.interface';

/**
 * Injecte l'utilisateur authentifié dans un handler : `@CurrentUser() user: AuthUser`.
 *
 * Lit ce que AppAuthGuard a préalablement posé (`request.user` en HTTP,
 * `client.data.user` en WS). Le cast `as AuthUser` est sûr car le guard s'exécute
 * toujours avant (aucune route/handler n'est exposé sans lui).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    if (context.getType() === 'ws') {
      return context.switchToWs().getClient<AuthedSocket>().data.user as AuthUser;
    }
    return context.switchToHttp().getRequest<AuthedRequest>().user as AuthUser;
  },
);
