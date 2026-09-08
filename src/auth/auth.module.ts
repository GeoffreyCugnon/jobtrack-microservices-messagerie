import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AppAuthGuard } from './app-auth.guard';
import { AuthService } from './auth.service';

/**
 * Configure la vérification JWT et expose AuthService + AppAuthGuard.
 *
 * @Global car AppAuthGuard est enregistré en APP_GUARD (résolu depuis le module
 * racine) et AuthService est réutilisé par MessagingGateway.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('MESSAGING_JWT_SECRET');
        // Échec au démarrage plutôt que des 401 silencieux en production.
        if (!secret) {
          throw new Error('MESSAGING_JWT_SECRET must be set');
        }
        // HS256 imposé à la vérification : le projet hôte signe avec le même secret.
        return { secret, verifyOptions: { algorithms: ['HS256'] } };
      },
    }),
  ],
  providers: [AuthService, AppAuthGuard],
  // JwtModule réexporté pour les tests (qui récupèrent JwtService via app.get()).
  exports: [AuthService, AppAuthGuard, JwtModule],
})
export class AuthModule {}
