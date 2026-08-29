import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.ts';
import { HttpErrorFilter } from './common/http-error.filter.ts';
import { loadConfig } from './config.ts';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Every request carries an id that follows it into the logs, into the
      // outbox row it writes, and into the worker that later processes that
      // row. Without it, tracing a failed sync means guessing.
      genReqId: () => crypto.randomUUID(),
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpErrorFilter());

  await app.register(helmet, {
    contentSecurityPolicy: false, // The API serves JSON; the frontends set their own CSP.
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  });
  await app.register(cookie, { secret: undefined, parseOptions: {} });

  app.enableCors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Daybook-Client',
      'X-Client-Version',
    ],
    exposedHeaders: ['ETag', 'Idempotency-Replayed', 'Retry-After'],
  });

  app.enableShutdownHooks();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void bootstrap();
