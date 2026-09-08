import { SetMetadata } from '@nestjs/common';

/** Clé de métadonnée lue par `AppAuthGuard` pour laisser passer une route sans JWT. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marque un handler (ou un contrôleur entier) comme accessible sans
 * authentification. Utilisé pour `GET /health`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
