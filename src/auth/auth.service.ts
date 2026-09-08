import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from './auth-user.interface';

/** Claims attendus dans le JWT. Seul `sub` est exploité. */
interface JwtPayload {
  sub?: string;
}

/**
 * Vérification du JWT, partagée par le guard REST et par la gateway WebSocket
 * (handshake). Le secret et l'algorithme (HS256) sont configurés dans AuthModule.
 */
@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  /**
   * Valide un JWT signé avec MESSAGING_JWT_SECRET et retourne l'appelant.
   * Lève UnauthorizedException en cas de token absent, invalide, expiré, ou sans `sub`.
   */
  verifyToken(token?: string): AuthUser {
    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      // On masque la cause exacte (signature, expiration…) côté client.
      throw new UnauthorizedException('Invalid authentication token');
    }

    if (!payload?.sub) {
      throw new UnauthorizedException('Token is missing the "sub" claim');
    }

    return { id: payload.sub };
  }
}
