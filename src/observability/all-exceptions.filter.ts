import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
  requestId?: string;
}

/**
 * Filtre d'exceptions global (HTTP). Uniformise la réponse d'erreur et journalise
 * chaque échec avec le `requestId` de corrélation. Les 5xx sont logués en
 * `error` (avec la stack), les 4xx en `warn`.
 *
 * Ne touche pas au contexte WebSocket : la gateway a son propre
 * `WsExceptionFilter` (au niveau classe, donc prioritaire). Toute exception non
 * HTTP qui remonterait ici est seulement journalisée.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.error({ err: exception, contextType: host.getType() }, 'Non-HTTP exception');
      return;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
        error = exception.name.replace(/Exception$/, '');
      } else {
        const p = payload as { message?: string | string[]; error?: string };
        message = p.message ?? exception.message;
        error = p.error ?? exception.name.replace(/Exception$/, '');
      }
    } else if (exception instanceof Error && process.env.NODE_ENV !== 'production') {
      message = exception.message;
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: req.originalUrl ?? req.url,
      requestId: req.id,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, requestId: req.id, path: body.path, status },
        'Unhandled exception',
      );
    } else {
      this.logger.warn(
        { requestId: req.id, path: body.path, status },
        typeof message === 'string' ? message : 'Request error',
      );
    }

    res.status(status).json(body);
  }
}
