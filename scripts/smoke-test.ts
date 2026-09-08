/**
 * Manual end-to-end smoke test — NOT a Jest suite.
 *
 * Exercises the real service against real infrastructure:
 *   - `npm run start:dev` already running (default port from .env)
 *   - `postgres-messaging` and `nats-messaging` containers already up
 *
 * Run: `npm run smoke-test`
 *
 * It drives the full flow (REST + Socket.IO + NATS) with one user "A" acting as
 * sender and one user "B" acting as recipient, logging every HTTP status, payload
 * and real-time event, then prints a pass/fail summary and exits 0 / 1.
 */
import 'dotenv/config';
import { JwtService } from '@nestjs/jwt';
import { connect, JSONCodec, type NatsConnection } from 'nats';
import { io, type Socket } from 'socket.io-client';
import { NATS_SUBJECTS } from '../src/nats/nats.events';

// --------------------------------------------------------------------------- //
// Config (same env vars as the app)
// --------------------------------------------------------------------------- //
const JWT_SECRET = process.env.MESSAGING_JWT_SECRET;
const NATS_URL = process.env.MESSAGING_NATS_URL ?? 'nats://localhost:4222';
const PORT = process.env.PORT ?? '3100';
const BASE_URL = `http://localhost:${PORT}`;

// Identifiants au format UUID (le service valide `participantId` avec @IsUUID).
// Fixes et déterministes : une 2e exécution retombe sur la même conversation.
const USER_A = '5170a11e-0000-4000-8000-00000000000a';
const USER_B = '5170a11e-0000-4000-8000-00000000000b';
const RT_TIMEOUT_MS = 2000;

// --------------------------------------------------------------------------- //
// Tiny logger + result tracking
// --------------------------------------------------------------------------- //
type StepResult = { n: number; label: string; ok: boolean; detail?: string };
const results: StepResult[] = [];
let stepNo = 0;

const log = {
  step: (label: string) => console.log(`\n\x1b[1m▶ Étape ${++stepNo} — ${label}\x1b[0m`),
  ok: (msg: string) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`),
  fail: (msg: string) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`),
  info: (msg: string) => console.log(`  \x1b[90m·\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`  \x1b[33m!\x1b[0m ${msg}`),
};

function record(label: string, ok: boolean, detail?: string): void {
  results.push({ n: stepNo, label, ok, detail });
  if (ok) log.ok(detail ?? 'OK');
  else log.fail(detail ?? 'ÉCHEC');
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

async function api<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  log.info(`${method} ${path} → HTTP ${res.status}`);
  log.info(`   payload: ${JSON.stringify(parsed)}`);
  return { status: res.status, ok: res.ok, body: parsed as T };
}

/** Resolves with the first `event` payload matching `predicate`, or rejects on timeout. */
function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout ${timeoutMs} ms en attente de "${event}"`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
async function main(): Promise<void> {
  console.log(`Cible : ${BASE_URL}  |  NATS : ${NATS_URL}`);

  if (!JWT_SECRET) {
    console.error('\n\x1b[31mMESSAGING_JWT_SECRET absent du .env — abandon.\x1b[0m');
    process.exit(1);
  }

  let nats: NatsConnection | undefined;
  let socketB: Socket | undefined;
  const natsEvents: { subject: string; payload: Record<string, unknown> }[] = [];

  try {
    // --- Étape 1 : JWT HS256 (même lib que src/auth/auth.service.ts) --------- //
    log.step('Génération des deux JWT (HS256)');
    const jwt = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '10m' } });
    const tokenA = jwt.sign({ sub: USER_A });
    const tokenB = jwt.sign({ sub: USER_B });
    record('JWT générés', Boolean(tokenA && tokenB), `userA=${USER_A}, userB=${USER_B}`);

    // --- Étape 2 : abonnement NATS AVANT toute écriture --------------------- //
    log.step('Connexion NATS + abonnement aux 3 sujets d’intégration');
    nats = await connect({ servers: NATS_URL, name: 'smoke-test', timeout: 3000 });
    const codec = JSONCodec<Record<string, unknown>>();
    for (const subject of Object.values(NATS_SUBJECTS)) {
      const sub = nats.subscribe(subject);
      void (async () => {
        for await (const msg of sub) {
          const payload = codec.decode(msg.data);
          natsEvents.push({ subject, payload });
          const leaksContent = Object.prototype.hasOwnProperty.call(payload, 'content');
          log.info(
            `NATS ⟵ ${subject} : ${JSON.stringify(payload)}` +
              (leaksContent ? '  \x1b[31m⚠ contient "content"\x1b[0m' : ''),
          );
        }
      })();
    }
    record('Abonné à NATS', true, Object.values(NATS_SUBJECTS).join(', '));

    // --- Étape 3 : client Socket.IO authentifié en userB ------------------- //
    log.step('Connexion Socket.IO (userB) + écouteurs message:new / message:read');
    socketB = io(BASE_URL, {
      auth: { token: tokenB },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout connexion Socket.IO')), 5000);
      socketB!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socketB!.once('connect_error', (err: Error) => {
        clearTimeout(t);
        reject(err);
      });
    });
    socketB.on('message:new', (p: unknown) =>
      log.info(`SOCKET ⟵ message:new : ${JSON.stringify(p)}`),
    );
    socketB.on('message:read', (p: unknown) =>
      log.info(`SOCKET ⟵ message:read : ${JSON.stringify(p)}`),
    );
    record('Socket.IO connecté (userB)', socketB.connected, `id=${socketB.id}`);

    // --- Étape 4 : POST /conversations (userA) ----------------------------- //
    log.step('POST /conversations (userA)');
    const convRes = await api<{ id: string; lastMessageAt: string | null }>(
      'POST',
      '/conversations',
      tokenA,
      { participantId: USER_B },
    );
    const conversationId = convRes.body?.id;
    record(
      'Conversation obtenue',
      (convRes.status === 201 || convRes.status === 200) && Boolean(conversationId),
      `id=${conversationId ?? '—'} (HTTP ${convRes.status})`,
    );
    if (!conversationId) {
      log.warn('Pas d’id de conversation → étapes suivantes ignorées.');
      return;
    }

    // --- Étape 5 : conversation:join (userB) ------------------------------- //
    // Le gateway répond en émettant l'événement `conversation:joined` (WsResponse
    // NestJS `{ event, data }`), pas via un ack Socket.IO.
    log.step('conversation:join (userB)');
    try {
      const joinedPromise = waitForEvent<unknown>(
        socketB,
        'conversation:joined',
        () => true,
        RT_TIMEOUT_MS,
      );
      socketB.emit('conversation:join', { conversationId });
      const joined = await joinedPromise;
      record('Room rejointe', true, `conversation:joined data=${JSON.stringify(joined)}`);
    } catch (err) {
      record('Room rejointe', false, (err as Error).message);
    }

    // --- Étape 6 : POST message (userA) + réception message:new (userB) --- //
    log.step('POST /conversations/:id/messages (userA) + diffusion temps réel');
    const testContent = `smoke test ${new Date().toISOString()}`;
    const newMsgPromise = waitForEvent<{ id: string; content: string; conversationId: string }>(
      socketB,
      'message:new',
      (p) => p.conversationId === conversationId && p.content === testContent,
      RT_TIMEOUT_MS,
    );
    const sendRes = await api<{ id: string; content: string; createdAt: string }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      tokenA,
      { content: testContent },
    );
    const messageId = sendRes.body?.id;
    const messageCreatedAt = sendRes.body?.createdAt;
    record(
      'Message créé (REST)',
      (sendRes.status === 201 || sendRes.status === 200) && sendRes.body?.content === testContent,
      `id=${messageId ?? '—'} (HTTP ${sendRes.status})`,
    );
    try {
      const evt = await newMsgPromise;
      record(
        'message:new reçu < 2 s avec le bon contenu',
        evt.content === testContent,
        `content="${evt.content}"`,
      );
    } catch (err) {
      record('message:new reçu < 2 s avec le bon contenu', false, (err as Error).message);
    }

    // --- Étape 7 : GET messages (userB) ---------------------------------- //
    log.step('GET /conversations/:id/messages (userB)');
    const listRes = await api<{ items: { id: string; content: string }[] }>(
      'GET',
      `/conversations/${conversationId}/messages`,
      tokenB,
    );
    const found = listRes.body?.items?.find((m) => m.id === messageId);
    record(
      'Message présent dans la liste paginée',
      Boolean(found) && found?.content === testContent,
      found ? `content="${found.content}"` : 'introuvable',
    );

    // --- Étape 8 : PATCH read (userB) + réception message:read ---------- //
    log.step('PATCH /messages/:id/read (userB) + accusé de lecture temps réel');
    if (!messageId) {
      record('message:read reçu', false, 'pas d’id de message');
    } else {
      const readPromise = waitForEvent<{ messageId: string; readAt: string }>(
        socketB,
        'message:read',
        (p) => p.messageId === messageId,
        RT_TIMEOUT_MS,
      );
      const patchRes = await api<{ id: string; readAt: string | null }>(
        'PATCH',
        `/messages/${messageId}/read`,
        tokenB,
      );
      record(
        'Message marqué lu (REST)',
        patchRes.status === 200 && Boolean(patchRes.body?.readAt),
        `readAt=${patchRes.body?.readAt ?? '—'} (HTTP ${patchRes.status})`,
      );
      try {
        const evt = await readPromise;
        record('message:read reçu', evt.messageId === messageId, `readAt=${evt.readAt}`);
      } catch (err) {
        record('message:read reçu', false, (err as Error).message);
      }
    }

    // --- Étape 9 : GET /conversations (userA) — lastMessageAt à jour ---- //
    log.step('GET /conversations (userA) — lastMessageAt mis à jour');
    const convListRes = await api<{ id: string; lastMessageAt: string | null }[]>(
      'GET',
      '/conversations',
      tokenA,
    );
    const conv = Array.isArray(convListRes.body)
      ? convListRes.body.find((c) => c.id === conversationId)
      : undefined;
    const lastMessageAtOk =
      Boolean(conv?.lastMessageAt) &&
      (!messageCreatedAt || conv?.lastMessageAt === messageCreatedAt);
    record(
      'lastMessageAt reflète le dernier message',
      lastMessageAtOk,
      `lastMessageAt=${conv?.lastMessageAt ?? '—'} / message.createdAt=${messageCreatedAt ?? '—'}`,
    );

    // --- Étape 10 : événements NATS reçus & sans "content" ------------- //
    log.step('Vérification des événements NATS (reçus + jamais de champ "content")');
    await sleep(500); // laisse les messages NATS asynchrones arriver
    const bySubject = (s: string): Record<string, unknown>[] =>
      natsEvents.filter((e) => e.subject === s).map((e) => e.payload);

    const msgCreated = bySubject(NATS_SUBJECTS.messageCreated);
    const msgRead = bySubject(NATS_SUBJECTS.messageRead);
    const convCreated = bySubject(NATS_SUBJECTS.conversationCreated);

    record(
      `${NATS_SUBJECTS.messageCreated} publié`,
      msgCreated.length > 0,
      `${msgCreated.length} reçu(s)`,
    );
    record(`${NATS_SUBJECTS.messageRead} publié`, msgRead.length > 0, `${msgRead.length} reçu(s)`);
    if (convCreated.length > 0) {
      record(`${NATS_SUBJECTS.conversationCreated} publié`, true, `${convCreated.length} reçu(s)`);
    } else {
      log.warn(
        `${NATS_SUBJECTS.conversationCreated} non reçu — normal si la conversation ${USER_A}/${USER_B} existait déjà (événement émis à la création seulement).`,
      );
    }

    const leaks = natsEvents.filter((e) =>
      Object.prototype.hasOwnProperty.call(e.payload, 'content'),
    );
    record(
      'Aucun événement NATS ne contient "content"',
      leaks.length === 0,
      leaks.length === 0
        ? 'OK'
        : `${leaks.length} fuite(s) : ${leaks.map((l) => l.subject).join(', ')}`,
    );
  } catch (err) {
    log.fail(`Erreur inattendue : ${(err as Error).message}`);
    results.push({ n: stepNo, label: 'Exécution', ok: false, detail: (err as Error).message });
  } finally {
    // --- Fermeture propre --------------------------------------------- //
    console.log('\n\x1b[1m▶ Fermeture des connexions\x1b[0m');
    try {
      socketB?.close();
      log.info('Socket.IO fermé');
    } catch (err) {
      log.warn(`Socket.IO : ${(err as Error).message}`);
    }
    try {
      await nats?.drain();
      log.info('NATS drainé');
    } catch (err) {
      log.warn(`NATS : ${(err as Error).message}`);
    }
  }

  // --- Résumé -------------------------------------------------------- //
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('\n\x1b[1m═══ Résumé ═══\x1b[0m');
  for (const r of results) {
    const mark = r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n  ${passed}/${total} vérifications réussies.`);
  process.exit(passed === total ? 0 : 1);
}

void main();
