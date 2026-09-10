import { WsException } from '@nestjs/websockets';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { TEST_CONVERSATION_ID, TEST_USERS, makeMessage } from '../common/test-fixtures';
import { MetricsService } from '../metrics/metrics.service';
import { MessagesService } from '../messages/messages.service';
import { MessagingGateway } from './messaging.gateway';
import { WsRateLimiterService } from './rate-limiter.service';

/**
 * Tests unitaires de la gateway : AuthService, MessagesService,
 * WsRateLimiterService et MetricsService mockés, socket Socket.IO simulé.
 */
describe('MessagingGateway', () => {
  let authService: { verifyToken: jest.Mock };
  let messages: { send: jest.Mock; assertParticipant: jest.Mock };
  let rateLimiter: {
    allowConnection: jest.Mock;
    allowMessage: jest.Mock;
    allowTyping: jest.Mock;
  };
  let metrics: {
    incWsConnection: jest.Mock;
    decWsConnection: jest.Mock;
    incWsMessage: jest.Mock;
  };
  let gateway: MessagingGateway;

  function fakeSocket() {
    const emit = jest.fn();
    return {
      id: 'sock-1',
      data: {} as Record<string, unknown>,
      handshake: { address: '1.2.3.4', auth: {}, headers: {}, query: {} },
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      to: jest.fn().mockReturnValue({ emit }),
      _emit: emit,
    };
  }

  beforeEach(() => {
    authService = { verifyToken: jest.fn() };
    messages = { send: jest.fn(), assertParticipant: jest.fn().mockResolvedValue(undefined) };
    rateLimiter = {
      allowConnection: jest.fn().mockResolvedValue(true),
      allowMessage: jest.fn().mockResolvedValue(true),
      allowTyping: jest.fn().mockResolvedValue(true),
    };
    metrics = {
      incWsConnection: jest.fn(),
      decWsConnection: jest.fn(),
      incWsMessage: jest.fn(),
    };
    gateway = new MessagingGateway(
      authService as unknown as AuthService,
      messages as unknown as MessagesService,
      rateLimiter as unknown as WsRateLimiterService,
      metrics as unknown as MetricsService,
    );
  });

  describe('handleConnection', () => {
    it('accepts a valid JWT, attaches the user, joins their room and counts the connection', async () => {
      authService.verifyToken.mockReturnValue({ id: TEST_USERS.alice });
      const client = fakeSocket();

      await gateway.handleConnection(client as never);

      expect(client.data.user).toEqual({ id: TEST_USERS.alice });
      expect(client.join).toHaveBeenCalledWith(`user:${TEST_USERS.alice}`);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(metrics.incWsConnection).toHaveBeenCalledTimes(1);
    });

    it('rejects (disconnects) a socket with an invalid JWT and does not count it', async () => {
      authService.verifyToken.mockImplementation(() => {
        throw new UnauthorizedException('bad token');
      });
      const client = fakeSocket();

      await gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.user).toBeUndefined();
      expect(metrics.incWsConnection).not.toHaveBeenCalled();
    });

    it('rejects the handshake when the connection rate limit is exceeded, before verifying the JWT', async () => {
      rateLimiter.allowConnection.mockResolvedValue(false);
      const client = fakeSocket();

      await gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(authService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('decrements the gauge only for a socket that had been authenticated', () => {
      const authed = fakeSocket();
      authed.data.user = { id: TEST_USERS.alice };
      gateway.handleDisconnect(authed as never);
      expect(metrics.decWsConnection).toHaveBeenCalledTimes(1);

      metrics.decWsConnection.mockClear();
      gateway.handleDisconnect(fakeSocket() as never);
      expect(metrics.decWsConnection).not.toHaveBeenCalled();
    });
  });

  describe('conversation:join / conversation:leave', () => {
    it('join checks participation, then adds the socket to the conversation room', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };

      const res = await gateway.join(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(messages.assertParticipant).toHaveBeenCalledWith(
        TEST_CONVERSATION_ID,
        TEST_USERS.alice,
      );
      expect(client.join).toHaveBeenCalledWith(`conversation:${TEST_CONVERSATION_ID}`);
      expect(res).toEqual({ event: 'conversation:joined', data: TEST_CONVERSATION_ID });
    });

    it('join refuses (no room join) when the caller is not a participant', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.carol };
      messages.assertParticipant.mockRejectedValue(new ForbiddenException('not a participant'));

      await expect(
        gateway.join(client as never, { conversationId: TEST_CONVERSATION_ID }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('join throws WsException when the socket has no attached user', async () => {
      const client = fakeSocket();
      await expect(
        gateway.join(client as never, { conversationId: TEST_CONVERSATION_ID }),
      ).rejects.toBeInstanceOf(WsException);
    });

    it('leave removes the socket from the conversation room', () => {
      const client = fakeSocket();
      const res = gateway.leave(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(client.leave).toHaveBeenCalledWith(`conversation:${TEST_CONVERSATION_ID}`);
      expect(res).toEqual({ event: 'conversation:left', data: TEST_CONVERSATION_ID });
    });
  });

  describe('message:send', () => {
    it('delegates to MessagesService.send for an authenticated socket within its quota', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };
      messages.send.mockResolvedValue(makeMessage());

      const body = { conversationId: TEST_CONVERSATION_ID, content: 'hi', metadata: undefined };
      await gateway.sendMessage(client as never, body);

      expect(rateLimiter.allowMessage).toHaveBeenCalledWith(TEST_USERS.alice, 'sock-1');
      expect(metrics.incWsMessage).toHaveBeenCalledTimes(1);
      expect(messages.send).toHaveBeenCalledWith(TEST_CONVERSATION_ID, TEST_USERS.alice, {
        content: 'hi',
        metadata: undefined,
      });
    });

    it('throws WsException and does not send when the per-user rate limit is exceeded', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };
      rateLimiter.allowMessage.mockResolvedValue(false);

      await expect(
        gateway.sendMessage(client as never, {
          conversationId: TEST_CONVERSATION_ID,
          content: 'spam',
        }),
      ).rejects.toBeInstanceOf(WsException);
      expect(messages.send).not.toHaveBeenCalled();
      expect(metrics.incWsMessage).not.toHaveBeenCalled();
    });

    it('throws WsException when the socket has no attached user', async () => {
      const client = fakeSocket();
      await expect(
        gateway.sendMessage(client as never, {
          conversationId: TEST_CONVERSATION_ID,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(WsException);
    });
  });

  describe('typing:start / typing:stop', () => {
    it('relays a "typing" event to the rest of the conversation room after checking participation', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };

      await gateway.typingStart(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(messages.assertParticipant).toHaveBeenCalledWith(
        TEST_CONVERSATION_ID,
        TEST_USERS.alice,
      );
      expect(client.to).toHaveBeenCalledWith(`conversation:${TEST_CONVERSATION_ID}`);
      expect(client._emit).toHaveBeenCalledWith('typing', {
        conversationId: TEST_CONVERSATION_ID,
        userId: TEST_USERS.alice,
        typing: true,
      });
    });

    it('typing:stop emits typing:false', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };

      await gateway.typingStop(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(client._emit).toHaveBeenCalledWith('typing', {
        conversationId: TEST_CONVERSATION_ID,
        userId: TEST_USERS.alice,
        typing: false,
      });
    });

    it('stays silent (no participation check, no emit) when the typing rate limit is hit', async () => {
      const client = fakeSocket();
      client.data.user = { id: TEST_USERS.alice };
      rateLimiter.allowTyping.mockResolvedValue(false);

      await gateway.typingStart(client as never, { conversationId: TEST_CONVERSATION_ID });

      expect(messages.assertParticipant).not.toHaveBeenCalled();
      expect(client._emit).not.toHaveBeenCalled();
    });

    it('throws WsException when the socket has no attached user', async () => {
      const client = fakeSocket();
      await expect(
        gateway.typingStart(client as never, { conversationId: TEST_CONVERSATION_ID }),
      ).rejects.toBeInstanceOf(WsException);
    });
  });
});
