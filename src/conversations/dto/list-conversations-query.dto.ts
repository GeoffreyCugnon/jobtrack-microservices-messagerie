import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Query string de `GET /conversations` (pagination par curseur). */
export class ListConversationsQueryDto {
  /** Curseur = id de la dernière conversation de la page précédente (`nextCursor`). */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /** Taille de page (1–100, défaut 30). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
