import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Client Prisma exposé comme provider injectable, avec gestion du cycle de vie :
 *  - connexion à l'ouverture du module ;
 *  - déconnexion propre à l'arrêt (déclenchée par app.enableShutdownHooks()).
 *
 * Depuis Prisma 7, la connexion passe par un adaptateur de driver : ici pg,
 * alimenté par MESSAGING_DATABASE_URL (cf. .env / .env.example).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('MESSAGING_DATABASE_URL'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
