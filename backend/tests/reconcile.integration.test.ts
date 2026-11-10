import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SUMMARY_QUEUE,
  SummaryResult,
  type SummaryRunJob,
} from "@summarly/contracts";
import { parseEncryptionKey } from "../src/lib/crypto.js";
import { createRedisSummaryEnqueuer, RedisSummaryEnqueuer } from "../src/lib/enqueue.js";
import { PostgresStore } from "../src/lib/postgres-store.js";
import { Reconciler } from "../src/lib/reconcile.js";
import { assertTestDatabaseName } from "../scripts/test-db-guard.js";
// The REAL summary-worker pipeline (workspace sibling): this test must
// prove that reconciliation's re-enqueue is consumed by the actual
// worker code, not by a stand-in processor.
import {
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
  MockAiProvider,
} from "../../summary-worker/src/ai/mock-provider.js";
import { PostgresWorkerDb } from "../../summary-worker/src/db.js";
import { silentLogger } from "../../summary-worker/src/lib/log.js";
import { createSummaryWorker } from "../../summary-worker/src/worker.js";

/**
 * Queue/reconciliation integration tests against REAL Redis + real
 * PostgreSQL (docker-compose.dev.yml). Covers:
 *
 *   1. the job-id mechanism (docs/decisions/0003) on real BullMQ —
 *      dedupe of live jobs, dead-job replacement, active-job
 *      protection;
 *   2. the architecture A6 loop: a stuck `pending` run is picked up by
 *      the reconciliation pass, re-enqueued, and completed by the real
 *      summary-worker pipeline.
 *
 * SAFETY (DEF-2): every test TRUNCATEs all application tables. The
 * suite refuses to run unless the database name ends in `_test` or
 * contains `_e2e_` (see scripts/test-db-guard.ts). Run it through
 * `npm run test:integration` (which fails fast without PostgreSQL and
 * Redis); without DATABASE_URL/REDIS_URL it is SKIPPED loudly.
 */

const databaseUrl = process.env["DATABASE_URL"]?.trim();
const redisUrl = process.env["REDIS_URL"]?.trim();
const hasConfig =
  databaseUrl !== undefined &&
  databaseUrl !== "" &&
  redisUrl !== undefined &&
  redisUrl !== "";

if (!hasConfig) {
  process.stderr.write(
    "[summarly] WARNING: backend queue/reconciliation integration tests " +
      "were SKIPPED (DATABASE_URL and/or REDIS_URL is not set). Run them " +
      "with `npm run test:integration` (requires PostgreSQL + Redis — see " +
      "docker-compose.dev.yml).\n",
  );
}

async function pingRedis(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    connectTimeout: 2000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const redisReachable = hasConfig ? await pingRedis(redisUrl) : false;
if (hasConfig && !redisReachable) {
  process.stderr.write(
    "[summarly] WARNING: backend queue/reconciliation integration tests " +
      "were SKIPPED (Redis is not reachable at REDIS_URL). Start the dev " +
      "infrastructure with `docker compose -f docker-compose.dev.yml up -d`.\n",
  );
}

const shouldRun = hasConfig && redisReachable;

/**
 * Dedicated BullMQ key-prefix namespace for this suite (audit M1): a
 * test worker must never steal jobs from a running dev instance
 * (`summarly`) — see docs/decisions/0003.
 */
const TEST_QUEUE_PREFIX = "summarly-test";

async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 30_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe.skipIf(!shouldRun)(
  "summary queue + reconciliation (real Redis + PostgreSQL)",
  () => {
    let pool: Pool;
    let redis: Redis;
    let store: PostgresStore;
    let enqueuer: RedisSummaryEnqueuer;

    beforeAll(async () => {
      if (databaseUrl === undefined || redisUrl === undefined) {
        throw new Error("DATABASE_URL/REDIS_URL missing"); // unreachable: gated above
      }
      pool = new Pool({ connectionString: databaseUrl });
      // DEF-2: refuse before ANY destructive statement.
      const result = await pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      assertTestDatabaseName(result.rows[0]?.name ?? "");
      // Workers need unbounded retries on blocking commands (BullMQ).
      redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      store = new PostgresStore(
        pool,
        parseEncryptionKey(
          Buffer.from("integration-tests-master-key-32b").toString("base64"),
        ),
      );
      enqueuer = createRedisSummaryEnqueuer({
        redisUrl,
        retryBaseMs: 25,
        prefix: TEST_QUEUE_PREFIX,
      });
    });

    afterAll(async () => {
      await enqueuer?.close();
      redis?.disconnect();
      await pool?.end();
    });

    beforeEach(async () => {
      await pool.query(
        "TRUNCATE TABLE summaries, summary_runs, messages, groups, " +
          "group_members, contact_overrides, admin_sessions, " +
          "admin_credentials, ai_provider_configs, " +
          "whatsapp_connections CASCADE",
      );
    });

    async function withQueue<T>(
      fn: (queue: Queue<SummaryRunJob>) => Promise<T>,
    ): Promise<T> {
      const queue = new Queue<SummaryRunJob>(SUMMARY_QUEUE, {
        connection: { url: redisUrl },
        prefix: TEST_QUEUE_PREFIX,
      });
      try {
        return await fn(queue);
      } finally {
        await queue.close();
      }
    }

    it(
      "job-id semantics: double enqueue leaves exactly one live job",
      async () => {
        const runId = randomUUID();
        await withQueue(async (queue) => {
          try {
            expect(await enqueuer.enqueueSummaryRun(runId)).toBe("enqueued");
            // Concurrent double-enqueue (e.g. POST racing reconciliation):
            // the second attempt must dedupe, not multiply.
            expect(await enqueuer.enqueueSummaryRun(runId)).toBe(
              "already-queued",
            );

            const job = await queue.getJob(runId);
            expect(job).toBeDefined();
            expect(await job?.getState()).toBe("waiting");
          } finally {
            // Leave no waiting job behind: later tests in this file run
            // real workers against the shared queue.
            await queue.remove(runId);
          }
        });
      },
      30_000,
    );

    it(
      "job-id semantics: a retained finished job never blocks re-enqueue",
      async () => {
        const runId = randomUUID();
        await withQueue(async (queue) => {
          await enqueuer.enqueueSummaryRun(runId);
          // Let a real worker finish the job; bounded retention keeps
          // the finished job key around (removeOnComplete: 1000).
          const worker = new Worker(
            SUMMARY_QUEUE,
            async () => "done",
            { connection: redis, concurrency: 1, prefix: TEST_QUEUE_PREFIX },
          );
          try {
            await waitFor("the job to complete", async () => {
              const job = await queue.getJob(runId);
              return (await job?.getState()) === "completed" ? true : undefined;
            });
          } finally {
            await worker.close();
          }

          // Without the dead-job removal this add would be SILENTLY
          // DROPPED by BullMQ (addStandardJob's `duplicated` handling).
          expect(await enqueuer.enqueueSummaryRun(runId)).toBe("enqueued");
          const job = await queue.getJob(runId);
          expect(await job?.getState()).toBe("waiting");
        });
      },
      30_000,
    );

    it(
      "job-id semantics: an ACTIVE job is never removed or duplicated",
      async () => {
        const runId = randomUUID();
        await withQueue(async (queue) => {
          await enqueuer.enqueueSummaryRun(runId);

          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const worker = new Worker<SummaryRunJob>(
            SUMMARY_QUEUE,
            async (job) => {
              // Block only THIS test's job: foreign leftovers on the
              // shared queue must never hold the gate.
              if (job.data.summaryRunId === runId) await gate;
              return "done";
            },
            { connection: redis, concurrency: 1, prefix: TEST_QUEUE_PREFIX },
          );
          try {
            await waitFor("the job to become active", async () => {
              const job = await queue.getJob(runId);
              return (await job?.getState()) === "active" ? true : undefined;
            });

            // Re-request while the worker holds it: dedupe, and the
            // active job must survive untouched (BullMQ's remove script
            // refuses locked jobs).
            expect(await enqueuer.enqueueSummaryRun(runId)).toBe(
              "already-queued",
            );
            const job = await queue.getJob(runId);
            expect(await job?.getState()).toBe("active");

            release();
            await waitFor("the job to complete", async () => {
              const current = await queue.getJob(runId);
              return (await current?.getState()) === "completed"
                ? true
                : undefined;
            });
          } finally {
            release();
            await worker.close();
          }
        });
      },
      30_000,
    );

    it(
      "a stuck pending run is re-enqueued by reconciliation and completes",
      async () => {
        // ---- seed: a stuck pending run (idle for 10 minutes) with
        // messages in its interval (architecture A6 recovery case) ----
        const chatId = `${randomUUID()}@g.us`;
        const groupId = randomUUID();
        const runId = randomUUID();
        const start = "2026-10-28T00:00:00Z";
        const end = "2026-10-29T00:00:00Z";
        await pool.query(
          "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
          [randomUUID()],
        );
        await pool.query(
          "INSERT INTO groups (id, chat_id, name, timezone) VALUES ($1, $2, $3, $4)",
          [groupId, chatId, "Reconcile Group", "Europe/Madrid"],
        );
        for (const [index, text] of [
          "The deploy finished without errors.",
          "We agreed to ship the release on Friday.",
        ].entries()) {
          await pool.query(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id, sent_at, body)
             SELECT id, $1, $2, $3, $4, $5 FROM whatsapp_connections LIMIT 1`,
            [
              chatId,
              `wa-${index}-${randomUUID()}`,
              `sender-${index}`,
              new Date("2026-10-28T09:00:00Z"),
              text,
            ],
          );
        }
        await pool.query(
          `INSERT INTO summary_runs
             (id, group_id, kind, status, start_at, end_at, timezone,
              created_at, updated_at)
           VALUES ($1, $2, 'manual', 'pending', $3, $4, 'Europe/Madrid',
                   now() - interval '10 minutes', now() - interval '10 minutes')`,
          [runId, groupId, new Date(start), new Date(end)],
        );

        // ---- reconciliation picks it up (default thresholds) ----
        const reconciler = new Reconciler({
          store,
          enqueue: enqueuer,
          log: silentLike,
        });
        const requeued = await reconciler.runOnce();
        expect(requeued).toContain(runId);
        await withQueue(async (queue) => {
          const job = await queue.getJob(runId);
          expect(job).toBeDefined();
          expect(await job?.getState()).toBe("waiting");
        });

        // ---- the REAL summary-worker consumes it and completes ----
        const worker = createSummaryWorker({
          connection: redis,
          db: new PostgresWorkerDb(pool),
          provider: new MockAiProvider(),
          providerName: MOCK_PROVIDER_NAME,
          modelName: MOCK_MODEL_NAME,
          concurrency: 1,
          prefix: TEST_QUEUE_PREFIX,
          log: silentLogger,
        });
        try {
          const run = await waitFor(
            "the run to complete",
            async () => {
              const result = await pool.query<{
                status: string;
                attempts: number;
                error_code: string | null;
              }>(
                "SELECT status, attempts, error_code FROM summary_runs WHERE id = $1",
                [runId],
              );
              const row = result.rows[0];
              if (row === undefined) return undefined;
              if (row.status === "failed") {
                throw new Error(`run failed: ${row.error_code ?? "unknown"}`);
              }
              return row.status === "completed" ? row : undefined;
            },
            45_000,
          );
          expect(run.attempts).toBeGreaterThanOrEqual(1);
          expect(run.error_code).toBeNull();

          const summaries = await pool.query<{
            id: string;
            provider: string;
            model: string;
            result: unknown;
          }>(
            "SELECT id, provider, model, result FROM summaries WHERE run_id = $1",
            [runId],
          );
          expect(summaries.rows).toHaveLength(1);
          const summary = summaries.rows[0];
          if (summary === undefined) throw new Error("no summary row");
          const result = SummaryResult.parse(summary.result);
          expect(result.aiGenerated).toBe(true);
          expect(summary.provider).toBe(MOCK_PROVIDER_NAME);
          expect(summary.model).toBe(MOCK_MODEL_NAME);
          expect(result.keyDiscussions.join("\n")).toContain(
            "We agreed to ship the release on Friday.",
          );
        } finally {
          await worker.close();
        }
      },
      60_000,
    );
  },
);

/** Structured-noop logger for the reconciler in this suite. */
function silentLike(): void {}
