/**
 * Utilisateur authentifié, dérivé uniquement du claim `sub` du JWT.
 *
 * Aucune dimension tenant/projet : une instance ne sert qu'un seul projet hôte.
 * L'identifiant est une chaîne opaque fournie par le projet hôte.
 */
export interface AuthUser {
  id: string;
  /**
   * Rôles portés par le claim `roles` du JWT, si l'hôte en fournit. `undefined`
   * ou `[]` quand le claim est absent — c'est le cas aujourd'hui (l'hôte JobTrack
   * n'émet pas ce claim). Lu uniquement par `RolesGuard` sur les handlers
   * décorés `@Roles(...)`.
   */
  roles?: string[];
}

/**
 * Forme minimale de la requête HTTP que le guard lit (headers) et enrichit
 * (`user`). Volontairement structurelle pour ne pas dépendre du type Express.
 */
export interface AuthedRequest {
  headers?: Record<string, unknown>;
  user?: AuthUser;
}

/**
 * Forme minimale du client Socket.IO que le guard / la gateway lisent
 * (`handshake`) et enrichissent (`data.user`).
 */
export interface AuthedSocket {
  id?: string;
  data: Record<string, unknown> & { user?: AuthUser };
  handshake?: {
    auth?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
  };
  disconnect?: (close?: boolean) => void;
}
