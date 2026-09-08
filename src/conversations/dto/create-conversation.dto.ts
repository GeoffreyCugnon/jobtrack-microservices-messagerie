import { IsUUID } from 'class-validator';

/** Corps de `POST /conversations`. */
export class CreateConversationDto {
  /**
   * Identifiant de l'autre participant (claim `sub` d'un utilisateur du projet
   * hôte). Validé comme UUID : cohérent avec le reste du service, où tous les
   * identifiants (conversation, message) sont des UUID — cf. `ParseUUIDPipe` sur
   * les routes et `@IsUUID()` sur les DTO WebSocket. Le projet hôte JobTrack
   * émet des `sub` au format UUID ; adapter cette contrainte si un hôte futur
   * utilise un autre format d'identifiant.
   */
  @IsUUID()
  participantId!: string;
}
