import { BadRequestException } from '@nestjs/common';

/** Regex UUID (toutes versions), insensible à la casse. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Défense en profondeur au niveau service : les DTO (`@IsUUID`) et les pipes
 * (`ParseUUIDPipe`) valident déjà en amont, mais les services sont aussi
 * appelables depuis la gateway et, à terme, depuis d'autres modules.
 */
export function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }
}

/** Contenu de message : non vide après trim, borné à `max` caractères. */
export function assertMessageContent(content: string, max = 5000): void {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new BadRequestException('content must be a non-empty string');
  }
  if (content.length > max) {
    throw new BadRequestException(`content must be at most ${max} characters`);
  }
}
