import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

/**
 * Les services (`ConversationsService`, `MessagesService`) sont partagés entre
 * les contrôleurs REST et la gateway : ils lèvent des `HttpException`
 * (`NotFoundException`, `ForbiddenException`…). En contexte WebSocket, Nest ne
 * sait sérialiser proprement que les `WsException` — une `HttpException` non
 * traduite arrivait au client en `"Internal server error"` générique.
 *
 * Ce filtre traduit toute `HttpException` en `WsException` porteuse du message
 * d'origine (et du status HTTP, pour que le client puisse discriminer 403 / 404 /
 * 400) avant de laisser `BaseWsExceptionFilter` faire l'émission `exception`.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message ?? exception.message);
      super.catch(new WsException({ status: exception.getStatus(), message }), host);
      return;
    }
    super.catch(exception, host);
  }
}
