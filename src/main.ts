import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { allowedOrigins, corsOriginCheck } from './common/cors';
import { trustProxySetting } from './common/trust-proxy';

/**
 * Point d'entrée du micro-service.
 *
 * Une seule application Nest sert à la fois :
 *   - l'API REST (Express) ;
 *   - la gateway WebSocket Socket.IO (montée automatiquement via MessagingModule).
 */
async function bootstrap(): Promise<void> {
  // `bufferLogs` : les logs du démarrage sont mis en tampon puis rejoués une
  // fois le logger pino (nestjs-pino) résolu, pour tout avoir au même format.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // En-têtes de sécurité HTTP. CSP désactivée (API JSON + Swagger UI, pas de
  // page applicative servie) ; CORP `cross-origin` car l'API est consommée
  // depuis le navigateur par un front d'une autre origine.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Derrière un reverse proxy (nginx / traefik / ingress), Express doit dériver
  // `req.ip` du header `X-Forwarded-For` — sinon tout le trafic partage l'IP du
  // proxy et le rate limiting REST devient un bucket global. Piloté par
  // `MESSAGING_TRUST_PROXY` (défaut : 1 hop). Cf. src/common/trust-proxy.ts.
  app.set('trust proxy', trustProxySetting());

  // CORS HTTP : le projet hôte (JobTrack) appelle ce service directement depuis
  // le navigateur (header Authorization, pas de cookie), donc pas besoin de
  // `credentials: true`. La liste blanche est explicite et pilotée par
  // `MESSAGING_CORS_ORIGINS` (cf. src/common/cors.ts) ; défaut = origines de dev
  // du Frontend Vite (5173 / 5174). La gateway WebSocket (Socket.IO) partage
  // exactement la même liste (`corsOriginCheck` dans MessagingGateway).
  app.enableCors({ origin: corsOriginCheck });

  // Validation globale des payloads d'entrée :
  //  - whitelist            : retire les propriétés non déclarées dans les DTO ;
  //  - forbidNonWhitelisted : rejette (400) toute propriété non déclarée ;
  //  - transform            : instancie les DTO et applique @Type (ex. limit -> number).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // Documentation OpenAPI interactive sur `/docs`. Désactivable en prod via
  // `MESSAGING_ENABLE_DOCS=false`.
  if ((process.env.MESSAGING_ENABLE_DOCS ?? 'true').trim().toLowerCase() !== 'false') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('MS-Messagerie')
      .setDescription(
        'API REST du micro-service de messagerie one-to-one. ' +
          "Auth : JWT HS256 (claim `sub`) émis par l'hôte, en header `Authorization: Bearer`. " +
          'Le temps réel passe par Socket.IO (événements `message:*`, `typing`, `conversation:*`).',
      )
      .setVersion(process.env.npm_package_version ?? '0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, { customSiteTitle: 'MS-Messagerie API' });
  }

  // Propage les signaux d'arrêt (SIGINT/SIGTERM) vers les hooks onModuleDestroy
  // (déconnexion Prisma, drain de la connexion NATS…).
  app.enableShutdownHooks();

  // Port configurable via .env. Défaut 3100 pour ne pas entrer en collision avec
  // d'autres services de dev qui écoutent souvent sur 3000.
  const port = process.env.PORT ? Number(process.env.PORT) : 3100;
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Messaging service listening on port ${port}`);
  logger.log(`CORS allowed origins: ${allowedOrigins().join(', ')}`);
  logger.log(`trust proxy: ${String(trustProxySetting())}`);
  if (!process.env.MESSAGING_CORS_ORIGINS?.trim()) {
    logger.warn(
      'MESSAGING_CORS_ORIGINS not set — using Vite dev defaults. ' +
        'Set it to your frontend origin(s) for any deployed instance (browser calls are blocked otherwise).',
    );
  }
}

void bootstrap();
