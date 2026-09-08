import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppAuthGuard } from './auth/app-auth.guard';
import { AuthModule } from './auth/auth.module';
import { REST_THROTTLE } from './common/rate-limit.constants';
import { RestThrottlerGuard } from './common/rest-throttler.guard';
import { ConversationsModule } from './conversations/conversations.module';
import { MessagesModule } from './messages/messages.module';
import { MessagingModule } from './messaging/messaging.module';
import { NatsModule } from './nats/nats.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Module racine : assemble l'infrastructure (config, Prisma, NATS, event bus
 * interne) et les modules métier (conversations, messages, gateway WebSocket).
 */
@Module({
  imports: [
    // Charge .env et rend ConfigService disponible partout.
    ConfigModule.forRoot({ isGlobal: true }),
    // Bus d'événements *interne au process* : MessagesService -> MessagingGateway
    // (diffusion WebSocket). Sans rapport avec NATS, qui est inter-services.
    EventEmitterModule.forRoot(),
    // Rate limiting REST (par IP). Stockage en mémoire process : suffisant pour
    // le modèle « une instance isolée par projet hôte ». `ttl` en millisecondes
    // (throttler v6). Voir src/common/rate-limit.constants.ts pour les valeurs.
    ThrottlerModule.forRoot([{ ttl: REST_THROTTLE.ttlMs, limit: REST_THROTTLE.limit }]),
    PrismaModule,
    NatsModule,
    AuthModule,
    ConversationsModule,
    MessagesModule,
    MessagingModule,
  ],
  providers: [
    // Rate limiting REST en premier : un flood est rejeté (429) avant même la
    // vérification JWT. No-op hors contexte HTTP (le WS a son propre throttling
    // dans MessagingGateway).
    { provide: APP_GUARD, useClass: RestThrottlerGuard },
    // Guard commun appliqué à TOUTES les routes REST et aux handlers
    // @SubscribeMessage de la gateway. La connexion WebSocket elle-même est
    // authentifiée séparément dans MessagingGateway#handleConnection (les guards
    // ne s'exécutent pas sur l'événement de connexion).
    { provide: APP_GUARD, useClass: AppAuthGuard },
  ],
})
export class AppModule {}
