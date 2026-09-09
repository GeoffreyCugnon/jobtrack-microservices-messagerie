import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Corps de `PATCH /messages/:id`. Seul le contenu est éditable ; `metadata` et
 * les autres champs restent immuables. Bornes alignées sur `SendMessageDto`.
 */
export class EditMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @Matches(/\S/, { message: 'content must not be blank' })
  content!: string;
}
