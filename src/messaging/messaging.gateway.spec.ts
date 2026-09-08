import { WsException } from '@nestjs/websockets';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { TEST_CONVERSATION_ID, TEST_USERS, makeMessage } from '../common/test-fixtures';
import { MessagesService } from '../messages/messages.service';
import { MessagingGateway } from './messaging.gateway';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Tests unitaires de la gateway : AuthService, MessagesService et
 * WsRateLimiterService mockés, socket Socket.IO simulé (join/leave/disconnect).
 */
describe('MessagingGateway', () => {
  let authService: { verifyToken: jest.Mock };
  let messages: { send: jest.Mock };
  let rateLimiter: { allowConnection: jest.Mock; allowMessage: jest.Mock };
  let gateway: MessagingGateway;

  function fakeSocket() {
    return {
      id: 'sock-1',
      data: {} as Record<string, unknown>,
      handshake: { address: '1.2.3.4', auth: {}, headers: {}, query: {} },
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  beforeEach(() => {
    authService = { verifyToken: jest.fn() };
    messages = { send: jest.fn() };
    rateLimiter = {
      allowConnection: jest.fn().mockReturnValue(true),
      allowMessage: jest.fn().mockReturnValue(true),
    };
    gateway = new MessagingGateway(
      authService as unknown as AuthService,
      messages as unknown as MessagesService,
      rateLimiter as unknown as WsRateLimiterService,
    );
  });

  describe('handleConnection', () => {
    it('accepts a valid JWT, attaches the user and joins their personal room', () => {
      authService.verifyToken.mockReturnValue({ id: TEST_USERS.alice });
      const client = fakeSocket();

      gateway.handleConnection(client as never);

      expect(client.data.user).toEqual({ id: TEST_USERS.alice });
      expect(client.join).toHaveBeenCalledWith(`user:${TEST_USERS.alice}`);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('rejects (disconnects) a socket with an invalid JWT', () => {
      authService.verifyToken.mockImplementation(() => {
        throw new UnauthorizedException('bad token');
      });
      const client = fakeSocket();

      gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.user).toBeUndefined();
    });

    it('rejects the handshake when the connection rate limit is exceeded, before verifying the JWT', () => {
      rateLimiter.allowConnection.mockReturnValue(false);
      const client = fakeSocket();

      gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(authService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('conversation:join / conversation:leave', () => {
    it('join adds the socket to the conversation room', () => {
      const client = fakeSocket();
      const res = gateway.join(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(client.join).toHaveBeenCalledWith(`conversation:${TEST_CONVERSATION_ID}`);
      expect(res).toEqual({ event: 'conversation:joined', data: TEST_CONVERSATION_ID });
    });

    it('leave removes the socket from the conversation room', () => {
      const client = fakeSocket();
      const res = gateway.leave(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(client.leave).toHaveBeenCalledWith(`conversation:${TEST_CONVERSATION_ID}`);
      expect(res).toEqual({ event: 'conversation:left', data: TEST_CONVERSATION_ID });
    });
  });

  describe('message:send', () => {
    it('delegates to MessagesService.send for an authenticated socket within its quota', () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };
      const created = makeMessage();
      messages.send.mockResolvedValue(created);

      const body = { conversationId: TEST_CONVERSATION_ID, content: 'hi', metadata: undefined };
      void gateway.sendMessage(client as never, body);

      expect(rateLimiter.allowMessage).toHaveBeenCalledWith(TEST_USERS.alice, 'sock-1');
      expect(messages.send).toHaveBeenCalledWith(TEST_CONVERSATION_ID, TEST_USERS.alice, {
        content: 'hi',
        metadata: undefined,
      });
    });

    it('throws WsException and does not send when the per-user rate limit is exceeded', () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };
      rateLimiter.allowMessage.mockReturnValue(false);

      expect(() =>
        gateway.sendMessage(client as never, {
          conversationId: TEST_CONVERSATION_ID,
          content: 'spam',
        }),
      ).toThrow(WsException);
      expect(messages.send).not.toHaveBeenCalled();
    });

    it('throws WsException when the socket has no attached user', () => {
      const client = fakeSocket();
      expect(() =>
        gateway.sendMessage(client as never, {
          conversationId: TEST_CONVERSATION_ID,
          content: 'x',
        }),
      ).toThrow(WsException);
    });
  });
});
