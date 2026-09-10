import { Injectable } from '@nestjs/common';

/**
 * Suivi en mémoire des utilisateurs connectés en WebSocket (présence
 * « en ligne / hors ligne »).
 *
 * Un utilisateur peut ouvrir plusieurs sockets (onglets, appareils) : on
 * compte les sockets par utilisateur et l'état ne bascule qu'aux transitions
 * 0 -> 1 (passe en ligne) et 1 -> 0 (passe hors ligne).
 *
 * ⚠️ Mémoire du process : en déploiement multi-instance, chaque instance ne
 * voit que ses propres sockets (même limite que le rate limiter en mode
 * mémoire). Suffisant pour une instance unique / une démo ; un backend Redis
 * (compteur + pub/sub partagés) serait nécessaire pour scaler horizontalement.
 */
@Injectable()
export class PresenceService {
  private readonly socketCounts = new Map<string, number>();

  /**
   * Enregistre une socket pour `userId`.
   * @returns `true` si l'utilisateur vient de passer en ligne (première socket).
   */
  connect(userId: string): boolean {
    const next = (this.socketCounts.get(userId) ?? 0) + 1;
    this.socketCounts.set(userId, next);
    return next === 1;
  }

  /**
   * Retire une socket pour `userId`.
   * @returns `true` si l'utilisateur vient de passer hors ligne (dernière socket).
   */
  disconnect(userId: string): boolean {
    const current = this.socketCounts.get(userId) ?? 0;
    if (current <= 1) {
      this.socketCounts.delete(userId);
      return current === 1;
    }
    this.socketCounts.set(userId, current - 1);
    return false;
  }

  isOnline(userId: string): boolean {
    return this.socketCounts.has(userId);
  }

  /** Sous-ensemble de `userIds` actuellement en ligne. */
  filterOnline(userIds: Iterable<string>): string[] {
    const online: string[] = [];
    for (const id of userIds) {
      if (this.socketCounts.has(id)) {
        online.push(id);
      }
    }
    return online;
  }
}
