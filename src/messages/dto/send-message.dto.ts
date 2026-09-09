import { IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MaxJsonSize } from '../../common/max-json-size.validator';

/** Corps de `POST /conversations/:id/messages` (et de l'événement WebSocket `message:send`). */
export class SendMessageDto {
  /**
   * Contenu textuel, non vide *après trim*, borné à 5 000 caractères. Le
   * `@Matches(/\S/)` aligne le DTO sur `assertMessageContent` (défense en
   * profondeur côté service), qui rejette déjà le contenu blanc.
   */
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
