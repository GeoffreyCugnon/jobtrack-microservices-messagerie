import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

/** En-tête de corrélation : réutilisé s'il vient de l'amont (proxy / gateway). */
const REQUEST_ID_HEADER = 'x-request-id';

const isProd = (): boolean => process.env.NODE_ENV === 'production';
const isTest = (): boolean => process.env.NODE_ENV === 'test';

/**
 * Configuration `nestjs-pino` : logs structurés JSON en un flux, avec un
 * identifiant de requête (`req.id`) propagé dans chaque ligne et renvoyé au
 * client via l'en-tête `x-request-id`.
 *
 * - Niveau piloté par `MESSAGING_LOG_LEVEL` (défaut : `info` en prod, `debug` sinon).
 * - `pino-pretty` uniquement hors prod / hors test (worker thread bruyant en CI).
 * - `/health` et `/metrics` ne sont pas journalisés (appelés en boucle par
 *   l'orchestrateur et le scraper Prometheus).
 * - `authorization` / `cookie` masqués.
 */
export function buildLoggerOptions(): Params {
  const level = process.env.MESSAGING_LOG_LEVEL?.trim() || (isProd() ? 'info' : 'debug');

  return {
    pinoHttp: {
      level,
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const fromHeader = req.headers[REQUEST_ID_HEADER];
        const id = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader)?.trim() || randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      autoLogging: {
        ignore: (req: IncomingMessage): boolean => {
          const url = req.url ?? '';
          return url === '/health' || url === '/metrics' || url.startsWith('/metrics?');
        },
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]'],
        remove: true,
      },
      customProps: () => ({ service: 'ms-messagerie' }),
      transport:
        isProd() || isTest()
          ? undefined
          : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } },
    },
  };
}
