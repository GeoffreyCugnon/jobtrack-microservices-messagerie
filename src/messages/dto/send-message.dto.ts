import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MaxJsonSize } from '../../common/max-json-size.validator';

/** Corps de `POST /conversations/:id/messages` (et de l'événement WebSocket `message:send`). */
export class SendMessageDto {
  /** Contenu textuel, non vide, borné à 5 000 caractères. */
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
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
