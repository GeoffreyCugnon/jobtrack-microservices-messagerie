/**
 * Origines autorisées, partagées par le CORS HTTP (`main.ts`) et le CORS de la
 * gateway Socket.IO (`MessagingGateway`).
 *
 * Source : variable d'environnement `MESSAGING_CORS_ORIGINS` (liste d'URLs
 * séparées par des virgules, ex. `https://jobtrack.example.com,http://localhost:5173`).
 * À défaut, on retombe sur les origines de développement du Frontend JobTrack
 * (Vite : 5173, puis 5174 en fallback). Plus de `origin: '*'` ni de regex
 * « tout localhost » : la liste est désormais explicite.
 */

/** Origines de dev par défaut quand `MESSAGING_CORS_ORIGINS` n'est pas défini. */
const DEV_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

/** Liste blanche effective, lue à chaque appel pour rester testable via l'env. */
export function allowedOrigins(): string[] {
  const fromEnv = process.env.MESSAGING_CORS_ORIGINS;
  if (fromEnv && fromEnv.trim() !== '') {
    return fromEnv
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  return [...DEV_ORIGINS];
}

/**
 * Callback `origin` compatible à la fois avec `app.enableCors()` (Express) et
 * avec l'option `cors.origin` de Socket.IO.
 *
 * Une requête sans header `Origin` (appel serveur-à-serveur, `curl`, health
 * check) est autorisée : CORS ne protège que les appels initiés par un
 * navigateur.
 */
export function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin || allowedOrigins().includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
  }
}
