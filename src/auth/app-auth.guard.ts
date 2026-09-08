import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { AuthedRequest, AuthedSocket } from './auth-user.interface';
import { AuthService } from './auth.service';
import { extractHttpToken, extractWsToken } from './extract-token';

/**
 * Guard unique, enregistré en APP_GUARD (cf. AppModule), donc appliqué à la fois
 * aux routes REST et aux handlers @SubscribeMessage de la gateway.
 *
 * Effet de bord : attache l'utilisateur résolu à `request.user` (HTTP) ou
 * `client.data.user` (WS), d'où le décorateur @CurrentUser peut ensuite le lire.
 *
 * NB : la *connexion* WebSocket (avant tout message) n'est pas couverte ici —
 * elle est validée dans MessagingGateway#handleConnection.
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient<AuthedSocket>();
      try {
        client.data.user = this.authService.verifyToken(extractWsToken(client));
      } catch (err) {
        // Converti en WsException pour un renvoi propre côté client Socket.IO.
        throw new WsException(err instanceof Error ? err.message : 'Unauthorized');
      }
      return true;
    }

    // Contexte HTTP : verifyToken lève UnauthorizedException (-> 401) si besoin.
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    request.user = this.authService.verifyToken(extractHttpToken(request));
    return true;
  }
}
