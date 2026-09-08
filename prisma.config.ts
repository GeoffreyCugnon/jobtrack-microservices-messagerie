// ---------------------------------------------------------------------------
// Configuration Prisma (Prisma 7+).
//
// Depuis Prisma 7, la chaîne de connexion ne vit plus dans schema.prisma.
// Elle est déclarée ici pour la CLI (prisma migrate / db execute / studio) et
// lue depuis l'environnement, comme le reste de la config du service.
// Le runtime applicatif, lui, passe par l'adaptateur pg dans PrismaService.
// ---------------------------------------------------------------------------

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('MESSAGING_DATABASE_URL'),
  },
});
