import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service';

/** UUID (v1–v5) dans un segment de path → `:id`, pour borner la cardinalité. */
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Mesure durée + volume des requêtes HTTP (`http_requests_total`,
 * `http_request_duration_seconds`). No-op hors HTTP. `/health` et `/metrics`
 * sont ignorés (appelés en boucle, bruit inutile).
 *
 * L'enregistrement se fait sur `res` `finish` : le status est alors définitif,
 * y compris quand `AllExceptionsFilter` a réécrit la réponse.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const url = req.originalUrl || req.url || '';

    if (url === '/health' || url === '/metrics' || url.startsWith('/metrics?')) {
      return next.handle();
    }

    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // `req.route` (pattern Express, faible cardinalité) est posé après le
      // routage ; repli : le path sans query, UUID normalisés en `:id`.
      const routePattern = (req as { route?: { path?: string } }).route?.path;
      const route = routePattern ?? url.split('?')[0].replace(UUID_SEGMENT, '/:id');
      this.metrics.recordHttp(req.method, route, res.statusCode, seconds);
    });

    return next.handle();
  }
}
