import PgBoss from 'pg-boss';
import pino from 'pino';
import { registerEventDispatcher } from './jobs/event-dispatcher.ts';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * The worker is a separate process from the API on purpose: a sync job that
 * blocks must never slow down a request a person is waiting on.
 *
 * pg-boss keeps the queue inside PostgreSQL, so a job and the row it acts on
 * can share a transaction and there is no second datastore to run or back up.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (error) => log.error({ err: error }, 'queue error'));

  await boss.start();
  await registerEventDispatcher(boss, log);

  log.info('worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    // Finish in-flight handlers rather than abandoning them mid-projection.
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
