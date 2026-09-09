import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';

/**
 * Routes REST des conversations. Toutes protégées par AppAuthGuard (APP_GUARD) :
 * `user` provient toujours du JWT, jamais du corps de la requête.
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /**
   * GET /conversations — page de conversations de l'appelant, triées par
   * `lastMessageAt`. Réponse : `{ items, nextCursor }` (curseur = `?cursor=<id>`,
   * taille `?limit=` 1–100, défaut 30).
   */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListConversationsQueryDto) {
    return this.conversations.listForUser(user.id, query.cursor, query.limit);
  }

  /**
   * POST /conversations — ouvre (ou retrouve) la conversation one-to-one avec
   * l'utilisateur `participantId`. Idempotent : deux appels renvoient la même
   * conversation. Réactive une conversation précédemment supprimée.
   */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.conversations.findOrCreate(user.id, dto.participantId);
  }

  /** DELETE /conversations/:id — soft-delete (masque la conversation). Idempotent. */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.softDelete(id, user.id);
  }

  /** POST /conversations/:id/restore — restaure une conversation soft-deletée. */
  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.restore(id, user.id);
  }
}
