/**
 * Limiteur de débit à fenêtre glissante, en mémoire process.
 *
 * Utilisé par `MessagingGateway` pour les deux vecteurs WebSocket que
 * `ThrottlerGuard` (HTTP only) ne couvre pas : les tentatives de connexion
 * (par IP) et l'événement `message:send` (par utilisateur).
 *
 * Volontairement sans dépendance externe : une instance isolée par projet hôte
 * (cf. CLAUDE.md) n'a pas de Redis partagé. Pour un déploiement multi-instances
 * derrière un load-balancer, remplacer par un store distribué.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Enregistre une tentative pour `key`. Retourne `true` si elle est dans le
   * quota, `false` si le quota est déjà atteint sur la fenêtre courante (dans ce
   * cas la tentative n'est pas comptée, pour ne pas prolonger indéfiniment le
   * blocage).
   */
  hit(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Purge les clés dont toutes les tentatives sont sorties de la fenêtre. */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, kept);
      }
    }
  }
}
