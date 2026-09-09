import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MaxJsonSize } from '../../common/max-json-size.validator';

/**
 * DTO des messages entrants Socket.IO. Validés par le ValidationPipe posé sur la
 * gateway (@UsePipes), au même titre que les DTO des routes REST. Les bornes
 * (`content`, `metadata`) sont alignées sur `SendMessageDto` (chemin REST).
 */

/** Payload de `conversation:join` / `conversation:leave`. */
export class WsConversationDto {
  @IsUUID()
  conversationId!: string;
}

/** Payload de `message:send`. */
export class WsSendMessageDto {
  @IsUUID()
  conversationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @Matches(/\S/, { message: 'content must not be blank' })
  content!: string;

  @IsOptional()
  @IsObject()
  @MaxJsonSize(10_000)
  metadata?: Record<string, unknown>;
}
