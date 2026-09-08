import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Rend PrismaService disponible dans toute l'application sans réimport
 * (@Global), pour que chaque module métier puisse accéder à la base.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
