/**
 * Limites de débit, partagées par le throttling REST (`ThrottlerModule` /
 * `RestThrottlerGuard`) et le throttling WebSocket (`MessagingGateway`).
 *
 * Toutes surchargeables par variable d'environnement. Les valeurs de l'audit
 * (CLAUDE.md §9.1 : REST 10/60s, WS connexion 3/60s) sont conservées comme
 * repères mais les défauts ci-dessous sont plus permissifs : 10 requêtes/60s
 * rendraient l'UI de messagerie inutilisable (ouvrir l'app = liste des
 * conversations + page de messages + accusé de lecture, soit déjà 3 requêtes),
 * et 3 tentatives de connexion WS/60s est franchi par un simple cycle de
 * reconnexion sur réseau instable. L'objectif reste d'arrêter un flood, pas de
 * gêner un usage normal — ajuster via l'env selon la charge réelle.
 */

/** Parse un entier strictement positif depuis l'env, sinon retourne `dflt`. */
function positiveInt(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** REST : fenêtre glissante par IP, appliquée à toutes les routes HTTP. */
export const REST_THROTTLE = {
  ttlMs: positiveInt(process.env.MESSAGING_REST_THROTTLE_TTL_MS, 60_000),
  limit: positiveInt(process.env.MESSAGING_REST_THROTTLE_LIMIT, 100),
} as const;

/** WebSocket `message:send` : fenêtre glissante par utilisateur (claim `sub`). */
export const WS_SEND_THROTTLE = {
  windowMs: positiveInt(process.env.MESSAGING_WS_SEND_TTL_MS, 10_000),
  limit: positiveInt(process.env.MESSAGING_WS_SEND_LIMIT, 5),
} as const;

/** Connexion WebSocket (handshake) : fenêtre glissante par IP. */
export const WS_CONNECT_THROTTLE = {
  windowMs: positiveInt(process.env.MESSAGING_WS_CONNECT_TTL_MS, 60_000),
  limit: positiveInt(process.env.MESSAGING_WS_CONNECT_LIMIT, 10),
} as const;

/**
 * Indicateur `typing:start` / `typing:stop` : fenêtre glissante par utilisateur.
 * Volontairement large (le client doit déjà débouncer) — c'est un simple
 * garde-fou anti-spam, un événement perdu est sans conséquence.
 */
export const WS_TYPING_THROTTLE = {
  windowMs: positiveInt(process.env.MESSAGING_WS_TYPING_TTL_MS, 10_000),
  limit: positiveInt(process.env.MESSAGING_WS_TYPING_LIMIT, 20),
} as const;
