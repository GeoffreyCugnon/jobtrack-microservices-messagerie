/**
 * Configuration du « trust proxy ».
 *
 * En production, cette instance tourne derrière un reverse proxy (nginx / traefik
 * / ingress Kubernetes) : `req.socket.remoteAddress` et
 * `client.handshake.address` valent alors l'IP **du proxy**, pas celle du client.
 * Sans correction, tout le trafic tombe dans un seul bucket de rate limiting.
 *
 * - HTTP : `app.set('trust proxy', <value>)` (cf. main.ts) fait qu'Express dérive
 *   `req.ip` du header `X-Forwarded-For`.
 * - WebSocket : Socket.IO ne lit pas `trust proxy` ; on résout l'IP à la main
 *   via `clientIpFromHandshake()`.
 *
 * Piloté par `MESSAGING_TRUST_PROXY`. Défaut : `1` (un seul hop de proxy, cas le
 * plus courant). Mettre `false` / `0` pour une exposition directe sans proxy.
 * Accepte aussi `loopback`, `uniquelocal`, une IP ou un CIDR (transmis tel quel
 * à Express).
 */

const RAW = process.env.MESSAGING_TRUST_PROXY?.trim();

/** Valeur à passer à `app.set('trust proxy', …)`. Défaut `1`. */
export function trustProxySetting(): boolean | number | string {
  if (RAW === undefined || RAW === '') {
    return 1;
  }
  if (RAW.toLowerCase() === 'true') {
    return true;
  }
  if (RAW.toLowerCase() === 'false') {
    return false;
  }
  const asInt = Number(RAW);
  if (Number.isInteger(asInt) && asInt >= 0) {
    return asInt;
  }
  // 'loopback', 'uniquelocal', une IP, un CIDR, une liste séparée par des virgules…
  return RAW;
}

/** `true` si l'on doit faire confiance au header `X-Forwarded-For` (côté WebSocket). */
export function trustsProxy(): boolean {
  const setting = trustProxySetting();
  if (typeof setting === 'boolean') {
    return setting;
  }
  if (typeof setting === 'number') {
    return setting > 0;
  }
  return setting.toLowerCase() !== 'false';
}

/**
 * IP réelle du client à l'origine d'un handshake Socket.IO.
 *
 * Si l'on fait confiance au proxy, on prend la **première** entrée de
 * `X-Forwarded-For` (le client d'origine ; les suivantes sont les proxys
 * traversés). Sinon on retombe sur l'adresse de la socket. `'unknown'` en
 * dernier recours pour ne jamais renvoyer une chaîne vide comme clé de bucket.
 */
export function clientIpFromHandshake(handshake: {
  address?: string;
  headers?: Record<string, unknown>;
}): string {
  if (trustsProxy()) {
    const xff: unknown = handshake.headers?.['x-forwarded-for'];
    const raw: unknown = Array.isArray(xff) ? (xff as unknown[])[0] : xff;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const first = raw.split(',')[0]?.trim();
      if (first) {
        return first;
      }
    }
  }
  return handshake.address && handshake.address.trim() !== '' ? handshake.address : 'unknown';
}
