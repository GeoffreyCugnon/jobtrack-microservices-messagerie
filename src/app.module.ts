import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { AppAuthGuard } from './auth/app-auth.guard';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';
import { RateLimiterModule } from './common/rate-limiter/rate-limiter.module';
import { RestRateLimitGuard } from './common/rest-rate-limit.guard';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { MessagesModule } from './messages/messages.module';
import { MessagingModule } from './messaging/messaging.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsModule } from './metrics/metrics.module';
import { NatsModule } from './nats/nats.module';
import { AllExceptionsFilter } from './observability/all-exceptions.filter';
import { buildLoggerOptions } from './observability/logger.options';
import { PrismaModule } from './prisma/prisma.module';
import { RetentionModule } from './retention/retention.module';

/**
 * Module racine : assemble l'infrastructure (config, logs, Prisma, NATS, event
 * bus interne, scheduler) et les modules métier (conversations, messages,
 * gateway WebSocket), plus l'observabilité (métriques Prometheus, filtre
 * d'exceptions global).
 */
@Module({
  imports: [
    // Charge .env et rend ConfigService disponible partout.
    ConfigModule.forRoot({ isGlobal: true }),
    // Logs structurés JSON + identifiant de requête (cf. observability/).
    LoggerModule.forRoot(buildLoggerOptions()),
    // Bus d'événements *interne au process* : MessagesService -> MessagingGateway
    // (diffusion WebSocket). Sans rapport avec NATS, qui est inter-services.
    EventEmitterModule.forRoot(),
    // Jobs planifiés (purge de rétention).
    ScheduleModule.forRoot(),
    PrismaModule,
    NatsModule,
    AuditModule,
    AuthModule,
    RateLimiterModule,
    MetricsModule,
    RetentionModule,
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
    // Autorisation par rôle — n'agit que sur les handlers décorés @Roles(...)
    // (aucun aujourd'hui). Doit venir après AppAuthGuard (qui pose `user`).
    { provide: APP_GUARD, useClass: RolesGuard },
    // Métriques HTTP (durée / volume). No-op hors HTTP.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    // Réponse d'erreur uniforme + log corrélé. HTTP uniquement (la gateway a son
    // WsExceptionFilter au niveau classe).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
