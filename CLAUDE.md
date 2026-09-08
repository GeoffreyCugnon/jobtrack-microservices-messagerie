# Audit complet – MS-Messagerie (NestJS)

Date : 2025-09-08  
Projet : MS-Messagerie (Backend asynchrone, one-to-one)  
Stack : NestJS 10, TypeScript, Prisma 7, PostgreSQL, NATS, Socket.IO  
Version : 0.1.0

---

## Executive Summary

**MS-Messagerie** est un squelette de microservice **bien structuré et modulaire** offrant une base solide pour une solution de messagerie one-to-one temps réel. Le code suit les bonnes pratiques NestJS, exploite des patterns robustes (event emitter interne, pub/sub NATS découplé, pagination par curseur) et bénéficie d'une configuration TypeScript stricte.

**Points forts** : Architecture modulaire claire, séparation des responsabilités, gestion prudente des événements (best-effort), authentification JWT centralisée.

**Axes d'amélioration prioritaires** :
1. Couverture de tests insuffisante (unitaires + E2E limités)
2. Gestion des erreurs NATS au démarrage (log uniquement, pas de retry)
3. Absence de rate limiting et de mécanismes de throttling
4. Pas de validations métier approfondies sur les DTOs
5. Documentation des migrations Prisma incomplète
6. CORS trop permissif en développement (nécessite restriction avant prod)

---

## 0. État des corrections Phase 1 — ✅ COMPLÈTE (2026-09-08)

`npm run build` ✓ · `npm run lint` ✓ · `npm run format` ✓ · `npm test` 22 ✓ · `npm run test:e2e` 6 ✓

| Item | Statut | Détail |
|------|--------|--------|
| **P1 — CORS** | ✅ DONE | Liste blanche explicite unique, partagée HTTP + Socket.IO (`src/common/cors.ts`, `corsOriginCheck`), pilotée par `MESSAGING_CORS_ORIGINS` (défaut : origines Vite `localhost:5173/5174`). Plus de `origin: '*'` sur la gateway ni de regex « tout port localhost » dans `main.ts`. |
| **P2 — Rate limiting** | ✅ DONE | REST : `@nestjs/throttler` v6 câblé dans `AppModule` (`ThrottlerModule.forRoot`) + `RestThrottlerGuard` en `APP_GUARD` **avant** `AppAuthGuard`, no-op hors HTTP. WS : `SlidingWindowRateLimiter` (mémoire, sans dépendance) dans `MessagingGateway` — `message:send` 5/10 s par user, handshake 10/60 s par IP. Tout surchargeable par env. Défauts plus permissifs que l'audit (voir §9.1) — écart assumé, valeurs de l'audit documentées dans `.env.example`. |
| **P3 — Validation DTO** | ✅ DONE | `CreateConversationDto.participantId` → `@IsUUID()`. `content` borné à 5 000 (`SendMessageDto` + `WsSendMessageDto`). `metadata` plafonné à 10 000 octets sérialisés (`@MaxJsonSize`, `src/common/max-json-size.validator.ts`). `ListMessagesQueryDto` était déjà conforme. |

**Les 5 « blockers » d'un plan de reprise ultérieur étaient déjà résolus** (état réel du repo ≠ snapshot de l'audit) :

1. `src/nats/nats.provider.ts` — existe (`natsConnectionProvider`, best-effort, renvoie `null` si NATS injoignable).
2. `src/messaging/dto/ws-messages.dto.ts` — existe (`WsConversationDto`, `WsSendMessageDto`, bornes alignées sur le chemin REST).
3. `ThrottlerModule` — câblé dans `AppModule` (cf. P2).
4. CORS WebSocket — restreint (cf. P1).
5. Migrations Prisma — `prisma/migrations/20250101000000_init/` (tables + FK + index composite + `@@unique`) et `20250101000100_unread_messages_partial_index/` (index partiel `WHERE "readAt" IS NULL`).

**Tests ajoutés** : `src/common/cors.spec.ts`, `src/common/max-json-size.validator.spec.ts`, `src/messaging/ws-rate-limit.spec.ts`, + e2e (400 sur `participantId` non-UUID / propriété inconnue, 429 sur flood REST).

---

## 0 bis. Phase 2 — tests + fiabilité (2026-09-08, branche `feature/phase2-tests`)

`npm run build` ✓ · `npm run lint` ✓ · `npm run format` ✓ · `npm test` **60 ✓** · `npm run test:e2e` **7 ✓** · coverage **64 % stmts / 55 % branches / 66 % funcs / 66 % lines** (cible 50 %).

| Sprint | Livrable | Détail |
|--------|----------|--------|
| **1 — Tests** | ✅ | Fixtures `src/common/test-fixtures.ts` (`TEST_USERS`, `makeConversation`, `makeMessage`). Nouvelles specs : `conversations.service.spec.ts` (findOrCreate happy/existante/P2002/rethrow, listForUser unreadCount, self-check), `messaging.gateway.spec.ts` (handleConnection valide/invalide/rate-limité, join/leave, message:send). Étendues : `messages.service.spec.ts` (paginate curseur + clamp, markRead idempotent/authz/reject-own), `app-auth.guard.spec.ts` (token expiré, court-circuit `@Public()`). |
| **2a — Rate limit WS** | ✅ | `SlidingWindowRateLimiter` (inchangé) extrait dans un provider injectable `WsRateLimiterService` (`src/messaging/rate-limiter.service.ts`) : `allowConnection(ip)` + `allowMessage(userId, socketId)` avec repli `socket:<id>`. Injecté dans `MessagingGateway` ; le timer de purge vit dans le service. |
| **2b — Fiabilité NATS** | ✅ (in-memory) | `OutboxService` (`src/nats/outbox.service.ts`) : file en mémoire, publication immédiate puis retry backoff **1 s → 5 s → 30 s** (max 3 retries) + job de drain toutes les 30 s, garde-fou `MAX_PENDING`. `NatsPublisherService` délègue désormais à `OutboxService` (au lieu de publier en direct). **⚠️ Non durable** : un crash perd la file — l'outbox transactionnel (table Prisma dans la transaction du message) reste Phase 3. |
| **3 — Sécurité** | ✅ | `GET /health` public (`@Public()` + `@SkipThrottle()`) → `{ status, database, nats }`, sonde Prisma `SELECT 1` avec timeout 1 s. `@Public()` géré par `AppAuthGuard` via `Reflector`. Défense en profondeur : `assertUuid` / `assertMessageContent` (`src/common/assert.ts`) dans `ConversationsService.findOrCreate` et `MessagesService.send` ; `paginate` clampe `limit` à 100 côté service. |

**Toujours ouvert (Phase 3)** : outbox transactionnel durable (table `OutboxEvent`), chiffrement `Message.content` au repos (P6), pagination de `listForUser`. Intouché : `prisma/schema.prisma`, `src/generated/*`.

---

## 1. Architecture générale

### 1.1 Modèle de déploiement

Le service est conçu comme un **template multi-instance isolée** :
- Une instance PostgreSQL dédiée par projet hôte (isolation par déploiement, pas par schema)
- Une instance NATS partagée pour la pub/sub entre services
- Aucune notion de multi-tenancy dans le modèle de données
- JWT et secrets isolés par instance

### 1.2 Composants principaux

```
src/
├── app.module.ts             Assemblage root, APP_GUARD global
├── main.ts                   Bootstrap, CORS, validation globale, port configurable
├── auth/                     ✓ JWT (HS256), guard HTTP + WS, extraction tokens
├── conversations/            ✓ Création (avec normalisation de pair), liste avec unreadCount
├── messages/                 ✓ Envoi, lecture, pagination curseur
├── messaging/                ✓ Socket.IO gateway, room par conversation + userRoom
├── nats/                     ✓ Pub/sub integration, best-effort
├── prisma/                   ✓ Service + Module, gestion connexion
├── common/                   ✓ Types d'événements internes
└── generated/                Client Prisma auto-généré
```

### 1.3 Flux de données

**Écriture (REST ou WS) :**
```
Client (JWT HS256)
  ↓
AppAuthGuard (HTTP/WS)
  ↓
ConversationsService / MessagesService
  ↓
Prisma (PostgreSQL)
  ↓
EventEmitter (interne au process)
  ↓
MessagingGateway → WebSocket (room + userRoom)
  ↓ (parallèle, best-effort)
NatsPublisherService → NATS
  ↓
Autres microservices
```

**Lecture :**
```
Client (JWT)
  ↓
Guard
  ↓
Controller REST
  ↓
Service (Prisma)
  ↓
Client (JSON)
```

---

## 2. Analyse par module

### 2.1 Auth (`src/auth/`)

**Fichiers clés :**
- `app-auth.guard.ts` – Guard unique appliqué à TOUTES les routes (REST + WS)
- `auth.service.ts` – Vérification JWT (HS256, claim `sub` obligatoire)
- `extract-token.ts` – Extraction depuis header HTTP, header WS ou query param
- `current-user.decorator.ts` – Injection du `request.user` / `client.data.user`

**Points forts :**
- Centralisation du guard (APP_GUARD) évite les oublis
- Support multi-vecteur : header Authorization, WS query string, auth object Socket.IO
- Masquage de la cause exacte (signature, expiration) côté client
- JWT obligatoire (`sub` claim vérifiée)

**Problèmes :**
- ❌ Pas de rotation de clé, pas de TTL d'expiration contrôlable depuis `.env`
- ❌ Pas de blacklist de tokens (un client révoqué reste valide jusqu'à expiration)
- ❌ Pas de rate limiting sur les tentatives de connexion WS
- ❌ Le guard vérifie le token à CHAQUE message WS (bon pour la sécurité, mais coûteux en perf)

**Recommandations :**
- Ajouter `iat`, `exp` au payload JWT côté projet hôte et les valider ici
- Implémenter une cache de tokens révoqués si besoin de déconnexion immédiate
- Ajouter rate limiting (ex. 5 tentatives de connexion WS / 60s par IP)
- Vérifier le token une seule fois à la connexion WS, puis transmettre un refresh optionnel

---

### 2.2 Conversations (`src/conversations/`)

**Fichiers clés :**
- `conversations.service.ts` – Création (normalisation pair), liste avec unreadCount, validation participant
- `conversations.controller.ts` – Routes REST (GET, POST)

**Points forts :**
- ✓ Normalisation de pair (`userAId < userBId`) garantit une seule conversation par paire
- ✓ Gestion de la race condition (P2002 = création concurrente, retour de l'existant)
- ✓ Décompte des non-lus efficace (une seule requête `groupBy`, index partiel en base)
- ✓ Tri par `lastMessageAt` (null en dernier) pour ordre de récence
- ✓ Événement NATS publié uniquement en cas de création réelle

**Problèmes :**
- ❌ Pas de limite sur le nombre de conversations par utilisateur (fuite mémoire potentielle)
- ❌ La requête `groupBy` peut être lente si la base est très volumineuse (pas de pagination de la liste)
- ❌ Pas de validation que `participantId` est un UUID valide (accepte n'importe quelle chaîne)
- ❌ Pas de soft-delete ou d'archive (une conversation effacée l'est vraiment)

**Requête SQL générée :**
```sql
-- listForUser
SELECT * FROM "Conversation" 
WHERE "userAId" = $1 OR "userBId" = $1
ORDER BY "lastMessageAt" DESC NULLS LAST, "createdAt" DESC;

-- unreadCount (groupBy)
SELECT "conversationId", COUNT(*) as _count
FROM "Message"
WHERE "conversationId" IN ($1, $2, …) 
  AND "senderId" != $user 
  AND "readAt" IS NULL
GROUP BY "conversationId";
```

**Recommandations :**
- Paginer la liste (ex. limit 50 conversations)
- Valider les UUIDs au niveau DTO (avec `@IsUUID()` class-validator)
- Ajouter un `archivedAt` DateTime? optionnel pour soft-delete
- Implémenter un cleanup asynchrone pour les conversations inactives (ex. > 1 an)

---

### 2.3 Messages (`src/messages/`)

**Fichiers clés :**
- `messages.service.ts` – Envoi, lecture, pagination curseur, événements
- `messages.controller.ts` – Routes REST (GET, POST, PATCH)
- `dto/send-message.dto.ts` – Validation payload

**Points forts :**
- ✓ Pagination par curseur (id + createdAt stable) évite l'offset/limit
- ✓ Idempotence partielle : `markRead` ne réémet pas si déjà lu
- ✓ Validation métier : l'expéditeur ne peut marquer son propre message comme lu
- ✓ Événement interne best-effort : l'émission d'événement ne peut pas faire échouer l'écriture
- ✓ Événements NATS sans le `content` (sécurité, pas de fuite de données)
- ✓ `markConversationRead` bulk optimize (un seul UPDATE, pas un boucle)
- ✓ Tri stable avec deux colonnes (`createdAt`, `id`)

**Problèmes :**
- ❌ Pas de limite sur `limit` (un client peut demander 1 million de messages)
- ❌ Pas de validation `content` (vide, trop long, XSS ou injection)
- ❌ Pas de chiffrement du contenu en base (si une dump est exfiltrée, les messages sont en clair)
- ❌ `metadata` accepte n'importe quel JSON (risque de croissance de taille)
- ❌ Pas de détection de spam ou de rate limiting par utilisateur
- ❌ Pas de soft-delete des messages

**Requête SQL générée :**
```sql
-- paginate
SELECT * FROM "Message"
WHERE "conversationId" = $1
ORDER BY "createdAt" DESC, "id" DESC
LIMIT 31
OFFSET 0 (ou CURSOR);

-- index utilisé : @@index([conversationId, createdAt])
```

**Recommandations :**
- Ajouter `@Max(100)` sur `limit` dans le DTO de pagination
- Valider `content` : non vide, longueur max (ex. 5000 chars), pas d'URLs suspectes
- Implémenter rate limiting par utilisateur (ex. 5 messages / 10s)
- Ajouter `deletedAt` DateTime? pour archivage logique
- Chiffrer `content` au repos (AES-256 avec clé dérivée du MESSAGING_JWT_SECRET)

---

### 2.4 Messaging (WebSocket) (`src/messaging/`)

**Fichiers clés :**
- `messaging.gateway.ts` – Socket.IO, room par conversation, relais événements internes

**Points forts :**
- ✓ Room par conversation isolée (`conversation:{id}`)
- ✓ Room personnelle par utilisateur (`user:{id}`) pour notification hors fil
- ✓ Validation JWT lors de la connexion (rejette les sockets non authentifiées)
- ✓ Events entrants validés avec DTOs (`@UsePipes(ValidationPipe)`)
- ✓ Relais d'événements internes vers WebSocket (découplage via EventEmitter)
- ✓ Diffusion sépaée pour le fil (message complet) et la liste (signal léger)

**Problèmes :**
- ❌ CORS `origin: '*'` trop permissif (même commentaire dans le code)
- ❌ Pas de gestion de la déconnexion (nettoyage des rooms implicite)
- ❌ Pas de heartbeat ou de ping/pong explicite (Socket.IO par défaut, mais à vérifier)
- ❌ Pas de limite sur le nombre de connections par utilisateur
- ❌ Pas de messages "user is typing" ou "user is online"
- ❌ Pas de retry de reconnexion côté serveur (le client doit faire le reconnect)

**Événements Socket.IO :**

| Direction | Événement | Payload | Effet |
|-----------|-----------|---------|-------|
| Client → Serveur | `conversation:join` | `{ conversationId }` | Rejoint `room(conversationId)` |
| Client → Serveur | `conversation:leave` | `{ conversationId }` | Quitte la room |
| Client → Serveur | `message:send` | `{ conversationId, content, metadata? }` | Appelle `messages.send()` |
| Serveur → Room | `message:new` | `Message` | Après création |
| Serveur → Room | `message:read` | `{ conversationId, messageId, readAt, readBy }` | Après lecture |
| Serveur → Room | `conversation:read` | Event | Après `markConversationRead` |
| Serveur → UserRoom | `conversation:updated` | `{ conversationId }` | Signal de refresh |

**Recommandations :**
- Restreindre CORS à `http(s)://jobtrack-frontend.*` (ou liste blanche)
- Implémenter un `presence:online` / `presence:offline` avec TTL Redis
- Ajouter limite max connections par userId (ex. 5 connexions simultanées)
- Implémenter message:typing → message:typing-stopped auto après 3s inactivité
- Graceful shutdown : forcer fermeture après 30s si drain prend trop de temps

---

### 2.5 NATS (`src/nats/`)

**Fichiers clés :**
- `nats.module.ts` – Fourniture du token d'injection `NATS_CONNECTION`
- `nats-publisher.service.ts` – Pub best-effort, pas de retry
- `nats.events.ts` – Contrat d'intégration (sujets + types)
- `nats.constants.ts` – Constantes (token, subjects)

**Points forts :**
- ✓ Pub/sub découplé, pas de dépendances directes entre services
- ✓ Best-effort explicite : pas de bloqueur pour l'écriture métier
- ✓ JSONCodec intègre la sérialisation Date → ISO 8601
- ✓ Trois sujets clairs : `messaging.{conversation,message}.{created,read}`
- ✓ Payloads sans contenu (sécurité : pas d'interception)
- ✓ Drain propre à l'arrêt (onModuleDestroy)

**Problèmes :**
- ❌ La connexion NATS échoue en silence au démarrage (`warn` log seulement)
- ❌ Pas de retry de reconnexion automatique
- ❌ Pas d'outbox transactionnel (risque de perte d'événements en cas de crash)
- ❌ Pas de garantie at-least-once
- ❌ Pas de dead-letter queue (DLQ) pour les erreurs
- ❌ Pas de validation du payload avant publication
- ❌ Le TODO dans le code confirme que c'est un chantier connu

**Sujets publiés :**

```
messaging.conversation.created
  ↳ ConversationCreatedEvent { conversationId, userAId, userBId, createdAt }
  ↳ Déclenché : création réelle (pas sur récupération existante)

messaging.message.created
  ↳ MessageCreatedIntegrationEvent { messageId, conversationId, senderId, createdAt }
  ↳ Déclenché : après création en base
  ↳ Sans `content` (sécurité)

messaging.message.read
  ↳ MessageReadIntegrationEvent { messageId, conversationId, readAt }
  ↳ Déclenché : après update "message.readAt"
  ↳ Pas de publication pour `markConversationRead` (bulk)
```

**Recommandations :**
- Implémenter un pattern **outbox transactionnel** :
  - Créer une table `OutboxEvent` dans Prisma
  - Écrire le message + event dans une transaction atomique
  - Job d'arrière-plan qui traite les events non envoyés et retry
- Ajouter un JetStream subscriber en cas de besoin de persistance
- Implémenter un DLQ pour les payloads non sérialisables
- Ajouter monitoring : nombre d'events en attente, latence de publication
- Considérer Kafka si volumes élevés (durabilité + replay)

---

### 2.6 Prisma (`src/prisma/`)

**Fichiers clés :**
- `prisma.service.ts` – Client Prisma singleton
- `schema.prisma` – Modèles, migrations

**Schéma :**

```prisma
model Conversation {
  id String @id @default(uuid())
  userAId String        // Normalisé : userAId < userBId
  userBId String
  lastMessageAt DateTime? @db.Timestamptz  // Tri par récence
  createdAt DateTime @default(now())
  metadata Json?
  messages Message[]
  @@unique([userAId, userBId])
}

model Message {
  id String @id @default(uuid())
  conversationId String
  conversation Conversation @relation(...)
  senderId String
  content String
  readAt DateTime? @db.Timestamptz  // null = non lu
  createdAt DateTime @default(now())
  metadata Json?
  @@index([conversationId, createdAt])
  // Index partiel manuel : idx_messages_unread WHERE readAt IS NULL
}
```

**Points forts :**
- ✓ UUID primaires (distribuées, pas d'auto-increment)
- ✓ Timestamps ISO 8601 (Timestamptz pour invariance timezone)
- ✓ Index composite `(conversationId, createdAt)` pour la pagination curseur
- ✓ Index partiel manuel sur les non-lus (réduit la taille, booste les requêtes)
- ✓ Relation bilatérale Conversation ↔ Message
- ✓ Contrainte d'unicité sur la paire d'utilisateurs

**Problèmes :**
- ❌ Pas de contrainte CASCADE ou SET NULL (soft-delete serait mieux)
- ❌ Pas de versionning des messages (edit history)
- ❌ `metadata` peut croître sans limite (risque de bloat)
- ❌ Pas d'index sur `senderId` (slow queries de tous les messages d'un user)
- ❌ Pas de table `User` explicite (l'ID vient du JWT, confiance totale au projet hôte)
- ❌ Pas d'audit trail (qui a lu, quand ?)
- ❌ La première migration est générée à la main (détail, mais fragile)

**Performance :**
- SELECT conversations + groupBy unread : O(n + m) requêtes, OK jusqu'à ~1k conversations
- Pagination curseur : O(limit + 1), stable, OK
- markRead : UPDATE par ID, OK
- markConversationRead : UPDATE en bulk, OK

**Recommandations :**
- Ajouter index sur `(senderId, createdAt)` pour les requêtes "tous les messages d'un user"
- Ajouter colonne `updatedAt` pour detecter les modifications
- Implémenter soft-delete avec `deletedAt` nullable
- Ajouter colonne `editCount` ou table `MessageVersion` pour l'historique d'édition
- Limiter `metadata` avec trigger PostgreSQL (ex. max 10KB)
- Ajouter audit trail : table `ConversationAudit` ou colonnes `lastActionAt`, `lastActionBy`

---

## 3. Analyse de sécurité

### 3.1 Authentification & Autorisation

| Aspect | Implémentation | Sécurité | Recommandations |
|--------|---|---|---|
| **JWT** | HS256, claim `sub` (userId) | ✓ Centralisé, vérification stricte | Ajouter `iat`, `exp`, `aud` (audience) |
| **Secret** | `MESSAGING_JWT_SECRET` en `.env` | ✓ Isolation par instance | Utiliser un vault (HashiCorp Vault, AWS Secrets Manager) |
| **Scope** | Par utilisateur (claim `sub` seulement) | ✓ Simple, pas de rôles | Ajouter `roles: ['admin', 'user']` si besoin |
| **Token expiration** | Contrôlée par projet hôte | ⚠ Long-lived possible | Imposer max 24h TTL au niveau ici |
| **Refresh** | Pas de mécanisme | ⚠ Pas de rotation | Implémenter refresh token pattern |
| **WS handshake** | JWT validé avant join | ✓ Bon | Ajouter rate limiting sur rejets |
| **CORS** | `origin: '*'` | ✗ Faille ouverte | Restreindre à domaines connus |

### 3.2 Données sensibles

| Donnée | Stockage | Transmission | Risque | Mitigation |
|--------|----------|---|--------|-----------|
| **Message content** | Clair en PostgreSQL | TLS recommandé | Dump de DB = fuite | Chiffrer au repos (AES-256) |
| **JWT secret** | `.env` en clair | Pas transmis | Compromise de fichier | Vault externe |
| **Metadata** | Libre (JSON) | Non chiffré | Injection XSS ou données personnelles | Valider + limiter taille |
| **userId** | Libre (claim JWT) | En clair | Pas de risque immédiat (public) | Considérer tokens opaque |

### 3.3 Attaques

| Attaque | Vecteur | Défense | Statut |
|---------|---------|---------|--------|
| **Injection SQL** | Prisma ORM | ✓ Requêtes paramétrées | ✓ Sûr |
| **XSS** | Metadata / content non échappés | ⚠ Validé côté DTO (regex?) | ⚠ À tester |
| **CSRF** | JWT en header Authorization | ✓ Pas de cookies | ✓ Sûr |
| **Brute force JWT** | Énumération de tokens | ✗ Pas de rate limiting | ❌ **Risque** |
| **DDoS** | Flood de messages WS | ✗ Pas de limite/s | ❌ **Risque** |
| **Race condition** | Deux users créent même conversation | ✓ Unicité + P2002 handling | ✓ Sûr |
| **Unauthorized access** | Appel à autre conversation | ✓ Guard vérifie participation | ✓ Sûr |
| **Token theft** | Exfiltration du JWT | ⚠ Dépend du client HTTP/WS | ⚠ Best-effort TLS |
| **Replay** | Rejeu de message `message:send` | ✗ Pas de nonce/timestamp | ❌ **Risque** |

### 3.4 Recommandations de sécurité

**Critique :**
1. Chiffrer `Message.content` au repos (AES-256, clé dérivée de JWT_SECRET ou dédiée)
2. Implémenter rate limiting par userId / IP (ex. 10 req/s REST, 5 msg/10s WS)
3. Ajouter nonce ou timestamp dans les payloads WS pour éviter rejeu
4. Restreindre CORS à domaines listés (pas `*`)
5. Activer `HTTPS` obligatoire (TLS 1.3 min)

**Haute priorité :**
6. Implémenter token expiration court (1h max, refresh token 7j)
7. Ajouter audit logging (qui a accédé à quelle conversation, quand)
8. Valider strictement les UUIDs (format, pas injection)
9. Implémenter HSTS, CSP headers
10. Configurer CORS Socket.IO strictement

**Moyenne priorité :**
11. Chiffrer les métadatas sensibles
12. Ajouter 2FA / SSO si projet hôte le supporte
13. Implémenter signature des payloads NATS

---

## 4. Performance & Scalabilité

### 4.1 Requêtes SQL (benchmark estimé)

| Opération | Requête | Indexes | Complexité | Latence estimée |
|-----------|---------|---------|-----------|---|
| `listForUser` | SELECT (convos) + groupBy (unread) | ✓ Primary, @unique | O(n+m) | ~20ms (1k convos) |
| `findOrCreate` | SELECT + INSERT + CATCH P2002 | ✓ Unique | O(1) | ~5ms |
| `paginate` | SELECT LIMIT limit+1 | ✓ Index (conversationId, createdAt) | O(limit) | ~2ms (limit=30) |
| `send` | INSERT message + UPDATE lastMessageAt | ✓ Primary | O(1) | ~8ms |
| `markRead` | UPDATE WHERE id | ✓ Primary | O(1) | ~3ms |
| `markConversationRead` | UPDATE bulk | ✓ Partial idx (readAt IS NULL) | O(unread) | ~10ms (100 unread) |

### 4.2 Goulots d'étranglement

**À court terme (< 1000 users actifs) :**
- ✓ Performance satisfaisante
- ✓ PostgreSQL locale suffit

**À moyen terme (1k–10k users) :**
- ⚠ `listForUser` + `groupBy` peuvent être lentes (ajouter pagination)
- ⚠ Connexions WebSocket ouvertes : 10k connections possible, mais limiter les rooms grand public
- ⚠ Événements NATS : 10k messages/s possibles, OK

**À long terme (> 10k users) :**
- ❌ `listForUser` requiert optimisation (materialized view ou cache Redis)
- ❌ `groupBy` de tous les non-lus sera slow (10M+ rows)
- ❌ Messages archivés non supprimés = croissance infinie de la table Message
- ❌ WebSocket : beaucoup de rooms = charge mémoire serveur élevée
- ❌ NATS : besoin de JetStream pour persistance

### 4.3 Optimisations recommandées

**Immédiat :**
1. Ajouter index sur `(senderId, createdAt)` (requête des messages d'un user)
2. Implémenter pagination dans `listForUser` (limit 50 conversations)
3. Cacher `unreadCount` en Redis avec TTL 1m (rejouer sur `message:created`)
4. Implémenter circuit-breaker NATS (fail fast si injoignable)

**Court terme :**
5. Partitioning Prisma : `@db.Bit` ou `@db.SmallInt` pour shard par utilisateur
6. Materialized view PostgreSQL pour `user_conversations_view` (rafraîchissement 10m)
7. Impacter archivage : soft-delete messages > 1 an
8. Rate limiting : Redis avec `INCR` key sliding window

**Moyen terme :**
9. Migrer `Message.content` vers object storage (S3) + ref dans DB
10. Implémenter search full-text sur Elasticsearch (future)
11. Replicas PostgreSQL en lecture (followers pour `listForUser`)
12. Cache distribuée (Redis) pour `lastMessageAt` par conversation

**Long terme :**
13. Considérer Timescale DB ou Clickhouse pour archivage analytics
14. Partitionning par range (date) ou by hash (conversationId)
15. Pub/sub event sourcing (Kafka) si besoin replay/analytics

### 4.4 Profiling

**Outils recommandés :**
- `clinic.js` ou `0x` pour flame graphs Node.js
- `pgBench` pour load test PostgreSQL
- `autocannon` pour load test HTTP
- `clinic.js` ou `artichoke` pour WebSocket stress test

**Métriques clés à monitorer :**
- p95 latency `paginate` (target < 100ms)
- p99 latency `send` (target < 50ms)
- Connexions WebSocket actives (limit ~10k/instance)
- Événements NATS/s (target < 1k/s pour ce squelette)
- CPU, mémoire, handles ouverts

---

## 5. Gestion des erreurs

### 5.1 Erreurs métier

| Scénario | Code | Message | Gestion | Problème |
|----------|------|---------|---------|----------|
| JWT manquant/invalide | 401 | "Missing/Invalid token" | UnauthorizedException | ✓ OK |
| Conversation introuvable | 404 | "Conversation not found" | NotFoundException | ✓ OK |
| User non participant | 403 | "Not participant" | ForbiddenException | ✓ OK |
| Message introuvable | 404 | "Message not found" | NotFoundException | ✓ OK |
| Sender tries markRead own | 403 | "Sender cannot..." | ForbiddenException | ✓ OK |
| Conversation with self | 403 | "Cannot open with yourself" | ForbiddenException | ✓ OK |
| NATS unavailable | N/A | Warn log, pas de rethrow | Service continue | ⚠ Best-effort |
| Prisma migration fail | N/A | La migration échoue au démarrage | Manuel | ⚠ Pas d'auto-heal |

### 5.2 Erreurs de sécurité

**JWT :**
- ✓ Tous les cas géré : missing, invalid, expired, no `sub`

**Participation :**
- ✓ Chaque opération vérifie que l'user est participant

**WS connection :**
- ✓ Rejet à la connexion, logging du rejet
- ⚠ Pas de rate limiting sur les rejets

### 5.3 Recommandations

1. Ajouter `error` event handler global en WS (ne pas crasher sur emission failure)
2. Implémenter structured logging (JSON) avec log level (debug, info, warn, error)
3. Tracer les erreurs NATS : sauvegarder dans une queue locale pour retry async
4. Ajouter healthcheck endpoint : GET `/health` → `{ status: 'ok', database: 'ok', nats: 'ok' }`
5. Implémenter graceful shutdown avec timeout : fermer graduellemet les connexions WS

---

## 6. Tests & Qualité du code

### 6.1 Couverture actuelle

```
$ npm test
jest --config jest.config.js

PASS  src/auth/app-auth.guard.spec.ts
PASS  src/nats/nats-publisher.service.spec.ts (publication après création de message)

FAIL  src/conversations/conversations.service.spec.ts (aucun)
FAIL  src/messages/messages.service.spec.ts (aucun)
FAIL  src/messaging/messaging.gateway.spec.ts (aucun)
```

**Couverture estimée : ~5%** (seulement auth + nats testés)

### 6.2 Tests E2E

```
$ npm run test:e2e
jest --config test/jest-e2e.json

PASS  test/app.e2e.spec.ts
  - Guard protège /conversations
  - Requête authentifiée servie (Prisma + NATS mockés)
```

**Couverture : flow basic (liste, création, message), Prisma/NATS mockés**

### 6.3 Smoke test manuel

`npm run smoke-test`
- Exerce le flux complet contre infra réelle (PostgreSQL + NATS)
- Génère 2 JWT, crée conversation, envoie message, marque lu
- Vérifie les événements NATS (pas de content)
- **Non automatisé, manuel**

### 6.4 Qualité du code

**TypeScript :**
```json
{
  "strict": true,
  "strictNullChecks": true,
  "noImplicitAny": true,
  "forceConsistentCasingInFileNames": true
}
```
✓ Bon

**Linting :**
```
eslint --fix
prettier --write
```
✓ Présent, pas d'erreurs actuelles

**Convention de nommage :**
- ✓ camelCase pour variables
- ✓ PascalCase pour classes
- ✓ UPPER_CASE pour constantes
- ✓ kebab-case pour fichiers (sauf DTO)

**Docs :**
- ✓ Commentaires TypeScript utiles (services)
- ⚠ Manque de JSDoc sur les DTOs
- ⚠ README bien mais pas de migration docs

### 6.5 Recommandations de test

**Critique :**
1. Tester `ConversationsService.findOrCreate` : happy path + race condition P2002
2. Tester `MessagesService.send` : création + événements internes + NATS
3. Tester `MessagesService.markRead` : idempotence, authorization, événements
4. Tester `MessagingGateway.handleConnection` : JWT valide/invalid, room join/leave

**Haute priorité :**
5. Implémenter fixtures (users, conversations, messages)
6. Tester pagination curseur : limite, hasMore, nextCursor
7. Tester validation DTOs : content vide, metadata trop grand
8. Tester NATS publisher : failure graceful, retry pattern
9. Tester WebSocket events : validation, serialization

**Coverage target :**
- Statements > 70%
- Branches > 60%
- Lines > 70%
- Functions > 70%

**Outils :**
- Jest + Supertest pour HTTP
- jest-socket-mock pour WebSocket
- testcontainers pour PostgreSQL/NATS in tests

---

## 7. Configuration & Déploiement

### 7.1 Fichiers de configuration

| Fichier | Rôle | Sécurité | Recommandations |
|---------|------|----------|---|
| `.env` | Secrets + URLs | ⚠ En clair | Utiliser vault ou AWS Secrets Manager |
| `.env.example` | Référence | ✓ Exemple | Bien documenté |
| `nest-cli.json` | Build config | ✓ OK | Rien à changer |
| `tsconfig.json` | Compilateur TS | ✓ Strict | Considérer `const` pour string literals |
| `eslint.config.mjs` | Linting ESM | ✓ OK | Ajouter règle sur `any` type |
| `prisma.config.ts` | ??? | ⚠ N'existe pas | À vérifier |
| `prisma/schema.prisma` | Modèles DB | ✓ OK | Ajouter commentaires sur constraints |

### 7.2 Déploiement (recommandé)

**Docker :**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist .
EXPOSE 3100
CMD ["node", "dist/main.js"]
```

**Docker Compose :**
```yaml
services:
  ms-messagerie:
    image: ms-messagerie:latest
    ports:
      - "3100:3100"
    environment:
      - MESSAGING_DATABASE_URL=postgresql://…
      - MESSAGING_NATS_URL=nats://…
      - MESSAGING_JWT_SECRET=… # Vault
    depends_on:
      - postgres-messaging
      - nats-messaging

  postgres-messaging:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: messaging
      POSTGRES_USER: messaging
      POSTGRES_PASSWORD: …

  nats-messaging:
    image: nats:latest
    ports:
      - "4222:4222"
```

**CI/CD (GitHub Actions) :**
```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run test:e2e
```

---

## 8. Points clés d'amélioration

### 8.1 Matrice de priorisation

| ID | Problème | Sévérité | Effort | Score | Délai |
|----|----------|----------|--------|-------|-------|
| P1 | Rate limiting absent | 🔴 Haute | 🟡 Moyen | **16** | Sprint 1 |
| P2 | Couverture tests | 🔴 Haute | 🔴 Élevé | **12** | Sprint 1-2 |
| P3 | CORS trop ouvert | 🔴 Haute | 🟢 Faible | **20** | Immédiat |
| P4 | Chiffrement content | 🟡 Moyenne | 🔴 Élevé | **8** | Sprint 2 |
| P5 | Outbox transactionnel NATS | 🟡 Moyenne | 🔴 Élevé | **8** | Sprint 2-3 |
| P6 | Pagination conversations | 🟡 Moyenne | 🟡 Moyen | **12** | Sprint 2 |
| P7 | Soft-delete messages | 🟡 Moyenne | 🟡 Moyen | **10** | Sprint 2-3 |
| P8 | Audit logging | 🟢 Basse | 🟡 Moyen | **6** | Sprint 3 |
| P9 | Healthcheck endpoint | 🟢 Basse | 🟢 Faible | **10** | Sprint 3 |
| P10 | Versionning messages | 🟢 Basse | 🔴 Élevé | **4** | Backlog |

---

## 9. Recommandations détaillées

### 9.1 Court terme (2 semaines)

1. **CORS restriction** (P3 – 30 min)
   ```typescript
   // app.enableCors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/ });
   app.enableCors({ origin: 'https://jobtrack-frontend.example.com' });
   ```

2. **Rate limiting** (P1 – 4h)
   ```bash
   npm install @nestjs/throttler redis
   ```
   Implémenter ThrottlerGuard : 10 req/60s REST, 5 msg/10s WS

3. **Tests – Core Services** (P2 – 8h)
   - Ajouter `conversations.service.spec.ts` : findOrCreate, race condition
   - Ajouter `messages.service.spec.ts` : send, markRead, pagination
   - Target 40% coverage

4. **Validation DTOs** (P2 – 2h)
   - `@IsUUID()` pour conversationId, messageId
   - `@IsNotEmpty()` et `@MaxLength(5000)` pour content
   - Whitelist métadata size (max 10KB)

### 9.2 Moyen terme (Sprint 2-3)

5. **Outbox transactionnel** (P5 – 16h)
   - Table `OutboxEvent` en Prisma
   - Job d'arrière-plan : 5m frequency, retry 3x exponential backoff
   - Dead-letter queue pour les failures permanentes

6. **Pagination conversations** (P6 – 3h)
   - Ajouter `offset` et `limit` au DTO
   - Cache Redis pour `unreadCount`

7. **Chiffrement content** (P4 – 8h)
   - Hook Prisma pour `message.create` → cipher
   - Déchiffrement avant envoi WebSocket
   - Clé dérivée de `MESSAGING_JWT_SECRET` (ou clé dédiée)

8. **Tests E2E complets** (P2 – 12h)
   - Tester tous les endpoints + WebSocket events
   - Target 60% coverage

### 9.3 Long terme (Backlog / Phase 2)

9. **Soft-delete** (P7 – 4h)
   - Ajouter `deletedAt` nullable à Conversation et Message
   - Filtrer automatiquement dans findMany (default)

10. **Audit trail** (P8 – 6h)
    - Logger qui a accédé à quelle conversation, quand
    - Détectable via `createdAt`, `readAt` des messages

11. **Monitoring & observabilité**
    - Prom metrics : messages/min, WebSocket connections, latency p95/p99
    - Sentry integration pour error tracking
    - DataDog ou ELK pour logs centralisés

12. **Versionning messages** (P10 – 12h)
    - Table `MessageVersion` ou colonnes `editedAt`, `editCount`
    - Historique des éditions

---

## 10. Checklist de déploiement production

### Avant go-live

- [ ] **Sécurité**
  - [ ] CORS restreint à domaines production
  - [ ] `MESSAGING_JWT_SECRET` unique par instance (vault)
  - [ ] HTTPS activé, TLS 1.3+
  - [ ] Rate limiting implémenté (tests de charge >10 req/s)
  - [ ] Audit logging mis en place

- [ ] **Infrastructure**
  - [ ] PostgreSQL backups configuré (point-in-time recovery)
  - [ ] NATS persistance activée (JetStream)
  - [ ] Health checks en place (`GET /health`)
  - [ ] Monitoring des connections WebSocket (alerte > 5k)
  - [ ] Alertes DB : taille table Message, disk space

- [ ] **Qualité**
  - [ ] Tests > 50% coverage
  - [ ] Smoke test réussi contre prod-like env
  - [ ] Load test : 100 concurrent users, 5 msg/s chacun
  - [ ] Graceful shutdown test : kill process, vérifier drain NATS/WS

- [ ] **Documentation**
  - [ ] Runbook : incident response NATS down, DB down
  - [ ] Migration Prisma documentée (seed initial?)
  - [ ] Secrets management docs (comment créer nouveau secret)
  - [ ] API docs (Swagger?), WebSocket event spec

- [ ] **Monitoring & Alertes**
  - [ ] Logs centralisés (syslog, ELK)
  - [ ] Sentry ou Datadog configured
  - [ ] Alertes : erreur rate > 1%, latency p95 > 500ms
  - [ ] Runbook pour réactions aux alertes

---

## 11. Résumé des fichiers audités

| Fichier | Lignes | Rôle | Qualité | Commentaires |
|---------|--------|------|---------|---|
| src/app.module.ts | 40 | Root assembly | ✓ Bon | Clair, imports bien organisés |
| src/main.ts | 55 | Bootstrap | ✓ Bon | CORS + validation globale bien |
| src/auth/* | ~150 | Auth layer | ✓ Bon | Centralisé, support HTTP + WS |
| src/conversations/* | ~200 | Conversations | ⚠ Bon | Pas pagination listForUser |
| src/messages/* | ~250 | Messages | ⚠ Bon | Pas limit sur cursor, pas chiffrement |
| src/messaging/* | ~150 | WebSocket | ⚠ Bon | CORS permissif, pas typing indicator |
| src/nats/* | ~150 | Integration | ⚠ Bon | Pas outbox, best-effort explicit |
| src/prisma/* | ~50 | ORM | ✓ Bon | Schema bien, indexes bien |
| package.json | 85 | Dependencies | ✓ Bon | Versions à jour, scripts OK |
| .env.example | 14 | Config | ✓ Bon | Bien documenté |
| README.md | 138 | Documentation | ✓ Très bon | Complète, contrat clair |
| prisma/schema.prisma | 70 | Models | ✓ Bon | 2 modèles simples, indexes |

---

## 12. Conclusion

**MS-Messagerie** est un **fondation solide** pour une messagerie temps réel, avec une architecture modulaire et des patterns robustes (event sourcing interne, pub/sub découplé, cursor pagination).

**Prêt pour MVP :** Oui, avec restrictions
- ✓ Tous les endpoints clés implémentés
- ✓ WebSocket live + NATS events
- ✓ Authentification JWT centralisée
- ✗ Manque tests (coverage ~5%)
- ✗ Manque rate limiting
- ✗ CORS trop permissif
- ✗ Pas de garantie at-least-once NATS

**Next steps prioritaires :**
1. Restreindre CORS (immédiat)
2. Implémenter rate limiting (48h)
3. Augmenter couverture tests (Sprint 1)
4. Ajouter outbox transactionnel NATS (Sprint 2)

**Évaluation globale : 7/10** – Bon squelette, production-ready avec 3-4 sprints de consolidation.

---

## Annexe A – Commandes utiles

```bash
# Développement
npm install
npm run start:dev

# Tests
npm test
npm run test:watch
npm run test:e2e

# Build & Production
npm run build
npm run prisma:migrate
npm run start:prod

# Linting & Format
npm run lint
npm run format

# Smoke test (infra réelle)
npm run smoke-test

# Database
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:migrate
```

---

## Annexe B – Sujets NATS

```
messaging.conversation.created
  ↳ { conversationId, userAId, userBId, createdAt }
  ↳ Déclenché : création convo

messaging.message.created
  ↳ { messageId, conversationId, senderId, createdAt }
  ↳ Déclenché : envoi message (pas content!)

messaging.message.read
  ↳ { messageId, conversationId, readAt }
  ↳ Déclenché : marquage lu (pas bulk)
```

---

## Annexe C – Endpoints REST

| Méthode | Route | Auth | Description |
|---------|-------|------|---|
| `GET` | `/conversations` | JWT | List user conversations |
| `POST` | `/conversations` | JWT | Create or fetch conversation |
| `GET` | `/conversations/:id/messages` | JWT | List messages (cursor pagination) |
| `POST` | `/conversations/:id/messages` | JWT | Send message (fallback if WS down) |
| `PATCH` | `/messages/:id/read` | JWT | Mark single message read |

---

**Fin de l'audit**

Auteur : Claude Haiku 4.5  
Date : 2025-09-08
