# MS-Messagerie

Squelette d'un micro-service de **messagerie one-to-one** : NestJS 11 + TypeScript + Prisma 7 + PostgreSQL + Socket.IO, avec publication d'événements d'intégration sur **NATS** (via un **outbox transactionnel durable**).

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
- Exceptions au guard : `GET /health`, `GET /metrics` et `GET /docs`, volontairement publics.
- Un `RolesGuard` lit le claim optionnel **`roles`** du JWT, mais reste **inactif** tant qu'aucun handler n'est décoré `@Roles(...)` (aucun aujourd'hui — l'hôte JobTrack n'émet pas ce claim).

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

Si NATS est injoignable au démarrage, le service **démarre quand même** : `NatsConnectionManager` retente la connexion en tâche de fond (toutes les 10 s) jusqu'à réussir, puis s'appuie sur la reconnexion automatique de la lib. Les événements d'intégration produits entre-temps sont **persistés en base** (table `OutboxEvent`, écrite dans la transaction de l'écriture métier) et publiés dès que NATS revient — rien n'est perdu à un crash.

En production : `npm run build && npm run prisma:migrate && npm run start:prod`. Ou via Docker : voir *Déploiement Docker* plus bas.

Si `MESSAGING_CORS_ORIGINS` n'est pas défini, le service **log un `warn` au démarrage** et retombe sur les origines de dev Vite — à définir pour toute instance déployée (sinon les appels navigateur, HTTP et WebSocket, sont bloqués).

### Démo / test manuel

```bash
npm run token                  # mint un JWT (sub = UUID aléatoire, 24h) + exemples curl/WS
npm run token -- <uuid>        # ... pour un sub imposé
npm run seed:demo              # amorce une conversation Alice↔Bob (6 messages, 1 non lu) + affiche leurs 2 tokens
```

`seed:demo` écrit directement en base (idempotent, ne déclenche ni WS ni NATS) : lancer l'app **après** pour voir le fil. Le service n'émet aucun token lui-même — `npm run token` reproduit exactement la signature attendue (`src/auth/auth.service.ts`).

## Endpoints REST

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/conversations` | Page de conversations de l'appelant (**curseur** : `?cursor=<id>&limit=<1..100>`, défaut 30), triées par `lastMessageAt` |
| `GET` | `/conversations/:id` | Une conversation de l'appelant, avec son `unreadCount` (participant ; 404 si supprimée) |
| `POST` | `/conversations` | Ouvre (ou récupère) la conversation avec `{ "participantId": "..." }` — réactive une conversation supprimée |
| `DELETE` | `/conversations/:id` | Soft-delete (masque la conversation pour les deux participants ; idempotent) |
| `POST` | `/conversations/:id/restore` | Restaure une conversation soft-deletée (**200**) |
| `GET` | `/conversations/:id/messages` | Messages paginés **par curseur** (`?cursor=<messageId>&limit=<1..100>`, borné aussi côté service) |
| `POST` | `/conversations/:id/messages` | Envoi d'un message — **fallback REST** si le WebSocket est indisponible (`content` est trimé) |
| `GET` | `/messages/:id` | Un message par id (participants ; 404 si supprimé) |
| `PATCH` | `/messages/:id/read` | Marque **un** message comme lu (interdit à l'expéditeur ; idempotent) |
| `PATCH` | `/conversations/:id/messages/read` | Marque **tous** les messages reçus non lus de la conversation comme lus |
| `PATCH` | `/messages/:id` | Édite le contenu (**expéditeur uniquement** ; archive la version précédente ; idempotent si inchangé) |
| `GET` | `/messages/:id/versions` | Historique d'édition (`{ id, content, createdAt }[]`, plus ancien d'abord ; participants) |
| `DELETE` | `/messages/:id` | Soft-delete d'un message (**expéditeur uniquement** ; idempotent) |
| `POST` | `/messages/:id/restore` | Restaure un message soft-deleté (expéditeur ; **200**) |
| `GET` | `/health` | Sonde **publique** (sans JWT, hors rate limiting) : `{ status, database, nats, outboxPending }` — **HTTP 503** si `database` est `down` |
| `GET` | `/metrics` | Exposition **Prometheus** (publique, hors rate limiting) : métriques HTTP (`http_requests_total`, `http_request_duration_seconds`), WebSocket (`ws_connections_active`, `ws_messages_sent_total`), `outbox_pending_events`, + métriques process par défaut |
| `GET` | `/docs` | Documentation **OpenAPI** interactive (Swagger UI). Désactivable via `MESSAGING_ENABLE_DOCS=false` |

Pagination (`GET /conversations` et `GET /conversations/:id/messages`) : la réponse est `{ "items": [...], "nextCursor": "<id|null>" }`. Repasser `nextCursor` dans `?cursor=` pour la page suivante. Les messages sont renvoyés du **plus récent au plus ancien** ; les conversations, les plus récemment actives d'abord.

Toutes les routes REST **sauf `/health` et `/metrics`** sont soumises à un rate limiting par IP (`429 Too Many Requests` au-delà) — cf. section *Rate limiting*.

## WebSocket (Socket.IO)

Une **room par conversation** : `conversation:{id}`.

**Événements entrants (client → serveur)**

| Événement | Payload | Effet |
|---|---|---|
| `conversation:join` | `{ conversationId }` | Rejoint la room (ack `conversation:joined`) |
| `conversation:leave` | `{ conversationId }` | Quitte la room (ack `conversation:left`) |
| `message:send` | `{ conversationId, content, metadata? }` | Crée le message (équivalent du `POST` REST) — **rate-limité** (5 / 10 s par utilisateur ; `WsException` au-delà) |
| `typing:start` / `typing:stop` | `{ conversationId }` | Indicateur « en train d'écrire » — contrôle de participation, **rate-limité** (20 / 10 s par utilisateur ; refus **silencieux**). Rien n'est persisté |

La **connexion** WebSocket elle-même est rate-limitée par IP (10 tentatives / 60 s ; socket rejeté au-delà).

**Événements sortants**

| Événement | Portée | Payload |
|---|---|---|
| `message:new` | room `conversation:{id}` | le message créé (contenu en clair) |
| `message:read` | room `conversation:{id}` | `{ conversationId, messageId, readAt, readBy }` |
| `message:edited` | room `conversation:{id}` | le message édité (contenu en clair) |
| `message:deleted` | room `conversation:{id}` | `{ conversationId, messageId, deletedBy }` |
| `conversation:read` | room `conversation:{id}` | `{ conversationId, readBy, readAt, count }` (après `PATCH …/messages/read`) |
| `conversation:updated` | room perso `user:{id}` de chaque participant | `{ conversationId }` — signal léger pour rafraîchir la liste des conversations |
| `typing` | room `conversation:{id}` (hors émetteur) | `{ conversationId, userId, typing }` — `typing` vaut `true` (`typing:start`) ou `false` (`typing:stop`) |

La diffusion est découplée des services métier via un `EventEmitter` interne : `MessagesService` émet un événement de domaine, `MessagingGateway` le relaie aux rooms.

## Événements d'intégration NATS

Ce service **publie** des événements sur NATS après chaque écriture réussie en base. C'est un **contrat d'intégration ouvert** : n'importe quel micro-service (par ex. un futur MS de notifications) peut s'y abonner pour réagir, **sans dépendance directe à ce service** et **sans jamais interroger sa base de données**.

- NATS sert **uniquement** au pub/sub sortant. Les appels de l'application hôte vers ce service restent en **REST** ; NATS ne les remplace pas.
- **Outbox transactionnel durable** ([src/nats/outbox.service.ts](src/nats/outbox.service.ts)) : `OutboxService.enqueueInTx(tx, subject, payload)` insère la ligne `OutboxEvent` **dans la même transaction Prisma** que l'écriture métier. Un job de drain (toutes les 5 s + réveil après chaque commit) publie les lignes `publishedAt IS NULL` sur NATS — en core, `flush()` avant de marquer publié ; en JetStream, `js.publish()` attend directement l'ACK — puis retente avec backoff `[1 s, 5 s, 15 s, 60 s, 300 s]` avant de marquer `failedAt`. Garantie **at-least-once** (consommateurs à rendre idempotents). Ne bloque jamais la transaction métier.
- Encodage : JSON (`JSONCodec`). Les `Date` sont sérialisées en ISO 8601 (chaîne, stockée telle quelle dans `OutboxEvent.payload`).

| Sujet | Payload | Déclenché après |
|---|---|---|
| `messaging.conversation.created` | `{ conversationId, userAId, userBId, createdAt }` | création d'une nouvelle conversation |
| `messaging.message.created` | `{ messageId, conversationId, senderId, createdAt }` | envoi d'un message (**sans le contenu**) |
| `messaging.message.read` | `{ messageId, conversationId, readAt }` | passage effectif d'un message à l'état lu |
| `messaging.conversation.read` | `{ conversationId, readBy, readAt, count }` | lecture **en masse** (`PATCH …/messages/read`) — accusé agrégé |

L'édition et la suppression de messages ne publient **pas** sur NATS (contrat volontairement restreint ; à étendre si un consommateur l'exige).

Configuration : `MESSAGING_NATS_URL` (ex. `nats://localhost:4222`), `MESSAGING_OUTBOX_DRAIN_MS` (défaut 5000). `NatsConnectionManager` possède la connexion (reconnexion automatique + re-probe si down au démarrage) ; `OutboxService` est appelé depuis `ConversationsService` et `MessagesService`.

**JetStream (optionnel)** : `MESSAGING_NATS_JETSTREAM=true` fait publier l'outbox dans un stream persistant (`MESSAGING_NATS_STREAM_NAME`, défaut `MESSAGING`, sujets `messaging.>`, `MESSAGING_NATS_STREAM_MAX_AGE_MS` optionnel) créé/aligné à la connexion — `js.publish()` attend l'ACK serveur (pas de `flush`). Sans ça, publication core NATS fire-and-forget + `flush()`. Les sujets et payloads reçus par les consommateurs sont identiques.

## Rate limiting

- **REST** — `RestRateLimitGuard`, par IP, sur toutes les routes sauf `/health` et `/metrics`. `429 Too Many Requests` au-delà. Défaut **100 req / 60 s**, surchargeable : `MESSAGING_REST_THROTTLE_LIMIT`, `MESSAGING_REST_THROTTLE_TTL_MS`.
- **WebSocket** — `WsRateLimiterService` :
  - `message:send` : **5 / 10 s par utilisateur** (`MESSAGING_WS_SEND_LIMIT`, `MESSAGING_WS_SEND_TTL_MS`) — `WsException` au-delà ;
  - `typing:start` / `typing:stop` : **20 / 10 s par utilisateur** (`MESSAGING_WS_TYPING_LIMIT`, `MESSAGING_WS_TYPING_TTL_MS`) — refus silencieux ;
  - handshake de connexion : **10 / 60 s par IP** (`MESSAGING_WS_CONNECT_LIMIT`, `MESSAGING_WS_CONNECT_TTL_MS`) — socket rejeté au-delà.
- **Backend** — `RateLimiterFactory` choisit au démarrage :
  - **mémoire process** (fenêtre glissante exacte) par défaut — cohérent avec « une instance isolée par projet hôte » ;
  - **Redis partagé** (fenêtre fixe `INCR`+`PEXPIRE`) si `MESSAGING_REDIS_URL` est défini — buckets communs à toutes les instances derrière un load-balancer.
- **Derrière un reverse proxy**, la clé de bucket doit être l'IP du client final, pas celle du proxy : `MESSAGING_TRUST_PROXY` (défaut `1` — un hop) pilote `app.set('trust proxy', …)` (Express → `req.ip` depuis `X-Forwarded-For`) et la résolution d'IP du handshake WebSocket. Mettre `false` pour une exposition directe.
- Les défauts sont volontairement plus permissifs que les valeurs indicatives de l'audit (cf. commentaires dans `.env.example`) : protéger d'un flood sans gêner un usage normal.

## Sécurité complémentaire

- **Chiffrement du contenu au repos** — si `MESSAGING_CONTENT_ENCRYPTION_KEY` (32 octets, base64/hex) est défini, `Message.content` et `MessageVersion.content` sont chiffrés en **AES-256-GCM** (format `v1:<iv>:<tag>:<ciphertext>`). Sans clé : stockage en clair, rétro-compatible. Les clients (REST + WebSocket) reçoivent **toujours** le contenu en clair ; les payloads NATS n'ont jamais porté de contenu. Les lignes en clair écrites avant l'activation de la clé restent lisibles — ne pas retirer/roter la clé tant que des lignes `v1:` existent.
- **Expiration des tokens** — `MESSAGING_JWT_MAX_AGE` (ex. `24h`, `3600`) rejette tout JWT dont l'`iat` dépasse cet âge (garde-fou contre un token sans `exp`). **Activé par défaut à `24h`** ; mettre `off` pour désactiver.
- **Journal d'audit** — `AuditService` (best-effort, ne bloque jamais) écrit dans la table `AuditLog` : `conversation.{created,deleted,restored,read}`, `message.{sent,read,edited,deleted,restored}`. Aucune route de lecture exposée (accès base / outil d'exploitation).
- **Soft-delete** — conversations et messages portent un `deletedAt` ; toutes les lectures filtrent `deletedAt IS NULL`. Rien n'est purgé physiquement par le service.

## Modèle de données

Voir [prisma/schema.prisma](prisma/schema.prisma). Modèles : `Conversation`, `Message`, `MessageVersion`, `AuditLog`, `OutboxEvent`.

- À l'insertion d'une conversation, l'ordre des identifiants est **normalisé** (`userAId < userBId`) pour qu'une même paire d'utilisateurs ne puisse jamais produire deux conversations (contrainte `@@unique([userAId, userBId])`).
- `Conversation.deletedAt` / `Message.deletedAt` (soft-delete, indexés). `Message.editedAt` / `editCount` + `MessageVersion` (historique, cascade delete).
- `OutboxEvent` : outbox transactionnel NATS (cf. *Événements d'intégration NATS*). Index partiel `idx_outbox_pending` sur `("nextAttemptAt") WHERE "publishedAt" IS NULL AND "failedAt" IS NULL`.
- `AuditLog` : journal d'audit (index sur `userId`, `action`, `(resourceType, resourceId)`).
- La migration [`20250101000100_unread_messages_partial_index`](prisma/migrations/20250101000100_unread_messages_partial_index/migration.sql) ajoute manuellement l'index **partiel** `idx_messages_unread` sur `("conversationId") WHERE "readAt" IS NULL`, qui reste petit et sert les recherches de messages non lus.

Si Prisma signale une dérive sur la migration d'init (générée à la main pour que l'index partiel ait un socle), un `npm run prisma:migrate:dev -- --name init` sur une base vierge régénère un socle cohérent.

## Structure

```
src/
  auth/          AppAuthGuard (+ @Public), RolesGuard (+ @Roles), AuthService (vérif JWT + maxAge + roles), @CurrentUser
  conversations/ ConversationsModule — création/liste paginée, soft-delete/restore, publie messaging.conversation.{created,read}
  messages/      MessagesModule — envoi, lecture, pagination, édition + versions, soft-delete/restore ; ContentCipherService
  messaging/     MessagingGateway — Socket.IO, room par conversation, typing ; WsRateLimiterService ; WsExceptionFilter
  nats/          NatsModule — NatsConnectionManager (reconnexion + JetStream optionnel), OutboxService (outbox durable), sujets
  audit/         AuditModule — AuditService (journal best-effort, table AuditLog)
  metrics/       MetricsModule — GET /metrics (Prometheus), MetricsInterceptor (durée/volume HTTP)
  retention/     RetentionModule — RetentionService (@Cron 03:00 : purge AuditLog + OutboxEvent)
  observability/ nestjs-pino (logs JSON + x-request-id), AllExceptionsFilter (réponse d'erreur uniforme)
  health/        HealthController — GET /health public (sonde Prisma + NATS + outbox pending ; 503 si DB down)
  prisma/        PrismaService / PrismaModule
  common/        événements internes, CORS partagé, trust proxy, rate limit (guard REST + factory mémoire/Redis + constantes),
                 ContentCipherService, validateurs (assert, @MaxJsonSize), helpers de test
scripts/
  smoke-test.ts  test manuel end-to-end sur infra réelle (npm run smoke-test)
  mint-token.ts  génère un JWT accepté par le service (npm run token)
  seed-demo.ts   amorce une conversation de démo en base (npm run seed:demo)
```

## Tests

```bash
npm test          # ~134 tests unitaires : guards (auth + roles), services conversations & messages (envoi, lecture,
                  #   édition/versions, soft-delete, transaction + outbox), OutboxService (+ JetStream), NatsConnectionManager,
                  #   ContentCipherService, AuditService, RetentionService, MetricsService, rate limiter (mémoire + factory),
                  #   WsRateLimiterService, gateway (+ typing), CORS, @MaxJsonSize
npm run test:e2e  # e2e (Prisma + NATS mockés) : boot, guard sur les routes, validation 400, rate limit 429,
                  #   GET /health public, GET /metrics, header x-request-id, routes soft-delete/edit guardées
npm run typecheck # tsc --noEmit (src + test + scripts)
npm run lint:ci   # eslint --max-warnings 0 (sans --fix) — utilisé par la CI
```

### Smoke test end-to-end (manuel, infra réelle)

[scripts/smoke-test.ts](scripts/smoke-test.ts) exerce le flux complet contre le **vrai service** et la **vraie infra** — ce n'est **pas** un test Jest, c'est un script à lancer à la main pour observer le comportement réel.

Prérequis (tout doit déjà tourner) :

- `npm run start:dev` lancé (port lu depuis `.env`, `3001` dans l'exemple) ;
- les containers `postgres-messaging` et `nats-messaging` up et accessibles aux URLs du `.env`.

```bash
npm run smoke-test
```

Le script (via `tsx`, `dotenv` pour lire `.env`) : génère 2 JWT HS256 pour deux `sub` **UUID** fixes (`userA`, `userB`) avec la même lib que `AppAuthGuard` ; ouvre un abonnement NATS à tous les sujets `messaging.*` **avant** toute écriture ; connecte un client Socket.IO authentifié en `userB` ; crée une conversation (`userA`), y poste un message (`userA`), vérifie la réception temps réel de `message:new` par `userB` (< 2 s), relit via REST, marque lu (`userB`), vérifie `message:read` et la mise à jour de `lastMessageAt` ; contrôle enfin que les événements NATS sont bien publiés et **ne contiennent jamais `content`**. Il ferme proprement les connexions et affiche un résumé `N/M vérifications réussies` (code de sortie `0` si tout passe, `1` sinon).

> `messaging.conversation.created` n'est émis qu'à la **création** de la paire : sur une 2ᵉ exécution avec les mêmes UUID, cette vérification est signalée en avertissement (non bloquant).

## Déploiement Docker

```bash
MESSAGING_JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

> ⚠️ Le `Dockerfile` / `docker-compose.yml` n'ont **pas encore été `docker build`-és** (pas de Docker dans l'environnement de dev). Faire un `docker compose up --build` réel avant tout déploiement.

`docker-compose.yml` monte : `postgres` (avec healthcheck), `nats`, un service **`migrate`** one-shot (`prisma migrate deploy`, exécuté avant l'app) puis `ms-messagerie`. Le `Dockerfile` est multi-stage : `builder` (toolchain complète + `prisma generate` + `nest build`, réutilisé comme cible du `migrate`) et `runtime` (`node:20-alpine`, deps de prod uniquement, `dist/` — Prisma 7 en mode driver-adapter n'embarque pas de binaire moteur). Le healthcheck du conteneur interroge `GET /health` (503 si la base est injoignable). Variables surchargeables : `MESSAGING_CORS_ORIGINS`, `MESSAGING_TRUST_PROXY`, `MESSAGING_JWT_MAX_AGE`, `MESSAGING_CONTENT_ENCRYPTION_KEY`, `MESSAGING_REDIS_URL`, `MESSAGING_NATS_JETSTREAM`, `MESSAGING_LOG_LEVEL`, `MESSAGING_ENABLE_DOCS`, `MESSAGING_RETENTION_*` (cf. `.env.example`).

## Observabilité & durcissement

- **Logs** structurés JSON (`nestjs-pino`), un `x-request-id` par requête (header entrant réutilisé, sinon généré) propagé dans chaque ligne et renvoyé au client. Niveau : `MESSAGING_LOG_LEVEL`.
- **Erreurs** : `AllExceptionsFilter` renvoie `{ statusCode, error, message, timestamp, path, requestId }` ; 5xx logués avec la stack.
- **Métriques** Prometheus sur `GET /metrics`. **OpenAPI** sur `GET /docs` (`MESSAGING_ENABLE_DOCS=false` pour couper).
- **En-têtes** : `helmet` (CSP désactivée — API + Swagger UI ; CORP `cross-origin`).
- **Rétention** : purge quotidienne (`AuditLog`, `OutboxEvent`), cf. `MESSAGING_RETENTION_*`.
- **CI** : `.github/workflows/ci.yml` (`lint:ci` → `typecheck` → `build` → `test` → `test:e2e`, sans infra).

## Hors périmètre

Pas de **présence** ni de persistance des rooms. `RolesGuard` est en place mais **inactif** tant qu'aucun handler n'est décoré `@Roles(...)` et que l'hôte JobTrack n'ajoute pas de claim `roles` au JWT de messagerie. Sentry / error tracking : non retenu.
