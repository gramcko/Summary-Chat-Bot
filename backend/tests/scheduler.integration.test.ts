import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/lib/postgres-store.js";
import { parseSummaryTime, Scheduler } from "../src/lib/scheduler.js";
import { assertTestDatabaseName } from "../scripts/test-db-guard.js";
import { RecordingEnqueuer } from "./helpers.js";

/**
 * Scheduler integration tests against REAL PostgreSQL (throwaway
 * database, docker-compose.dev.yml): the D5 flow on the durable store.
 *
 * The four documented guarantees:
 *   1. a due group produces EXACTLY ONE scheduled run for the
 *      previous-day window;
 *   2. a second pass does not duplicate (create-or-find idempotency
 *      across ticks/restarts);
 *   3. an unmonitored group is never scheduled;
 *   4. the per-group summary_time overrides the install default.
 *
 * SAFETY (DEF-2): every test TRUNCATEs all application tables; the
 * suite refuses databases that do not look like throwaway test
 * databases (scripts/test-db-guard.ts). Without DATABASE_URL the suite
 * is SKIPPED loudly. The queue is a RecordingEnqueuer fake — Redis is
 * not needed for these guarantees (enqueue recovery is reconciliation's
 * tested concern).
 */

const databaseUrl = process.env["DATABASE_URL"]?.trim();

if (databaseUrl === undefined || databaseUrl === "") {
  process.stderr.write(
    "[summarly] WARNING: backend scheduler integration tests were " +
      "SKIPPED (DATABASE_URL is not set). Run them with " +
      "`npm run test:integration` (requires PostgreSQL — see " +
      "docker-compose.dev.yml).\n",
  );
}

const shouldRun = databaseUrl !== undefined && databaseUrl !== "";

/**
 * Fixed clock for determinism: 2026-11-02T10:00Z is 11:00 in
 * Europe/Madrid (CET, +01:00 — after the Oct 25 DST end). Local 11:00
 * is past a 09:00 cutoff and before an 18:00 one.
 */
const NOW = new Date("2026-11-02T10:00:00Z");

/** D5 window for "yesterday" in Europe/Madrid at NOW (verified vs Intl). */
const EXPECTED_WINDOW = {
  start: "2026-10-31T23:00:00.000Z",
  end: "2026-11-01T23:00:00.000Z",
  timezone: "Europe/Madrid",
};

interface RunRow {
  id: string;
  group_id: string;
  kind: string;
  status: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
}

describe.skipIf(!shouldRun)(
  "daily summary scheduler (real PostgreSQL integration)",
  () => {
    let pool: Pool;
    let store: PostgresStore;
    let enqueuer: RecordingEnqueuer;

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("DATABASE_URL missing");
      pool = new Pool({ connectionString: databaseUrl });
      // DEF-2: refuse before ANY destructive statement.
      const result = await pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      assertTestDatabaseName(result.rows[0]?.name ?? "");
      store = new PostgresStore(pool, testEncryptionKey());
    });

    afterAll(async () => {
      await pool?.end();
    });

    beforeEach(async () => {
      await pool.query(
        "TRUNCATE TABLE summaries, summary_runs, messages, groups, " +
          "group_members, contact_overrides, admin_sessions, " +
          "admin_credentials, ai_provider_configs, " +
          "whatsapp_connections CASCADE",
      );
      enqueuer = new RecordingEnqueuer();
    });

    async function seedGroup(options: {
      monitored: boolean;
      summaryTime: string | null;
      timezone?: string;
    }): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO groups (id, chat_id, name, monitored, timezone, summary_time)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          `${randomUUID()}@g.us`,
          "Scheduler Group",
          options.monitored,
          options.timezone ?? "Europe/Madrid",
          options.summaryTime,
        ],
      );
      return id;
    }

    function makeScheduler(
      defaultSummaryTime = "09:00",
      backfillDays = 1,
    ): Scheduler {
      return new Scheduler({
        store,
        enqueue: enqueuer,
        defaultCutoffMinutes: parseSummaryTime(defaultSummaryTime),
        now: () => NOW.getTime(),
        // Default 1 = fast-path tests (previous day only); the backfill
        // test opts into a deeper window explicitly.
        backfillDays,
        log: () => {},
      });
    }

    async function readRuns(groupId: string): Promise<RunRow[]> {
      const result = await pool.query<RunRow>(
        "SELECT id, group_id, kind, status, start_at, end_at, timezone " +
          "FROM summary_runs WHERE group_id = $1 ORDER BY created_at",
        [groupId],
      );
      return result.rows;
    }

    it("a due group produces exactly one scheduled run for the previous-day window", async () => {
      const groupId = await seedGroup({
        monitored: true,
        summaryTime: "09:00",
      });

      const created = await makeScheduler().runOnce();
      expect(created).toHaveLength(1);

      const runs = await readRuns(groupId);
      expect(runs).toHaveLength(1);
      const run = runs[0];
      if (run === undefined) throw new Error("no run row");
      expect(run.kind).toBe("scheduled");
      expect(run.status).toBe("pending");
      // The persisted window is the D5 previous-day window as instants.
      expect(new Date(run.start_at).toISOString()).toBe(EXPECTED_WINDOW.start);
      expect(new Date(run.end_at).toISOString()).toBe(EXPECTED_WINDOW.end);
      expect(run.timezone).toBe("Europe/Madrid");
      // The created run was handed to the queue (identifier only).
      expect(enqueuer.enqueued).toEqual([run.id]);
    });

    it("repeated passes never duplicate (create-or-find idempotency)", async () => {
      const groupId = await seedGroup({
        monitored: true,
        summaryTime: "09:00",
      });

      const scheduler = makeScheduler();
      const first = await scheduler.runOnce();
      expect(first).toHaveLength(1);

      // Ticks across the day (and after a restart) must be no-ops.
      expect(await scheduler.runOnce()).toEqual([]);
      expect(await scheduler.runOnce()).toEqual([]);
      expect(await readRuns(groupId)).toHaveLength(1);
      expect(enqueuer.enqueued).toHaveLength(1);

      // Even a COMPLETED run is never replaced: the scheduler never
      // overruns a window (regeneration stays an open decision).
      await pool.query(
        "UPDATE summary_runs SET status = 'completed' WHERE group_id = $1",
        [groupId],
      );
      expect(await scheduler.runOnce()).toEqual([]);
      expect(await readRuns(groupId)).toHaveLength(1);
    });

    it("an unmonitored group is never scheduled", async () => {
      const groupId = await seedGroup({
        monitored: false,
        summaryTime: "09:00",
      });

      expect(await makeScheduler().runOnce()).toEqual([]);
      expect(await readRuns(groupId)).toEqual([]);
      expect(enqueuer.enqueued).toEqual([]);
    });

    it("summary_time overrides the install default; NULL uses it", async () => {
      // NOW is 11:00 local. Install default here: 07:00 (reached).
      const overrideEvening = await seedGroup({
        monitored: true,
        summaryTime: "18:00", // NOT reached: overrides the reached default
      });
      const usesDefault = await seedGroup({
        monitored: true,
        summaryTime: null, // default 07:00 -> reached -> due
      });

      const created = await makeScheduler("07:00").runOnce();
      expect(created).toHaveLength(1);
      expect(await readRuns(overrideEvening)).toEqual([]);
      expect(await readRuns(usesDefault)).toHaveLength(1);

      // And the mirror image: unreached default, reached override.
      const overrideMorning = await seedGroup({
        monitored: true,
        summaryTime: "08:00", // reached: overrides the unreached default
      });
      const usesEveningDefault = await seedGroup({
        monitored: true,
        summaryTime: null, // default 18:00 -> NOT reached
      });

      const secondPass = await makeScheduler("18:00").runOnce();
      // Only the fresh groups are candidates (the first two already
      // have runs / are still not due).
      expect(secondPass).toHaveLength(1);
      expect(await readRuns(overrideMorning)).toHaveLength(1);
      expect(await readRuns(usesEveningDefault)).toEqual([]);
    });

    it("missed days within the backfill window are recovered on the next pass", async () => {
      // Review M1: a window whose day passed must not silently expire.
      // NOW is 11:00 CET on 2026-11-02 (DST ended 2026-10-25): the
      // previous 3 local days all start at 23:00Z of the prior date.
      const groupId = await seedGroup({
        monitored: true,
        summaryTime: "09:00",
      });
      const window = (startUtc: string, endUtc: string) => ({
        start: startUtc,
        end: endUtc,
        timezone: "Europe/Madrid",
      });
      const day1 = window("2026-10-31T23:00:00.000Z", "2026-11-01T23:00:00.000Z");
      const day2 = window("2026-10-30T23:00:00.000Z", "2026-10-31T23:00:00.000Z");
      const day3 = window("2026-10-29T23:00:00.000Z", "2026-10-30T23:00:00.000Z");

      // The backend ran on day 1 and day 3 but was down on day 2: the
      // day-2 window is the missed one and must be recovered.
      await store.createOrFindRun({
        groupId,
        interval: day1,
        kind: "scheduled",
      });
      await store.createOrFindRun({
        groupId,
        interval: day3,
        kind: "scheduled",
      });
      enqueuer.enqueued.length = 0;

      const created = await makeScheduler("09:00", 3).runOnce();
      expect(created).toHaveLength(1);

      const runs = await readRuns(groupId);
      expect(runs).toHaveLength(3);
      const recovered = runs.find(
        (row) =>
          new Date(row.start_at).toISOString() === day2.start &&
          new Date(row.end_at).toISOString() === day2.end,
      );
      expect(recovered).toBeDefined();
      expect(recovered?.kind).toBe("scheduled");
      expect(new Date(recovered?.start_at ?? 0).toISOString()).toBe(
        "2026-10-30T23:00:00.000Z",
      );
      // Only the recovered run was enqueued (the others pre-existed).
      expect(enqueuer.enqueued).toEqual([recovered?.id]);

      // And the next pass is a no-op: bounded backfill never duplicates.
      expect(await makeScheduler("09:00", 3).runOnce()).toEqual([]);
      expect(await readRuns(groupId)).toHaveLength(3);
    });
  },
);

/** A valid 32-byte key: PostgresStore needs one for provider-key crypto. */
function testEncryptionKey(): Buffer {
  return Buffer.alloc(32, 7);
}
