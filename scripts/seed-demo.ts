/**
 * Amorce une conversation de démo (2 utilisateurs, un fil de quelques messages)
 * directement en base, puis affiche les deux JWT à utiliser côté client.
 *
 *   npm run seed:demo
 *
 * Idempotent : relancer réinitialise le fil de la même paire. Le contenu est
 * inséré tel quel (lisible même si `MESSAGING_CONTENT_ENCRYPTION_KEY` est défini
 * — `decrypt` traite l'absence de préfixe `v1:` comme du clair).
 *
 * NB : ce script écrit en base sans passer par l'API — donc pas d'événement WS
 * ni d'événement d'intégration NATS. Ouvrir l'app après le seed pour voir le fil.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '../src/generated/prisma/client';

const dbUrl = process.env.MESSAGING_DATABASE_URL;
const secret = process.env.MESSAGING_JWT_SECRET;
if (!dbUrl || !secret) {
  console.error('MESSAGING_DATABASE_URL et MESSAGING_JWT_SECRET requis dans .env — abandon.');
  process.exit(1);
}

// UUID fixes (hex valide, forme v4) → tokens reproductibles, acceptés par @IsUUID.
const ALICE = 'a11ce000-0000-4000-8000-000000000001';
const BOB = 'b0b00000-0000-4000-8000-000000000002';
const [userAId, userBId] = ALICE < BOB ? [ALICE, BOB] : [BOB, ALICE];

const THREAD: [string, string][] = [
  [ALICE, 'Salut 👋 tu es dispo pour la démo de tout à l’heure ?'],
  [BOB, 'Oui, je prépare l’environnement. On part sur quel scénario ?'],
  [ALICE, 'Messagerie temps réel : envoi, accusé de lecture, édition, historique.'],
  [BOB, 'Parfait. Je branche deux onglets avec les deux comptes.'],
  [ALICE, 'Top. Je t’envoie le lien juste avant.'],
  [BOB, 'Reçu 🙌'],
];

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
  try {
    const conversation = await prisma.conversation.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: { deletedAt: null },
      create: { userAId, userBId },
    });

    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });

    const base = Date.now() - THREAD.length * 60_000;
    let last = new Date();
    for (let i = 0; i < THREAD.length; i++) {
      const [senderId, content] = THREAD[i];
      last = new Date(base + i * 60_000);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId,
          content,
          createdAt: last,
          // Les premiers messages d'Alice sont "lus" par Bob ; le dernier reste
          // non lu → Bob voit un badge `unreadCount: 1` à l'ouverture.
          readAt: senderId === ALICE && i <= 2 ? new Date(last.getTime() + 30_000) : null,
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: last },
    });

    const jwt = new JwtService({ secret, signOptions: { algorithm: 'HS256', expiresIn: '24h' } });
    console.log(`\nConversation ${conversation.id} — ${THREAD.length} messages.\n`);
    console.log(`Alice  ${ALICE}`);
    console.log(`  ${jwt.sign({ sub: ALICE })}\n`);
    console.log(`Bob    ${BOB}`);
    console.log(`  ${jwt.sign({ sub: BOB })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
