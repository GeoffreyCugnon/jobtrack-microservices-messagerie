import { Transform } from 'class-transformer';
import { IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MaxJsonSize } from '../../common/max-json-size.validator';

/** Retire les espaces de bord d'une chaîne (no-op sur les autres types). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Corps de `POST /conversations/:id/messages` (et de l'événement WebSocket `message:send`). */
export class SendMessageDto {
  /**
   * Contenu textuel, **trimé**, non vide, borné à 5 000 caractères. Le trim
   * s'applique avant validation : `"   "` → `""` → rejeté. `@Matches(/\S/)`
   * reste comme filet (aligné sur `assertMessageContent` côté service).
   */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @Matches(/\S/, { message: 'content must not be blank' })
  content!: string;

  /**
   * Métadonnées libres du projet hôte, stockées telles quelles. Bornées à
   * 10 000 octets une fois sérialisées, pour éviter le bloat de `Message.metadata`.
   */
  @IsOptional()
  @IsObject()
  @MaxJsonSize(10_000)
  metadata?: Record<string, unknown>;
}
