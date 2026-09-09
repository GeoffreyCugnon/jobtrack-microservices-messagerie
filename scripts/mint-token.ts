/**
 * Génère un JWT HS256 accepté par ce service (même lib et mêmes options que
 * `src/auth/auth.service.ts`). Le service ne délivre pas de token : c'est au
 * projet hôte de le faire — ce script rend la chose triviale pour une démo ou
 * un test manuel.
 *
 *   npm run token                 # sub = UUID aléatoire
 *   npm run token -- <uuid>       # sub imposé
 *
 * Token valable 24 h. Lit `MESSAGING_JWT_SECRET` depuis `.env`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

const secret = process.env.MESSAGING_JWT_SECRET;
if (!secret) {
  console.error('MESSAGING_JWT_SECRET absent du .env — abandon.');
  process.exit(1);
}

const sub = process.argv[2] ?? randomUUID();
const port = process.env.PORT ?? '3100';

const jwt = new JwtService({ secret, signOptions: { algorithm: 'HS256', expiresIn: '24h' } });
const token = jwt.sign({ sub });

console.log(`sub    : ${sub}`);
console.log(`expires: 24h`);
console.log(`\n${token}\n`);
console.log('REST  :');
console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:${port}/conversations`);
console.log('WS    :');
console.log(`  io("http://localhost:${port}", { auth: { token: "${token}" } })`);
