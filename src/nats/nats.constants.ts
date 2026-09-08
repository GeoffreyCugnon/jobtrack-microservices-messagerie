/**
 * Jeton d'injection de la connexion NATS partagée.
 *
 * La valeur injectée est `NatsConnection | null` : `null` quand le broker était
 * injoignable au démarrage (cf. natsConnectionProvider). Les consommateurs
 * doivent gérer ce cas (NatsPublisherService le fait).
 */
export const NATS_CONNECTION = Symbol('NATS_CONNECTION');

/** URL par défaut si MESSAGING_NATS_URL n'est pas défini. */
export const DEFAULT_NATS_URL = 'nats://localhost:4222';
