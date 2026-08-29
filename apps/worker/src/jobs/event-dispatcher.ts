import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';

export const EVENT_DISPATCH_QUEUE = 'event-dispatch';

/**
 * Phase 9 implements the handlers. This file exists now so the wiring, the
 * retry ladder and the shutdown behaviour are settled before there is anything
 * important flowing through them.
 *
 * The ladder is documented in docs/SYNC.md section 6. Full jitter is applied so
 * that a burst of failures does not retry in lockstep.
 */
export const RETRY_DELAYS_SECONDS = [0, 5, 30, 120, 600, 3600, 21_600, 86_400];

export function nextDelaySeconds(attempt: number): number {
  const base = RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length - 1)] ?? 0;
  return Math.floor(Math.random() * base);
}

export async function registerEventDispatcher(boss: PgBoss, log: Logger): Promise<void> {
  await boss.createQueue(EVENT_DISPATCH_QUEUE);
  await boss.work(EVENT_DISPATCH_QUEUE, { batchSize: 10 }, async (jobs) => {
    // Phase 9: claim pending rows from event_deliveries with FOR UPDATE SKIP
    // LOCKED, run the projector, mark delivered. Handlers set absolute state
    // rather than applying deltas, which is what makes a redelivery harmless.
    log.debug({ count: jobs.length }, 'event dispatch tick (no handlers yet)');
  });
}
