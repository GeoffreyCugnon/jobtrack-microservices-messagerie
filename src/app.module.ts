import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppAuthGuard } from './auth/app-auth.guard';
import { AuthModule } from './auth/auth.module';
import { RestRateLimitGuard } from './common/rest-rate-limit.guard';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
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
    PrismaModule,
    NatsModule,
    AuthModule,
    ConversationsModule,
    MessagesModule,
    MessagingModule,
    HealthModule,
  ],
  providers: [
    // Rate limiting REST en premier : un flood est rejeté (429) avant même la
    // vérification JWT. No-op hors contexte HTTP (le WS a son propre throttling
    // dans MessagingGateway).
    { provide: APP_GUARD, useClass: RestRateLimitGuard },
    // Guard commun appliqué à TOUTES les routes REST et aux handlers
    // @SubscribeMessage de la gateway. La connexion WebSocket elle-même est
    // authentifiée séparément dans MessagingGateway#handleConnection (les guards
    // ne s'exécutent pas sur l'événement de connexion).
    { provide: APP_GUARD, useClass: AppAuthGuard },
  ],
})
export class AppModule {}
