import { Pool } from "pg";
import { parseQueuePrefix, parseRetryBaseMs } from "@summarly/contracts";
import { buildApp } from "./app.js";
import { parseEncryptionKey } from "./lib/crypto.js";
import {
  createRedisSummaryEnqueuer,
  type EnqueueLogger,
} from "./lib/enqueue.js";
import { loadRepoEnv } from "./lib/load-env.js";
import { PostgresStore } from "./lib/postgres-store.js";
import { parseReconcileIntervalMs, Reconciler } from "./lib/reconcile.js";
import {
  parseRetentionDays,
  parseRetentionIntervalMs,
  RetentionService,
} from "./lib/retention.js";
import {
  parseSchedulerEnabled,
  parseSchedulerIntervalMs,
  parseBackfillDays,
  parseSummaryTime,
  Scheduler,
} from "./lib/scheduler.js";
import {
  defaultWorkerSpecs,
  parseSuperviseWorkers,
  WorkerSupervisor,
} from "./lib/supervisor.js";

// Load the repository-root .env (see .env.example) before any
// configuration is read. Shell-exported variables win over the file.
loadRepoEnv();

const port = Number(process.env["PORT"] ?? 3000);
// Safe default: bind to loopback only. Containers set HOST=0.0.0.0.
const host = process.env["HOST"] ?? "127.0.0.1";

/**
 * Reverse proxies whose X-Forwarded-For header is trusted for client-IP
 * derivation (rate limiting). Default: loopback only, which covers the
 * dashboard's local Next.js proxy. Never add an untrusted address here —
 * it would let clients pick their own lockout bucket.
 */
function parseTrustedProxies(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (value === undefined || value === "") return ["127.0.0.1", "::1"];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Fail fast at startup with an actionable message (never echoing secrets). */
function fail(message: string): never {
  console.error(`[summarly-backend] ${message}`);
  process.exit(1);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    return fail(
      "DATABASE_URL is required. Copy .env.example to .env at the repository " +
        "root (it is loaded automatically) or export it in the environment " +
        "(docker-compose.dev.yml provides a local PostgreSQL).",
    );
  }
  return databaseUrl;
}

function requireRedisUrl(): string {
  const redisUrl = process.env["REDIS_URL"]?.trim();
  if (redisUrl === undefined || redisUrl === "") {
    return fail(
      "REDIS_URL is required (BullMQ queue state for summary runs). Copy " +
        ".env.example to .env at the repository root (it is loaded " +
        "automatically) or export it in the environment (docker-compose.dev.yml " +
        "provides a local Redis).",
    );
  }
  return redisUrl;
}

function requireEncryptionKey(): Buffer {
  try {
    return parseEncryptionKey(process.env["ENCRYPTION_KEY"]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid ENCRYPTION_KEY.");
  }
}

/** Structured operational logs: identifiers and safe metadata only. */
const log: EnqueueLogger = (event, fields) => {
  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    service: "summarly-backend",
    event,
    ...fields,
  })}\n`;
  process.stdout.write(line);
};

const pool = new Pool({ connectionString: requireDatabaseUrl() });
// Log only the driver message; never query parameters or credentials.
pool.on("error", (error) => {
  console.error(`[summarly-backend] database pool error: ${error.message}`);
});

const redisUrl = requireRedisUrl();

// Producer-side queue configuration (docs/decisions/0003): the retry
// policy is stored on the job at enqueue time, so the backend — not the
// worker — is where SUMMARY_RETRY_BASE_MS takes effect (M2).
let retryBaseMs: number;
let queuePrefix: string;
let reconcileIntervalMs: number;
let schedulerEnabled: boolean;
let schedulerIntervalMs: number;
let defaultSummaryTime: number;
let backfillDays: number;
let superviseWorkers: boolean;
let retentionDays: number;
let retentionIntervalMs: number;
try {
  retryBaseMs = parseRetryBaseMs(process.env["SUMMARY_RETRY_BASE_MS"]);
  queuePrefix = parseQueuePrefix(process.env["SUMMARY_QUEUE_PREFIX"]);
  reconcileIntervalMs = parseReconcileIntervalMs(
    process.env["RECONCILE_INTERVAL_MS"],
  );
  schedulerEnabled = parseSchedulerEnabled(process.env["SCHEDULER_ENABLED"]);
  schedulerIntervalMs = parseSchedulerIntervalMs(
    process.env["SCHEDULER_INTERVAL_MS"],
  );
  defaultSummaryTime = parseSummaryTime(process.env["DEFAULT_SUMMARY_TIME"]);
  backfillDays = parseBackfillDays(process.env["BACKFILL_DAYS"]);
  superviseWorkers = parseSuperviseWorkers(process.env["SUPERVISE_WORKERS"]);
  retentionDays = parseRetentionDays(process.env["MESSAGE_RETENTION_DAYS"]);
  retentionIntervalMs = parseRetentionIntervalMs(
    process.env["RETENTION_INTERVAL_MS"],
  );
} catch (error) {
  fail(error instanceof Error ? error.message : "Invalid configuration.");
}

const enqueuer = createRedisSummaryEnqueuer({
  redisUrl,
  retryBaseMs,
  prefix: queuePrefix,
  log,
});

const store = new PostgresStore(pool, requireEncryptionKey());

const reconciler = new Reconciler({
  store,
  enqueue: enqueuer,
  intervalMs: reconcileIntervalMs,
  log,
});

// Daily-summary scheduler (architecture §5.3, D5 — previous calendar
// day per group; docs/decisions/0006). Reconciliation and scheduling
// are separate concerns on separate timers: the scheduler CREATES runs
// for due groups, the reconciler RECOVERS runs whose enqueue was lost.
const scheduler = new Scheduler({
  store,
  enqueue: enqueuer,
  defaultCutoffMinutes: defaultSummaryTime,
  intervalMs: schedulerIntervalMs,
  backfillDays,
  log,
});

// Automatic message retention (MESSAGE_RETENTION_DAYS): deletes captured
// messages older than N days on a periodic pass. 0 (the default) keeps
// them forever, so the service is not even constructed. Messages only —
// summaries, runs, and settings are kept. Only the real backend index
// wires it: the in-memory/test store must never start a deletion timer.
const retention =
  retentionDays > 0
    ? new RetentionService({
        store,
        retentionDays,
        intervalMs: retentionIntervalMs,
        log,
      })
    : undefined;

const app = await buildApp({
  store,
  enqueue: enqueuer,
  cookieSecure: process.env["COOKIE_SECURE"] === "true",
  logger: process.env["NODE_ENV"] !== "test",
  trustProxy: parseTrustedProxies(process.env["TRUSTED_PROXIES"]),
});

await app.listen({ port, host });
// Architecture A6: reconciliation starts with the backend — one pass at
// startup (repair the backlog after a restart) and then on an interval.
reconciler.start();
// The scheduler also passes once at startup (a restart must not miss
// the day's cutoff) and then on its own interval.
if (schedulerEnabled) {
  scheduler.start();
}
// Retention also passes once at startup and then on its own interval.
retention?.start();
// Worker supervision (docs/decisions/0008, round 3): spawn and
// supervise summary-worker + bot-worker so `npm run dev -w
// @summarly/backend` + the dashboard is all that is needed. The e2e
// script — and the future deployment Compose (no application Compose
// exists yet) — run their own workers and set SUPERVISE_WORKERS=false.
let supervisor: WorkerSupervisor | undefined;
if (superviseWorkers) {
  supervisor = new WorkerSupervisor(defaultWorkerSpecs(), { log });
  supervisor.start();
}
log("backend_started", {
  port,
  pid: process.pid,
  superviseWorkers,
  reconcileIntervalMs,
  schedulerEnabled,
  schedulerIntervalMs,
  backfillDays,
  defaultSummaryTime: String(
    `${String(Math.floor(defaultSummaryTime / 60)).padStart(2, "0")}:${String(defaultSummaryTime % 60).padStart(2, "0")}`,
  ),
  retryBaseMs,
  queuePrefix,
  retentionDays,
  retentionIntervalMs,
});

let shuttingDown = false;
// Windows consoles deliver Ctrl+C as SIGINT and Ctrl+Break as SIGBREAK;
// both are graceful shutdown signals here. POSIX has no SIGBREAK.
const shutdownSignals: readonly NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
for (const signal of shutdownSignals) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        // Supervised workers stop FIRST, then scheduled work, HTTP, the
        // queue, and the database pool (architecture A6 graceful
        // shutdown).
        await supervisor?.stop();
        await scheduler.stop();
        await reconciler.stop();
        // Retention stops after the other timers and before the pool:
        // its in-flight DELETE finishes (or is awaited) while the
        // database connection is still open.
        await retention?.stop();
        await app.close();
        await enqueuer.close();
        await pool.end();
        log("backend_stopped", { signal });
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();
  });
}
