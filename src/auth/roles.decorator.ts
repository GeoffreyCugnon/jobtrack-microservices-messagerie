import { SetMetadata } from '@nestjs/common';

/** Clé de métadonnée lue par `RolesGuard`. */
export const ROLES_KEY = 'roles';

/**
 * Exige que l'appelant porte **au moins un** des rôles indiqués (claim `roles`
 * du JWT). Sans ce décorateur, `RolesGuard` laisse tout passer.
 *
 * Prévu pour les permissions « recruteur » côté hôte (ex. `@Roles('recruiter')`
 * sur une future route d'administration de conversations). Inopérant tant que
 * l'hôte JobTrack n'ajoute pas le claim `roles` au JWT de messagerie.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
