# MS-Messagerie

Squelette d'un micro-service de **messagerie one-to-one** : NestJS + TypeScript + Prisma + PostgreSQL + Socket.IO, avec publication d'événements d'intégration sur **NATS**.

## Nature du dépôt

Ce dépôt est un **template**. Il n'est **pas multi-tenant** : chaque projet hôte déploie **sa propre instance isolée** — sa base PostgreSQL dédiée, son propre process, son propre secret JWT. Aucune donnée ne porte d'identifiant de projet ; l'isolation est garantie par le déploiement, pas par le modèle de données.

PostgreSQL et NATS sont attendus comme **déjà disponibles**, déployés indépendamment de ce dépôt : il suffit de renseigner `MESSAGING_DATABASE_URL` et `MESSAGING_NATS_URL` dans `.env` pour pointer vers ces instances.

Le code fourni est volontairement minimal : c'est un squelette fonctionnel, pas l'implémentation complète.

## Contrat d'authentification (côté client hôte)

- Toutes les routes REST et la connexion WebSocket sont protégées par un guard commun `AppAuthGuard`.
- Le client présente un **JWT signé en HS256** avec le secret `MESSAGING_JWT_SECRET`.
- Le claim **`sub`** du token est traité comme l'identifiant de l'utilisateur (chaîne libre, fournie par le projet hôte).
- **REST** : header `Authorization: Bearer <jwt>`.
- **WebSocket** : `io(url, { auth: { token: '<jwt>' } })` (ou header `Authorization`, ou `?token=<jwt>`).
- Le service **n'émet pas** de token : c'est au projet hôte de le générer et de le distribuer à ses clients.

## Démarrage

```bash
cp .env.example .env           # renseigner MESSAGING_DATABASE_URL, MESSAGING_NATS_URL, MESSAGING_JWT_SECRET
npm install                    # installe les deps et génère le client Prisma (postinstall)
npm run prisma:migrate:dev     # applique les migrations
npm run start:dev
```

PostgreSQL et NATS doivent déjà être accessibles aux URLs renseignées dans `.env` avant de lancer ces commandes.

Si NATS est injoignable au démarrage, le service **démarre quand même** : la connexion échoue en silence (log `warn`) et les événements d'intégration sont simplement abandonnés jusqu'au prochain redémarrage.

En production : `npm run build && npm run prisma:migrate && npm run start:prod`.

## Endpoints REST

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/conversations` | Conversations de l'utilisateur authentifié, triées par `lastMessageAt` |
| `POST` | `/conversations` | Ouvre (ou récupère) la conversation avec `{ "participantId": "..." }` |
| `GET` | `/conversations/:id/messages` | Messages paginés **par curseur** (`?cursor=<messageId>&limit=<1..100>`) |
| `POST` | `/conversations/:id/messages` | Envoi d'un message — **fallback REST** si le WebSocket est indisponible |
| `PATCH` | `/messages/:id/read` | Marque un message comme lu |

Pagination : la réponse est `{ "items": [...], "nextCursor": "<id|null>" }`. Repasser `nextCursor` dans `?cursor=` pour la page suivante. Les messages sont renvoyés du **plus récent au plus ancien**.

## WebSocket (Socket.IO)

Une **room par conversation** : `conversation:{id}`.

**Événements entrants (client → serveur)**

| Événement | Payload | Effet |
|---|---|---|
| `conversation:join` | `{ conversationId }` | Rejoint la room |
| `conversation:leave` | `{ conversationId }` | Quitte la room |
| `message:send` | `{ conversationId, content, metadata? }` | Crée le message (équivalent du `POST` REST) |

**Événements sortants (serveur → room)**

| Événement | Payload |
|---|---|
| `message:new` | le message créé |
| `message:read` | `{ conversationId, messageId, readAt, readBy }` |

La diffusion est découplée des services métier via un `EventEmitter` interne : `MessagesService` émet un événement de domaine, `MessagingGateway` le relaie à la room.

## Événements d'intégration NATS

Ce service **publie** des événements sur NATS après chaque écriture réussie en base. C'est un **contrat d'intégration ouvert** : n'importe quel micro-service (par ex. un futur MS de notifications) peut s'y abonner pour réagir, **sans dépendance directe à ce service** et **sans jamais interroger sa base de données**.

- NATS sert **uniquement** au pub/sub sortant. Les appels de l'application hôte vers ce service restent en **REST** ; NATS ne les remplace pas.
- Publication **best-effort** : `NatsPublisherService.publish(subject, payload)` encapsule le client NATS, n'échoue jamais vers l'appelant et ne bloque pas la transaction métier. Un événement perdu est loggé, pas rejoué.
- Pas d'`outbox` transactionnel ni de retry dans ce squelette (voir le `TODO` dans [src/nats/nats.events.ts](src/nats/nats.events.ts)) : la fiabilité de livraison (at-least-once) est à traiter plus tard si un consommateur en a besoin.
- Encodage : JSON (`JSONCodec`). Les `Date` sont sérialisées en ISO 8601.

| Sujet | Payload | Déclenché après |
|---|---|---|
| `messaging.conversation.created` | `{ conversationId, userAId, userBId, createdAt }` | création d'une nouvelle conversation |
| `messaging.message.created` | `{ messageId, conversationId, senderId, createdAt }` | envoi d'un message (**sans le contenu**) |
| `messaging.message.read` | `{ messageId, conversationId, readAt }` | passage effectif d'un message à l'état lu |

Configuration : `MESSAGING_NATS_URL` (ex. `nats://localhost:4222`). Le module `NatsModule` ouvre la connexion partagée ; `NatsPublisherService` est appelé depuis `ConversationsService` et `MessagesService`.

## Modèle de données

Voir [prisma/schema.prisma](prisma/schema.prisma). Deux modèles : `Conversation` et `Message`.

- À l'insertion d'une conversation, l'ordre des identifiants est **normalisé** (`userAId < userBId`) pour qu'une même paire d'utilisateurs ne puisse jamais produire deux conversations (contrainte `@@unique([userAId, userBId])`).
- La migration [`20250101000100_unread_messages_partial_index`](prisma/migrations/20250101000100_unread_messages_partial_index/migration.sql) ajoute manuellement l'index **partiel** `idx_messages_unread` sur `("conversationId") WHERE "readAt" IS NULL`, qui reste petit et sert les recherches de messages non lus.

Si Prisma signale une dérive sur la migration d'init (générée à la main pour que l'index partiel ait un socle), un `npm run prisma:migrate:dev -- --name init` sur une base vierge régénère un socle cohérent.

## Structure

```
src/
  auth/          AppAuthGuard, AuthService (vérif JWT), @CurrentUser
  conversations/ ConversationsModule — création (ordre normalisé) et liste, publie messaging.conversation.created
  messages/      MessagesModule — envoi, lecture, pagination par curseur, publie messaging.message.{created,read}
  messaging/     MessagingGateway — Socket.IO, room par conversation, diffusion
  nats/          NatsModule — connexion NATS partagée + NatsPublisherService, sujets & payloads d'intégration
  prisma/        PrismaService / PrismaModule
  common/        noms et types des événements internes (EventEmitter -> WebSocket)
scripts/
  smoke-test.ts  test manuel end-to-end sur infra réelle (npm run smoke-test)
```

## Tests

```bash
npm test          # unitaires : AppAuthGuard ; publication NATS après création d'un message (client NATS mocké)
npm run test:e2e  # e2e : l'app démarre, le guard protège /conversations, requête authentifiée servie (Prisma + NATS mockés)
```

### Smoke test end-to-end (manuel, infra réelle)

[scripts/smoke-test.ts](scripts/smoke-test.ts) exerce le flux complet contre le **vrai service** et la **vraie infra** — ce n'est **pas** un test Jest, c'est un script à lancer à la main pour observer le comportement réel.

Prérequis (tout doit déjà tourner) :

- `npm run start:dev` lancé (port lu depuis `.env`, `3001` dans l'exemple) ;
- les containers `postgres-messaging` et `nats-messaging` up et accessibles aux URLs du `.env`.

```bash
npm run smoke-test
```

Le script (via `tsx`, `dotenv` pour lire `.env`) : génère 2 JWT HS256 (`smoke-user-a`, `smoke-user-b`) avec la même lib que `AppAuthGuard` ; ouvre un abonnement NATS aux 3 sujets `messaging.*` **avant** toute écriture ; connecte un client Socket.IO authentifié en `userB` ; crée une conversation (`userA`), y poste un message (`userA`), vérifie la réception temps réel de `message:new` par `userB` (< 2 s), relit via REST, marque lu (`userB`), vérifie `message:read` et la mise à jour de `lastMessageAt` ; contrôle enfin que les événements NATS sont bien publiés et **ne contiennent jamais `content`**. Il ferme proprement les connexions et affiche un résumé `N/M vérifications réussies` (code de sortie `0` si tout passe, `1` sinon).

> `messaging.conversation.created` n'est émis qu'à la **création** de la paire : sur une 2ᵉ exécution avec les mêmes `smoke-user-*`, cette vérification est signalée en avertissement (non bloquant).

## Hors périmètre

Pas de présence/typing, d'édition ou suppression de messages, de rate limiting, ni de persistance des rooms. Côté NATS : pas d'outbox transactionnel, pas de retry, pas de garantie at-least-once. À compléter selon les besoins du projet hôte.
