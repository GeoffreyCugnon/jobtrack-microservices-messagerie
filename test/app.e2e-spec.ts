import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

// Variables d'environnement posées AVANT l'import d'AppModule, pour que
// ConfigModule / JwtModule / les constantes de rate limiting les prennent en
// compte à la compilation du module.
process.env.MESSAGING_JWT_SECRET = process.env.MESSAGING_JWT_SECRET ?? 'test-secret';
process.env.MESSAGING_DATABASE_URL =
  process.env.MESSAGING_DATABASE_URL ??
  'postgresql://messaging:messaging@localhost:5432/messaging_test?schema=public';
process.env.MESSAGING_NATS_URL = process.env.MESSAGING_NATS_URL ?? 'nats://localhost:4222';
// Limite REST volontairement basse pour pouvoir déclencher un 429 dans le test.
process.env.MESSAGING_REST_THROTTLE_LIMIT = '20';
process.env.MESSAGING_REST_THROTTLE_TTL_MS = '60000';

// (imports volontairement placés après les process.env ci-dessus)
import { AppModule } from '../src/app.module';
import { NatsConnectionManager } from '../src/nats/nats-connection.manager';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Smoke test e2e : le squelette démarre, le guard commun est bien câblé sur
 * chaque route REST, la validation des DTO rejette (400) un payload invalide, et
 * le rate limiting REST rejette (429) un flood. Prisma et NATS sont mockés —
 * aucun conteneur requis.
 */
const prismaMock = {
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]),
  $transaction: jest.fn(),
  conversation: { findMany: jest.fn().mockResolvedValue([]) },
  outboxEvent: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
};
prismaMock.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prismaMock));

/** NATS jamais joignable dans ce test : l'outbox devient un no-op. */
const natsManagerStub = {
  connection: null,
  status: 'down' as const,
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
};

describe('Messaging skeleton (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const http = (): Server => app.getHttpServer() as Server;
  const auth = (): string => `Bearer ${jwt.sign({ sub: 'user-1' })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      // Pas de broker dans le smoke test : la publication devient un no-op.
      .overrideProvider(NatsConnectionManager)
      .useValue(natsManagerStub)
      .compile();

    app = moduleRef.createNestApplication();
    // Même config de validation qu'en production (cf. main.ts).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots the Nest application', () => {
    expect(app).toBeDefined();
  });

  it('rejects unauthenticated access to GET /conversations', () => {
    return request(http()).get('/conversations').expect(401);
  });

  it('serves GET /conversations for an authenticated user (paginated shape)', async () => {
    const res = await request(http())
      .get('/conversations')
      .set('Authorization', auth())
      .expect(200);

    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(prismaMock.conversation.findMany).toHaveBeenCalled();
  });

  it('rejects POST /conversations with a non-UUID participantId (400)', () => {
    return request(http())
      .post('/conversations')
      .set('Authorization', auth())
      .send({ participantId: 'not-a-uuid' })
      .expect(400);
  });

  it('rejects an unknown property in the body (400, forbidNonWhitelisted)', () => {
    return request(http())
      .post('/conversations')
      .set('Authorization', auth())
      .send({ participantId: '11111111-1111-1111-1111-111111111111', wat: true })
      .expect(400);
  });

  it('guards the new soft-delete / edit routes (401 without a JWT)', async () => {
    await request(http()).delete('/conversations/11111111-1111-1111-1111-111111111111').expect(401);
    await request(http()).patch('/messages/11111111-1111-1111-1111-111111111111').expect(401);
    await request(http())
      .post('/messages/11111111-1111-1111-1111-111111111111/restore')
      .expect(401);
  });

  it('rejects a non-UUID id on GET /messages/:id/versions (400)', () => {
    return request(http())
      .get('/messages/not-a-uuid/versions')
      .set('Authorization', auth())
      .expect(400);
  });

  it('serves GET /health publicly (no JWT) with a status report', async () => {
    const res = await request(http()).get('/health').expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      database: 'ok',
      nats: 'down',
      outboxPending: 0,
    });
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.outboxEvent.count).toHaveBeenCalled();
  });

  it('returns 429 Too Many Requests once the REST throttle limit is exceeded', async () => {
    const statuses: number[] = [];
    // Largement au-dessus de la limite (20) même en tenant compte des requêtes
    // des tests précédents.
    for (let i = 0; i < 40; i++) {
      const res = await request(http()).get('/conversations').set('Authorization', auth());
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
