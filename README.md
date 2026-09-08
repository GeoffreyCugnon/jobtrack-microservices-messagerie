# MS-Messagerie

Squelette d'un micro-service de **messagerie one-to-one** : NestJS + TypeScript + Prisma + PostgreSQL + Socket.IO, avec publication d'événements d'intégration sur **NATS**.

## Nature du dépôt

Ce dépôt est un **template**. Il n'est **pas multi-tenant** : chaque projet hôte déploie **sa propre instance isolée** — sa base PostgreSQL dédiée, son propre process, son propre secret JWT. Aucune donnée ne porte d'identifiant de projet ; l'isolation est garantie par le déploiement, pas par le modèle de données.

PostgreSQL et NATS sont attendus comme **déjà disponibles**, déployés indépendamment de ce dépôt : il suffit de renseigner `MESSAGING_DATABASE_URL` et `MESSAGING_NATS_URL` dans `.env` pour pointer vers ces instances.

Le code fourni est volontairement minimal : c'est un squelette fonctionnel, pas l'implémentation complète.

## Contrat d'authentification (côté client hôte)

- Toutes les routes REST et la connexion WebSocket sont protégées par un guard commun `AppAuthGuard`.
- Le client présente un **JWT signé en HS256** avec le secret `MESSAGING_JWT_SECRET`.
- Le claim **`sub`** du token est traité comme l'identifiant de l'utilisateur (fourni par le projet hôte ; **format UUID** — les identifiants passés à l'API, ex. `participantId`, sont validés comme tels).
- **REST** : header `Authorization: Bearer <jwt>`.
- **WebSocket** : `io(url, { auth: { token: '<jwt>' } })` (ou header `Authorization`, ou `?token=<jwt>`).
- Le service **n'émet pas** de token : c'est au projet hôte de le générer et de le distribuer à ses clients.
- Seule exception au guard : `GET /health`, volontairement public.

## CORS

Le CORS HTTP et le CORS Socket.IO partagent **une liste blanche explicite** (plus de `origin: '*'`), pilotée par `MESSAGING_CORS_ORIGINS` (URLs séparées par des virgules). À défaut : les origines de dev Vite (`localhost:5173`, `localhost:5174`). **Renseigner le domaine de prod avant tout déploiement.**

## Démarrage

```bash
cp .env.example .env           # renseigner MESSAGING_DATABASE_URL, MESSAGING_NATS_URL, MESSAGING_JWT_SECRET
npm install                    # installe les deps et génère le client Prisma (postinstall)
npm run prisma:migrate:dev     # applique les migrations
npm run start:dev
```

PostgreSQL et NATS doivent déjà être accessibles aux URLs renseignées dans `.env` avant de lancer ces commandes.

Si NATS est injoignable au démarrage, le service **démarre quand même** : la connexion échoue en silence (log `warn`). Les événements d'intégration produits entre-temps sont mis en file et retentés par l'`OutboxService` (cf. plus bas) — mais cette file est **en mémoire** : elle est perdue si le process s'arrête.

En production : `npm run build && npm run prisma:migrate && npm run start:prod`.

## Endpoints REST

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/conversations` | Conversations de l'utilisateur authentifié, triées par `lastMessageAt` |
| `POST` | `/conversations` | Ouvre (ou récupère) la conversation avec `{ "participantId": "..." }` |
| `GET` | `/conversations/:id/messages` | Messages paginés **par curseur** (`?cursor=<messageId>&limit=<1..100>`, borné aussi côté service) |
| `POST` | `/conversations/:id/messages` | Envoi d'un message — **fallback REST** si le WebSocket est indisponible |
| `PATCH` | `/messages/:id/read` | Marque **un** message comme lu (interdit à l'expéditeur ; idempotent) |
| `PATCH` | `/conversations/:id/messages/read` | Marque **tous** les messages reçus non lus de la conversation comme lus |
| `GET` | `/health` | Sonde **publique** (sans JWT, hors rate limiting) : `{ status, database, nats }` |

Pagination : la réponse est `{ "items": [...], "nextCursor": "<id|null>" }`. Repasser `nextCursor` dans `?cursor=` pour la page suivante. Les messages sont renvoyés du **plus récent au plus ancien**.

Toutes les routes REST **sauf `/health`** sont soumises à un rate limiting par IP (`429 Too Many Requests` au-delà) — cf. section *Rate limiting*.

## WebSocket (Socket.IO)

Une **room par conversation** : `conversation:{id}`.

**Événements entrants (client → serveur)**

| Événement | Payload | Effet |
|---|---|---|
| `conversation:join` | `{ conversationId }` | Rejoint la room (ack `conversation:joined`) |
| `conversation:leave` | `{ conversationId }` | Quitte la room (ack `conversation:left`) |
| `message:send` | `{ conversationId, content, metadata? }` | Crée le message (équivalent du `POST` REST) — **rate-limité** (5 / 10 s par utilisateur ; `WsException` au-delà) |

La **connexion** WebSocket elle-même est rate-limitée par IP (10 tentatives / 60 s ; socket rejeté au-delà).

**Événements sortants**

| Événement | Portée | Payload |
|---|---|---|
| `message:new` | room `conversation:{id}` | le message créé |
| `message:read` | room `conversation:{id}` | `{ conversationId, messageId, readAt, readBy }` |
| `conversation:read` | room `conversation:{id}` | `{ conversationId, readBy, readAt, count }` (après `PATCH …/messages/read`) |
| `conversation:updated` | room perso `user:{id}` de chaque participant | `{ conversationId }` — signal léger pour rafraîchir la liste des conversations |

La diffusion est découplée des services métier via un `EventEmitter` interne : `MessagesService` émet un événement de domaine, `MessagingGateway` le relaie aux rooms.

## Événements d'intégration NATS

Ce service **publie** des événements sur NATS après chaque écriture réussie en base. C'est un **contrat d'intégration ouvert** : n'importe quel micro-service (par ex. un futur MS de notifications) peut s'y abonner pour réagir, **sans dépendance directe à ce service** et **sans jamais interroger sa base de données**.

- NATS sert **uniquement** au pub/sub sortant. Les appels de l'application hôte vers ce service restent en **REST** ; NATS ne les remplace pas.
- Publication **best-effort** via un **outbox en mémoire** ([src/nats/outbox.service.ts](src/nats/outbox.service.ts)) : `NatsPublisherService.publish()` met l'événement en file, tente une publication immédiate, puis **retente** en cas d'échec avec un backoff (1 s → 5 s → 30 s, 3 tentatives) + un job de drain périodique. Ne bloque jamais la transaction métier, ne relance jamais vers l'appelant.
- ⚠️ File **en mémoire** : un crash du process perd les événements non encore publiés. L'outbox **transactionnel durable** (table Prisma écrite dans la même transaction que le message, garantie *at-least-once*) reste à faire.
- Encodage : JSON (`JSONCodec`). Les `Date` sont sérialisées en ISO 8601.

| Sujet | Payload | Déclenché après |
|---|---|---|
| `messaging.conversation.created` | `{ conversationId, userAId, userBId, createdAt }` | création d'une nouvelle conversation |
| `messaging.message.created` | `{ messageId, conversationId, senderId, createdAt }` | envoi d'un message (**sans le contenu**) |
| `messaging.message.read` | `{ messageId, conversationId, readAt }` | passage effectif d'un message à l'état lu |

Configuration : `MESSAGING_NATS_URL` (ex. `nats://localhost:4222`). Le module `NatsModule` ouvre la connexion partagée ; `NatsPublisherService` (→ `OutboxService`) est appelé depuis `ConversationsService` et `MessagesService`.

## Rate limiting

- **REST** — `@nestjs/throttler`, par IP, sur toutes les routes sauf `/health`. `429 Too Many Requests` au-delà. Défaut **100 req / 60 s**, surchargeable : `MESSAGING_REST_THROTTLE_LIMIT`, `MESSAGING_REST_THROTTLE_TTL_MS`.
- **WebSocket** — `WsRateLimiterService` (fenêtre glissante en mémoire) :
  - `message:send` : **5 / 10 s par utilisateur** (`MESSAGING_WS_SEND_LIMIT`, `MESSAGING_WS_SEND_TTL_MS`) — `WsException` au-delà ;
  - handshake de connexion : **10 / 60 s par IP** (`MESSAGING_WS_CONNECT_LIMIT`, `MESSAGING_WS_CONNECT_TTL_MS`) — socket rejeté au-delà.
- Stockage **en mémoire process** : cohérent avec le modèle « une instance isolée par projet hôte ». Pour du multi-instance derrière un load-balancer, remplacer par un store partagé (Redis).
- Les défauts sont volontairement plus permissifs que les valeurs indicatives de l'audit (cf. commentaires dans `.env.example`) : protéger d'un flood sans gêner un usage normal.

## Modèle de données

Voir [prisma/schema.prisma](prisma/schema.prisma). Deux modèles : `Conversation` et `Message`.

- À l'insertion d'une conversation, l'ordre des identifiants est **normalisé** (`userAId < userBId`) pour qu'une même paire d'utilisateurs ne puisse jamais produire deux conversations (contrainte `@@unique([userAId, userBId])`).
- La migration [`20250101000100_unread_messages_partial_index`](prisma/migrations/20250101000100_unread_messages_partial_index/migration.sql) ajoute manuellement l'index **partiel** `idx_messages_unread` sur `("conversationId") WHERE "readAt" IS NULL`, qui reste petit et sert les recherches de messages non lus.

Si Prisma signale une dérive sur la migration d'init (générée à la main pour que l'index partiel ait un socle), un `npm run prisma:migrate:dev -- --name init` sur une base vierge régénère un socle cohérent.

## Structure

```
src/
  auth/          AppAuthGuard (+ décorateur @Public), AuthService (vérif JWT), @CurrentUser
  conversations/ ConversationsModule — création (ordre normalisé) et liste, publie messaging.conversation.created
  messages/      MessagesModule — envoi, lecture, pagination par curseur, publie messaging.message.{created,read}
  messaging/     MessagingGateway — Socket.IO, room par conversation ; WsRateLimiterService (throttle handshake + message:send)
  nats/          NatsModule — connexion partagée, OutboxService (retry), NatsPublisherService, sujets & payloads d'intégration
  health/        HealthController — GET /health public (sonde Prisma + NATS)
  prisma/        PrismaService / PrismaModule
  common/        événements internes, CORS partagé, constantes de rate limiting, validateurs (assert, @MaxJsonSize)
scripts/
  smoke-test.ts  test manuel end-to-end sur infra réelle (npm run smoke-test)
```

## Tests

```bash
npm test          # ~60 tests unitaires : guard (+ @Public), services conversations & messages, gateway,
                  #   OutboxService (retry/backoff), WsRateLimiterService, CORS, @MaxJsonSize
npm run test:e2e  # e2e (Prisma + NATS mockés) : boot, guard sur /conversations, validation 400,
                  #   throttle 429, GET /health public
```

Couverture indicative : ~64 % statements / ~55 % branches.

### Smoke test end-to-end (manuel, infra réelle)

[scripts/smoke-test.ts](scripts/smoke-test.ts) exerce le flux complet contre le **vrai service** et la **vraie infra** — ce n'est **pas** un test Jest, c'est un script à lancer à la main pour observer le comportement réel.

Prérequis (tout doit déjà tourner) :

- `npm run start:dev` lancé (port lu depuis `.env`, `3001` dans l'exemple) ;
- les containers `postgres-messaging` et `nats-messaging` up et accessibles aux URLs du `.env`.

```bash
npm run smoke-test
```

Le script (via `tsx`, `dotenv` pour lire `.env`) : génère 2 JWT HS256 pour deux `sub` **UUID** fixes (`userA`, `userB`) avec la même lib que `AppAuthGuard` ; ouvre un abonnement NATS aux 3 sujets `messaging.*` **avant** toute écriture ; connecte un client Socket.IO authentifié en `userB` ; crée une conversation (`userA`), y poste un message (`userA`), vérifie la réception temps réel de `message:new` par `userB` (< 2 s), relit via REST, marque lu (`userB`), vérifie `message:read` et la mise à jour de `lastMessageAt` ; contrôle enfin que les événements NATS sont bien publiés et **ne contiennent jamais `content`**. Il ferme proprement les connexions et affiche un résumé `N/M vérifications réussies` (code de sortie `0` si tout passe, `1` sinon).

> `messaging.conversation.created` n'est émis qu'à la **création** de la paire : sur une 2ᵉ exécution avec les mêmes UUID, cette vérification est signalée en avertissement (non bloquant).

## Hors périmètre

Pas de présence/typing, d'édition ou suppression de messages, ni de persistance des rooms. Côté NATS : la file de retry est **en mémoire** — pas d'outbox transactionnel durable, pas de garantie *at-least-once*. À compléter selon les besoins du projet hôte.
