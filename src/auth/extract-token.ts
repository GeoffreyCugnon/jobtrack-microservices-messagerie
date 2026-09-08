/**
 * Helpers d'extraction du JWT brut depuis une requête HTTP ou une poignée de
 * main (handshake) Socket.IO. Aucune vérification ici — juste la localisation
 * du token, que AuthService se charge ensuite de valider.
 */

/** Extrait `<token>` d'un header `Authorization: Bearer <token>` (insensible à la casse). */
export function extractBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

/** HTTP : uniquement le header `Authorization`. */
export function extractHttpToken(req: { headers?: Record<string, unknown> }): string | undefined {
  return extractBearer(req.headers?.authorization as string | undefined);
}

/**
 * WebSocket : par ordre de priorité
 *   1. `handshake.auth.token`  (recommandé : `io(url, { auth: { token } })`)
 *   2. header `Authorization: Bearer <token>`
 *   3. query string `?token=<token>`
 */
export function extractWsToken(client: {
  handshake?: {
    auth?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
  };
}): string | undefined {
  const handshake = client.handshake ?? {};
  const fromAuth = handshake.auth?.token;
  const fromQuery = handshake.query?.token;
  return (
    (typeof fromAuth === 'string' ? fromAuth : undefined) ??
    extractBearer(handshake.headers?.authorization as string | undefined) ??
    (typeof fromQuery === 'string' ? fromQuery : undefined)
  );
}
