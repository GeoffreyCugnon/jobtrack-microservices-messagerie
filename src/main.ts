import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowedOrigins, corsOriginCheck } from './common/cors';

/**
 * Point d'entrée du micro-service.
 *
 * Une seule application Nest sert à la fois :
 *   - l'API REST (Express) ;
 *   - la gateway WebSocket Socket.IO (montée automatiquement via MessagingModule).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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

  // Propage les signaux d'arrêt (SIGINT/SIGTERM) vers les hooks onModuleDestroy
  // (déconnexion Prisma, drain de la connexion NATS…).
  app.enableShutdownHooks();

  // Port configurable via .env. Défaut 3100 pour ne pas entrer en collision avec
  // d'autres services de dev qui écoutent souvent sur 3000.
  const port = process.env.PORT ? Number(process.env.PORT) : 3100;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Messaging service listening on port ${port}`);
  logger.log(`CORS allowed origins: ${allowedOrigins().join(', ')}`);
}

void bootstrap();
