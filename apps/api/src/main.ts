import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.ts';
import { configureApp } from './bootstrap.ts';
import { loadConfig } from './config.ts';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Every request carries an id that follows it into the logs, into the
      // outbox row it writes, and into the worker that later processes that
      // row. Without it, tracing a failed sync means guessing.
      genReqId: () => randomUUID(),
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  await configureApp(app, config);

  app.enableShutdownHooks();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void bootstrap();
