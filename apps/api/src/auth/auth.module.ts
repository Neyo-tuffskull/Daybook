import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CONFIG, configProvider } from '../config.provider.ts';
import { AuthController } from './auth.controller.ts';
import { AuthService } from './auth.service.ts';
import { GoogleController } from './google.controller.ts';
import { JwtAuthGuard } from './jwt-auth.guard.ts';
import { ConsoleMailer, MAILER } from './mailer.ts';
import { PasswordService } from './password.service.ts';
import { SessionService } from './session.service.ts';
import { TokenService } from './token.service.ts';
import { MeController } from '../me/me.controller.ts';

/**
 * Identity, in one module.
 *
 * The guard is registered as APP_GUARD, which makes it global: every route in
 * the application is authenticated unless it says otherwise. Registering it
 * here rather than in the root module keeps the guard next to the thing that
 * defines what it means, and means the root module cannot accidentally be
 * assembled without it.
 */
@Module({
  controllers: [AuthController, GoogleController, MeController],
  providers: [
    configProvider,
    PasswordService,
    TokenService,
    SessionService,
    AuthService,
    { provide: MAILER, useClass: ConsoleMailer },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [CONFIG, TokenService, AuthService],
})
export class AuthModule {}
