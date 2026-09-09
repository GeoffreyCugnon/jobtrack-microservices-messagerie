import { SetMetadata } from '@nestjs/common';

/** Clé de métadonnée lue par `RestRateLimitGuard`. */
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';

/**
 * Exclut un handler (ou un contrôleur entier) du rate limiting REST. Réservé aux
 * sondes appelées en boucle par l'orchestrateur (`GET /health`).
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
