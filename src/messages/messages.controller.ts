import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import { EditMessageDto } from './dto/edit-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

/**
 * Routes REST des messages.
 *
 * @Controller() sans préfixe : les chemins mêlent `/conversations/:id/messages`
 * et `/messages/:id/...`. ParseUUIDPipe rejette (400) tout id mal formé avant
 * d'atteindre la base.
 */
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** GET /conversations/:id/messages — page de messages (curseur). */
  @Get('conversations/:id/messages')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messages.paginate(conversationId, user.id, query.cursor, query.limit);
  }

  /**
   * POST /conversations/:id/messages — envoi d'un message.
   * Chemin de repli quand le transport WebSocket est indisponible côté client.
   */
  @Post('conversations/:id/messages')
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(conversationId, user.id, dto);
  }

  /** PATCH /messages/:id/read — marque le message comme lu (par le destinataire). */
  @Patch('messages/:id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messages.markRead(id, user.id);
  }

  /**
   * PATCH /conversations/:id/messages/read — marque d'un coup tous les messages
   * reçus non lus de la conversation comme lus (à l'ouverture du fil).
   */
  @Patch('conversations/:id/messages/read')
  markConversationRead(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.messages.markConversationRead(conversationId, user.id);
  }

  /** PATCH /messages/:id — édite le contenu (expéditeur uniquement). */
  @Patch('messages/:id')
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.messages.edit(id, user.id, dto);
  }

  /** GET /messages/:id/versions — historique d'édition (participants). */
  @Get('messages/:id/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messages.getVersions(id, user.id);
  }

  /** DELETE /messages/:id — soft-delete (expéditeur uniquement). */
  @Delete('messages/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messages.softDelete(id, user.id);
  }

  /** POST /messages/:id/restore — restaure un message soft-deleté (expéditeur). */
  @Post('messages/:id/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messages.restore(id, user.id);
  }
}
