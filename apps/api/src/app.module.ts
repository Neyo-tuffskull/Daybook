import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.ts';
import { HealthController } from './health/health.controller.ts';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Nothing on this list ever reaches a log line, in any environment.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.new_password',
            'req.body.current_password',
            'req.body.token',
            'req.body.email',
            '*.password_hash',
            '*.refresh_token_hash',
            '*.token_hash',
            '*.access_token',
            '*.refresh_token',
          ],
          remove: true,
        },
        customProps: (req) => ({ requestId: req.id }),
      },
    }),
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
