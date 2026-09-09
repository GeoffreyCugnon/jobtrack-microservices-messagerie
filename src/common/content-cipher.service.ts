import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Préfixe de version : permet de faire coexister lignes chiffrées et en clair. */
const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Chiffrement au repos de `Message.content` (et `MessageVersion.content`).
 *
 * Clé : `MESSAGING_CONTENT_ENCRYPTION_KEY`, 32 octets encodés en base64 (ou hex).
 * Générer :  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
 *
 * Sans clé configurée, `encrypt`/`decrypt` sont des passe-plats : le contenu est
 * stocké en clair (rétro-compatible avec les lignes existantes). `decrypt`
 * reconnaît une valeur chiffrée à son préfixe `v1:` — les lignes en clair
 * antérieures à l'activation de la clé restent lisibles ; une ligne `v1:` sans
 * clé disponible lève une erreur explicite plutôt que de renvoyer du charabia.
 *
 * Format chiffré : `v1:<iv b64>:<authTag b64>:<ciphertext b64>` (AES-256-GCM).
 * Les payloads NATS n'incluent jamais le contenu : rien à faire de ce côté.
 */
@Injectable()
export class ContentCipherService {
  private readonly logger = new Logger(ContentCipherService.name);
  private readonly key: Buffer | null;

  constructor(config: ConfigService) {
    const raw = config.get<string>('MESSAGING_CONTENT_ENCRYPTION_KEY')?.trim();
    if (!raw) {
      this.key = null;
      this.logger.warn(
        'MESSAGING_CONTENT_ENCRYPTION_KEY not set — message content is stored in clear text',
      );
      return;
    }
    const buf = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `MESSAGING_CONTENT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
      );
    }
    this.key = buf;
    this.logger.log('Message content encryption at rest: enabled (AES-256-GCM)');
  }

  /** `true` si une clé est configurée (chiffrement actif). */
  get enabled(): boolean {
    return this.key !== null;
  }

  /** Chiffre `plain`. Sans clé : renvoie `plain` tel quel. */
  encrypt(plain: string): string {
    if (!this.key) {
      return plain;
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  /**
   * Déchiffre `stored`. Une valeur sans préfixe `v1:` est considérée en clair
   * (ligne antérieure à l'activation de la clé) et renvoyée telle quelle.
   */
  decrypt(stored: string): string {
    if (!stored.startsWith(`${PREFIX}:`)) {
      return stored;
    }
    if (!this.key) {
      throw new Error('Encrypted content found but MESSAGING_CONTENT_ENCRYPTION_KEY is not set');
    }
    const [, ivB64, tagB64, ctB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed encrypted content');
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
