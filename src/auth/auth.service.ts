import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from './auth-user.interface';

/**
 * Claims lus dans le JWT. `sub` est obligatoire (identité). `roles` est optionnel
 * et n'est exploité que si l'hôte le fournit — voir `RolesGuard` : tant qu'aucun
 * handler n'est décoré `@Roles(...)`, l'absence de ce claim n'a aucun effet.
 */
interface JwtPayload {
  sub?: string;
  roles?: unknown;
}

/** Ne garde que des chaînes non vides ; toute autre forme → `[]`. */
function normalizeRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((r): r is string => typeof r === 'string' && r.trim() !== '');
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

    const roles = normalizeRoles(payload.roles);
    return roles.length > 0 ? { id: payload.sub, roles } : { id: payload.sub };
  }
}
