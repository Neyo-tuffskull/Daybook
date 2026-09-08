/**
 * Where does the time go?
 *
 * `POST /auth/register` took 1.4 seconds on 2026-09-04 and 38.9 seconds on
 * 2026-09-06, with no code change in between. "The database is slow" is a
 * symptom, not a diagnosis, and there are five separable causes:
 *
 *   1. DNS resolution is slow.
 *   2. The network path to the provider is slow.
 *   3. The provider's connection pooler is slow to answer.
 *   4. The provider's compute is throttled or cold, so it is slow even for a
 *      trivial query once the packet arrives.
 *   5. Our own code is doing more round trips than it needs to.
 *
 * Each section below isolates one of them.
 *
 * The handshake section speaks Postgres' wire protocol directly, far enough to
 * time a connection and no further: DNS, then TCP to a resolved address, then
 * the eight-byte `SSLRequest` and its one-byte answer. That last exchange is
 * one round trip with no authentication, no parsing and no query planning in
 * it, which makes it the cleanest available ruler. Everything afterwards is
 * measured against it.
 *
 * It probes three hosts on purpose. The pooler, which is what the application
 * connects to; the direct compute endpoint, which is the same network path to a
 * different server process, so a difference between them is the pooler's doing
 * and not the network's; and an unrelated host on the open internet, so a slow
 * result can be attributed to this machine's connection rather than to the
 * provider.
 *
 * Read-only throughout. It runs as the application role, creates nothing and
 * writes nothing.
 *
 * Usage:
 *   pnpm --filter @daybook/db db:latency
 *   pnpm --filter @daybook/db db:latency:test
 */
import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { takeTarget } from './owner-url.mjs';

const SAMPLES = 15;

/** A UUID belonging to nobody. Only ever written to a setting, never queried. */
const PROBE_USER = '00000000-0000-0000-0000-000000000000';

/** Somewhere with no relationship to this project, to tell "my connection is
 *  slow" apart from "the provider is slow". */
const CONTROL_HOST = 'www.cloudflare.com';

const { target } = takeTarget(process.argv.slice(2));
const variable = target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const url = process.env[variable];

if (!url) {
  console.error(`${variable} is not set. Run this through dotenv, as the package scripts do.`);
  process.exit(1);
}

const parsed = new URL(url);
const host = parsed.hostname;
const port = Number(parsed.port || 5432);
// Neon's pooler and its compute differ by one label in the hostname. Same
// route, same region, different process listening at the end of it.
const directHost = host.includes('-pooler') ? host.replace('-pooler', '') : null;

console.log('');
console.log(`Probing ${variable}: ${parsed.username} @ ${host}${parsed.pathname}`);
console.log('');
console.log('Handshake, three attempts each, every attempt on a fresh connection');
console.log('');

const pooler = await probeMany('pooler   ', host, port, 'postgres');
const direct = directHost ? await probeMany('direct   ', directHost, port, 'postgres') : null;
const control = await probeMany('control  ', CONTROL_HOST, 443, 'tls');

// ---------------------------------------------------------------------------
// The database, answering questions.
// ---------------------------------------------------------------------------

console.log('');
console.log('Queries');

let warm = null;
let asUserMs = null;
let batchMs = null;
let batchSharesTransaction = null;

try {
  // The generated client, not the `@prisma/client` package: this schema
  // generates into the package. Run `pnpm --filter @daybook/db build` first if
  // this import fails.
  const { PrismaClient } = await import('../generated/client/index.js');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const coldMs = await time(() => prisma.$queryRaw`SELECT 1`);
    console.log(`  first query, including connect and authentication  ${pad(coldMs)}`);

    const samples = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      samples.push(await time(() => prisma.$queryRaw`SELECT 1`));
    }
    warm = summarise(samples);
    console.log(
      `  SELECT 1, ${SAMPLES} sequential   ` +
        `min ${pad(warm.min)}  median ${pad(warm.median)}  max ${pad(warm.max)}`,
    );

    const txnMs = await time(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await tx.$queryRaw`SELECT 1`;
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 120_000, maxWait: 120_000 },
      ),
    );
    console.log(`  transaction with three statements                  ${pad(txnMs)}`);

    // The shape asUser() actually uses: set_config plus the work, in one
    // transaction. If this is far worse than the line above, the pooler is
    // charging us for session state rather than the statements costing
    // anything.
    asUserMs = await time(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_user_id', ${PROBE_USER}, true)`;
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 120_000, maxWait: 120_000 },
      ),
    );
    console.log(`  set_config plus one statement, as asUser() does    ${pad(asUserMs)}`);

    // The same two statements as a batch rather than a callback. Two questions
    // at once, and the second matters more than the first: does the batch cost
    // fewer round trips, and do both statements land in one transaction? A
    // transaction-local setting is invisible to the second statement if they do
    // not, and row-level security would then return no rows rather than an
    // error, which is the worst way for this to be wrong.
    let seen = null;
    batchMs = await time(async () => {
      const [, rows] = await prisma.$transaction([
        prisma.$executeRaw`SELECT set_config('app.current_user_id', ${PROBE_USER}, true)`,
        prisma.$queryRaw`SELECT current_setting('app.current_user_id', true) AS value`,
      ]);
      seen = rows?.[0]?.value ?? null;
    });
    batchSharesTransaction = seen === PROBE_USER;
    console.log(`  the same two as a batch, $transaction([...])       ${pad(batchMs)}`);
    console.log(
      `  batch shares one transaction                       ${
        batchSharesTransaction ? '      yes' : `       NO (saw ${seen ?? 'nothing'})`
      }`,
    );
  } finally {
    await prisma.$disconnect();
  }
} catch (error) {
  // Prisma's messages start with a newline and run to several paragraphs.
  // Printing the first line of one prints nothing at all, which is how the
  // first run of this script reported a failure as "failed:" and nothing else.
  console.log('  failed. The error, in full:');
  console.log('');
  console.log(indent(error instanceof Error ? (error.stack ?? error.message) : String(error)));
}

// ---------------------------------------------------------------------------
// Argon2, so a slow hash is never mistaken for a slow database.
// ---------------------------------------------------------------------------

console.log('');
console.log('Password hashing');
try {
  const argon2 = await import('argon2');
  const hashMs = await time(() =>
    argon2.hash('a-password-nobody-uses', {
      type: argon2.argon2id,
      memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_KIB ?? 65536),
      timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 3),
      parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
    }),
  );
  console.log(`  argon2id at the configured parameters              ${pad(hashMs)}`);
} catch {
  console.log('  argon2 lives in apps/api and does not resolve from here; skipped.');
  console.log('  It is CPU on this machine, not network, so it is not a suspect.');
}

// ---------------------------------------------------------------------------
// What the numbers mean.
// ---------------------------------------------------------------------------

console.log('');
console.log('Reading');
console.log('');

if (!pooler.best) {
  console.log('  The pooler did not complete a handshake. Nothing else can be attributed.');
} else {
  const rtt = pooler.best.rttMs;
  line('Round trip to the pooler, no query in it', rtt);
  if (direct?.best) line('Round trip to the compute directly', direct.best.rttMs);
  if (control.best) line(`Round trip to ${CONTROL_HOST}`, control.best.rttMs);
  if (warm) line('Median cost of answering SELECT 1', warm.median);
  console.log('');

  const healthyRtt = 150;

  if (control.best && control.best.rttMs > healthyRtt && rtt > healthyRtt) {
    console.log('  Everything is slow, including a host with no connection to this');
    console.log("  project. That is this machine's network, not the provider: check");
    console.log('  the Wi-Fi signal, a VPN or proxy, and whether anything else is');
    console.log('  saturating the link. No change to this codebase can help.');
  } else if (rtt > healthyRtt && direct?.best && direct.best.rttMs < rtt / 2) {
    console.log('  The route is fine and the pooler is the slow part: the compute');
    console.log('  endpoint answers quickly over the same path. Connecting directly');
    console.log("  is worth trying, at the cost of the pooler's connection reuse.");
  } else if (rtt > healthyRtt) {
    console.log('  The path to the provider is slow while the rest of the internet is');
    console.log("  not. Routing, or the provider's region. Nothing in the application");
    console.log('  can beat it: a request making ten round trips cannot be faster than');
    console.log('  ten of these.');
  } else if (warm && warm.median > rtt * 3) {
    console.log('  Packets arrive quickly and answers do not. That is the provider:');
    console.log('  a throttled or suspended compute, or a quota. Check the console');
    console.log('  before changing any code.');
  } else {
    console.log('  Query cost tracks round-trip time, which is the healthy shape. If');
    console.log('  requests are still slow, the number of round trips per request is');
    console.log('  the thing to reduce.');
  }

  const perRequest = warm ? warm.median : rtt;
  console.log('');
  console.log(`  At this rate a ten-round-trip request costs about ${pad(perRequest * 10)}`);

  if (asUserMs !== null && batchMs !== null) {
    console.log('');
    if (!batchSharesTransaction) {
      console.log('  The batch did NOT share a transaction, so a transaction-local');
      console.log('  set_config is invisible to the statement that needs it. Batching');
      console.log('  user-scoped reads this way would return no rows rather than an');
      console.log('  error. Do not do it, whatever the timings say.');
    } else if (batchMs < asUserMs * 0.6) {
      const saved = Math.round(asUserMs - batchMs);
      console.log(`  Batching saves about ${saved}ms per user-scoped read, and both`);
      console.log('  statements share a transaction, so row-level security still sees');
      console.log('  the identity. Worth changing asUser() for single-statement reads.');
    } else {
      console.log('  Batching costs about the same as the callback, so the round trips');
      console.log('  are happening below Prisma rather than above it. Changing asUser()');
      console.log('  would buy nothing. Leave it alone.');
    }
  }
}
console.log('');

// ---------------------------------------------------------------------------

async function probeMany(label, hostname, portNumber, mode) {
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await timeHandshake(hostname, portNumber, mode);
      results.push(result);
      console.log(
        `  ${label} ${hostname}\n` +
          `    dns ${pad(result.dnsMs)}   tcp ${pad(result.tcpMs)}   ` +
          `round trip ${pad(result.rttMs)}   tls ${pad(result.tlsMs)}`,
      );
    } catch (error) {
      console.log(`  ${label} ${hostname}\n    failed: ${error.message}`);
    }
  }
  const best = results.length ? results.reduce((a, b) => (a.rttMs <= b.rttMs ? a : b)) : null;
  return { results, best };
}

/**
 * Times a connection as far as the TLS handshake, in four separable parts.
 *
 * In `postgres` mode the round trip is the wire protocol's `SSLRequest`: eight
 * bytes out (length 8, request code 80877103), one byte back, `S` for yes. That
 * exchange is one round trip and nothing else, which is what makes it a good
 * ruler. In `tls` mode there is no such handshake to borrow, so the round trip
 * is reported as the TCP connect, which is also one round trip.
 */
async function timeHandshake(hostname, portNumber, mode) {
  const dnsStarted = process.hrtime.bigint();
  const { address } = await lookup(hostname);
  const dnsMs = ms(dnsStarted, process.hrtime.bigint());

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let connectedAt = null;

    const socket = net.connect({ host: address, port: portNumber });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out after 30s'));
    }, 30_000);

    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once('error', fail);

    socket.once('connect', () => {
      connectedAt = process.hrtime.bigint();
      if (mode === 'tls') {
        const secure = tls.connect({ socket, servername: hostname }, () => {
          clearTimeout(timer);
          const finishedAt = process.hrtime.bigint();
          secure.destroy();
          resolve({
            dnsMs,
            tcpMs: ms(started, connectedAt),
            rttMs: ms(started, connectedAt),
            tlsMs: ms(connectedAt, finishedAt),
          });
        });
        secure.once('error', fail);
        return;
      }

      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);

      socket.once('data', (chunk) => {
        const repliedAt = process.hrtime.bigint();
        if (chunk[0] !== 0x53) {
          fail(new Error('the server refused TLS'));
          return;
        }
        const secure = tls.connect({ socket, servername: hostname }, () => {
          clearTimeout(timer);
          const finishedAt = process.hrtime.bigint();
          secure.destroy();
          resolve({
            dnsMs,
            tcpMs: ms(started, connectedAt),
            rttMs: ms(connectedAt, repliedAt),
            tlsMs: ms(repliedAt, finishedAt),
          });
        });
        secure.once('error', fail);
      });
    });
  });
}

async function time(work) {
  const started = process.hrtime.bigint();
  await work();
  return ms(started, process.hrtime.bigint());
}

function ms(from, to) {
  return Number(to - from) / 1_000_000;
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function line(label, value) {
  console.log(`  ${label.padEnd(44)}${pad(value)}`);
}

function pad(value) {
  return `${Math.round(value).toLocaleString('en-GB')}ms`.padStart(9);
}

function indent(text) {
  return text
    .split('\n')
    .map((row) => `    ${row}`)
    .join('\n');
}
