import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Query string de `GET /conversations/:id/messages`. */
export class ListMessagesQueryDto {
  /** Curseur = id du dernier message de la page précédente (`nextCursor`). Absent = première page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /** Taille de page (1–100). @Type convertit la valeur reçue en string vers un number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
