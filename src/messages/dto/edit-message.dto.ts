import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Retire les espaces de bord d'une chaîne (no-op sur les autres types). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Corps de `PATCH /messages/:id`. Seul le contenu est éditable ; `metadata` et
 * les autres champs restent immuables. Bornes alignées sur `SendMessageDto`.
 */
export class EditMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @Matches(/\S/, { message: 'content must not be blank' })
  content!: string;
}
