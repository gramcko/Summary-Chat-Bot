import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { ApiError, Group, GroupSummary, ProviderConfigPublic, Summary, type ConnectionStatus, type SummaryResult } from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import { decryptSecret, parseEncryptionKey } from "../src/lib/crypto.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { PostgresStore } from "../src/lib/postgres-store.js";
import { hashRecoveryCode } from "../src/lib/recovery-codes.js";
import {
  NoAdminError,
  resetAdminPassword,
} from "../src/lib/reset-password.js";
import { hashSessionToken, nowIso, type Store } from "../src/lib/store.js";
import { assertTestDatabaseName } from "../scripts/test-db-guard.js";
import {
  ADMIN_PASSWORD,
  NEW_PASSWORD,
  login,
  noopEnqueuer,
  setupAdmin,
} from "./helpers.js";

/**
 * PostgreSQL integration tests for PostgresStore.
 *
 * SAFETY (DEF-2): every test TRUNCATEs all application tables. NEVER
 * point DATABASE_URL at a database with real data — destructive setup
 * refuses to run unless the database name ends in `_test` or contains
 * `_e2e_` (or SUMMARLY_TEST_DB_CONFIRM=yes is set explicitly).
 *
 * Safe workflow: create a throwaway database and run the guarded entry
 * point (recommended — it fails fast instead of skipping):
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   createdb summarly_test
 *   DATABASE_URL=postgres://.../summarly_test npm run test:integration
 *
 * Without DATABASE_URL the suite is skipped and a loud warning is
 * printed; it is never silently omitted.
 */

// Loud skip (DEF-3): make an omitted integration run impossible to miss.
// process.stderr.write is used deliberately: vitest's reporter drops
// collection-time console output for skipped files.
if (!process.env["DATABASE_URL"]) {
  process.stderr.write(
    "[summarly] WARNING: PostgreSQL integration tests were SKIPPED " +
      "(DATABASE_URL is not set). Run them with `npm run test:integration` " +
      "(requires PostgreSQL — see docker-compose.dev.yml).\n",
  );
}

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

const RESULT: SummaryResult = {
  overview: "Integration test summary.",
  keyDiscussions: ["Testing persistence"],
  confirmedDecisions: [],
  proposals: [],
  unresolvedQuestions: [],
  tasks: [],
  links: [],
  aiGenerated: true,
};

const ENCRYPTION_KEY = parseEncryptionKey(
  Buffer.from("integration-tests-master-key-32b").toString("base64"),
);

async function seedGroupRow(store: Store): Promise<string> {
  const id = randomUUID();
  await store.upsertGroup({
    id,
    chatId: `${randomUUID()}@g.us`,
    name: "Integration Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
    historyImport: null,
  });
  return id;
}

describe.skipIf(!process.env["DATABASE_URL"])(
  "PostgresStore (PostgreSQL integration)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      const databaseUrl = process.env["DATABASE_URL"];
      if (databaseUrl === undefined) throw new Error("DATABASE_URL missing");
      pool = new Pool({ connectionString: databaseUrl });
      // DEF-2: refuse before ANY destructive statement when the target is
      // not unmistakably a throwaway test database.
      const result = await pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      assertTestDatabaseName(result.rows[0]?.name ?? "");
    });

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Test-database hygiene only; the dev database is disposable.
      await pool.query(
        "TRUNCATE TABLE summaries, summary_runs, messages, groups, " +
          "group_members, contact_overrides, admin_sessions, " +
          "admin_credentials, ai_provider_configs, " +
          "whatsapp_connections CASCADE",
      );
    });

    describe("createOrFindRun (ON CONFLICT run identity)", () => {
      it("creates once and finds the run on identical requests", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);

        const first = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        expect(first.created).toBe(true);
        expect(first.run.status).toBe("pending");
        expect(first.run.attempts).toBe(0);
        expect(first.run.groupId).toBe(groupId);
        expect(Date.parse(first.run.interval.start)).toBe(
          Date.parse(INTERVAL.start),
        );
        expect(Date.parse(first.run.interval.end)).toBe(
          Date.parse(INTERVAL.end),
        );
        expect(first.run.interval.timezone).toBe(INTERVAL.timezone);

        const second = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        expect(second.created).toBe(false);
        expect(second.run.id).toBe(first.run.id);
      });

      it("treats equivalent-instant spellings as the same run and keeps the first label", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const first = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        // Same instants as INTERVAL expressed with a +02:00 offset and a
        // different label: identity is instants, not spellings or labels.
        const equivalent = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-10-28T02:00:00+02:00",
            end: "2026-10-29T02:00:00+02:00",
            timezone: "America/Bogota",
          },
          kind: "manual",
        });
        expect(equivalent.created).toBe(false);
        expect(equivalent.run.id).toBe(first.run.id);
        expect(equivalent.run.interval.timezone).toBe("Europe/Madrid");
      });

      it("treats a different interval or kind as a different run", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        await store.createOrFindRun({ groupId, interval: INTERVAL, kind: "manual" });

        const nextDay = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-10-29T00:00:00Z",
            end: "2026-10-30T00:00:00Z",
            timezone: "Europe/Madrid",
          },
          kind: "manual",
        });
        expect(nextDay.created).toBe(true);

        const scheduled = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "scheduled",
        });
        expect(scheduled.created).toBe(true);
      });

      it("enforces run identity with a database constraint", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        await store.createOrFindRun({ groupId, interval: INTERVAL, kind: "manual" });

        await expect(
          pool.query(
            `INSERT INTO summary_runs (group_id, kind, status, start_at, end_at, timezone)
             VALUES ($1, $2, 'pending', $3, $4, $5)`,
            [
              groupId,
              "manual",
              new Date(INTERVAL.start),
              new Date(INTERVAL.end),
              "Europe/Madrid",
            ],
          ),
        ).rejects.toThrow();
      });
    });

    describe("run transitions", () => {
      it("persists retry transitions (pending -> failed -> pending)", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        const failed = await store.updateRun({
          ...run,
          status: "failed",
          attempts: 1,
          error: { code: "provider_rate_limit", message: "Rate limited" },
          updatedAt: nowIso(),
        });
        expect(failed.status).toBe("failed");
        expect(failed.attempts).toBe(1);
        expect(failed.error).toEqual({
          code: "provider_rate_limit",
          message: "Rate limited",
        });

        const fetched = await store.getRun(run.id);
        if (fetched === undefined) throw new Error("run not found");
        expect(fetched.status).toBe("failed");

        const retried = await store.updateRun({
          ...fetched,
          status: "pending",
          error: null,
          updatedAt: nowIso(),
        });
        expect(retried.status).toBe("pending");
        expect(retried.error).toBeNull();

        const list = await store.listRuns();
        expect(list.map((item) => item.id)).toEqual([run.id]);
      });
    });

    describe("provider key encryption", () => {
      it("round-trips the key, encrypts at rest, and masks it through the routes", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);
        const secret = "sk-integration-secret-do-not-leak";

        const put = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "test-model",
            baseUrl: "https://api.example.com/v1",
            apiKey: secret,
          },
        });
        expect(put.statusCode).toBe(200);
        expect(put.body).not.toContain(secret);
        expect(put.body).not.toContain("apiKey");

        const get = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        const config = ProviderConfigPublic.parse(get.json());
        expect(config.hasApiKey).toBe(true);
        expect(get.body).not.toContain(secret);
        expect(get.body).not.toContain("apiKey");

        // At rest: ciphertext envelope, never plaintext; decrypts back.
        const raw = await pool.query<{ api_key_encrypted: string | null }>(
          "SELECT api_key_encrypted FROM ai_provider_configs LIMIT 1",
        );
        const stored = raw.rows[0]?.api_key_encrypted ?? null;
        expect(stored).not.toBeNull();
        expect(stored).not.toContain(secret);
        expect(stored).toMatch(/^enc:v1:/);
        if (stored === null) throw new Error("missing api_key_encrypted");
        expect(decryptSecret(ENCRYPTION_KEY, stored)).toBe(secret);

        // Store-level round trip.
        const read = await store.getProviderConfig();
        if (read === null) throw new Error("provider config missing");
        expect(read.apiKey).toBe(secret);
      });

      it("keeps the saved key on omitted apiKey and clears it on explicit null", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        await store.setProviderConfig({
          provider: "openai-compatible",
          model: "v1",
          baseUrl: null,
          apiKey: "sk-old",
        });

        await store.setProviderConfig({
          provider: "openai-compatible",
          model: "v2",
          baseUrl: null,
          apiKey: null,
        });
        const cleared = await store.getProviderConfig();
        if (cleared === null) throw new Error("provider config missing");
        expect(cleared.model).toBe("v2");
        expect(cleared.apiKey).toBeNull();

        const raw = await pool.query<{ api_key_encrypted: string | null }>(
          "SELECT api_key_encrypted FROM ai_provider_configs LIMIT 1",
        );
        expect(raw.rows[0]?.api_key_encrypted ?? null).toBeNull();
      });

      it("fails decryption with a tampered or foreign-key value", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        await store.setProviderConfig({
          provider: "mock",
          model: "mock-1",
          baseUrl: null,
          apiKey: "sk-secret",
        });
        await pool.query(
          "UPDATE ai_provider_configs SET api_key_encrypted = $1",
          ["enc:v1:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUE="],
        );
        await expect(store.getProviderConfig()).rejects.toThrow();
      });
    });

    describe("sessions", () => {
      it("stores only token hashes and enforces the session lifecycle", async () => {
        const store = new PostgresStore(pool);
        const token = randomBytes(32).toString("hex");

        expect(await store.validateSession(token)).toBe(false);
        await store.createSession(token);
        expect(await store.validateSession(token)).toBe(true);

        const rows = await pool.query<{ token_hash: string }>(
          "SELECT token_hash FROM admin_sessions",
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.token_hash).not.toBe(token);
        expect(rows.rows[0]?.token_hash).toBe(hashSessionToken(token));

        await store.deleteSession(token);
        expect(await store.validateSession(token)).toBe(false);

        await store.createSession("token-one");
        await store.createSession("token-two");
        await store.clearSessions();
        expect(await store.validateSession("token-one")).toBe(false);
        expect(await store.validateSession("token-two")).toBe(false);
      });
    });

    describe("reset-password helper", () => {
      it("sets a new password, clears sessions, and the new password works", async () => {
        const store = new PostgresStore(pool);
        await store.setAdmin({
          passwordHash: hashPassword(ADMIN_PASSWORD),
          recoveryCodeHashes: new Set([hashRecoveryCode("0000-0000-0000")]),
        });
        await store.createSession("stale-session");

        const codes = await resetAdminPassword(store, NEW_PASSWORD);
        expect(codes).toHaveLength(10);

        const admin = await store.getAdmin();
        if (admin === null) throw new Error("admin missing after reset");
        expect(verifyPassword(NEW_PASSWORD, admin.passwordHash)).toBe(true);
        expect(verifyPassword(ADMIN_PASSWORD, admin.passwordHash)).toBe(false);
        expect(await store.validateSession("stale-session")).toBe(false);

        // End to end: the API accepts the new password.
        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: NEW_PASSWORD },
        });
        expect(res.statusCode).toBe(200);
      });

      it("throws NoAdminError before setup", async () => {
        const store = new PostgresStore(pool);
        await expect(resetAdminPassword(store, NEW_PASSWORD)).rejects.toBeInstanceOf(
          NoAdminError,
        );
      });
    });

    describe("summaries and connection status", () => {
      it("saves summaries idempotently per run and serves them by run id", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        const first = await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: nowIso(),
        });
        // A repeated write for the same run keeps the first identity.
        const again = await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: nowIso(),
        });
        expect(again.id).toBe(first.id);

        const byRun = await store.getSummaryByRunId(run.id);
        if (byRun === undefined) throw new Error("summary missing");
        expect(byRun.id).toBe(first.id);
        expect(Summary.parse(byRun).result).toEqual(RESULT);

        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);
        const res = await app.inject({
          method: "GET",
          url: `/api/summary-runs/${run.id}/summary`,
          headers: { cookie: session },
        });
        expect(res.statusCode).toBe(200);
        expect(Summary.parse(res.json()).runId).toBe(run.id);
      });

      it("round-trips the connection status", async () => {
        const store = new PostgresStore(pool);
        expect((await store.getConnectionStatus()).state).toBe("unavailable");

        const since = nowIso();
        await store.setConnectionStatus({
          state: "connected",
          since,
          lastMessageAt: since,
          linking: null,
          check: null,
        });
        const status = await store.getConnectionStatus();
        expect(status.state).toBe("connected");
        expect(Date.parse(status.since)).toBe(Date.parse(since));
        expect(
          status.lastMessageAt === null
            ? null
            : Date.parse(status.lastMessageAt),
        ).toBe(Date.parse(since));
      });
    });

    describe("group registration (chat natural key)", () => {
      it("keeps the stored id and NEVER clobbers admin preferences (never-clobber)", async () => {
        const store = new PostgresStore(pool);
        const chatId = "123456789012345678@g.us";
        const first = await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "First name",
          monitored: false,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        // The admin opts in and configures the group — updateGroup is
        // the only admin-preference writer (ADR 0004 / audit M3).
        await store.updateGroup({
          ...first,
          monitored: true,
          timezone: "America/Bogota",
          summaryTime: "06:30",
        });

        // A re-registration (discovery / subject rename) with DIFFERENT
        // preference values must update ONLY the name.
        const again = await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Renamed",
          monitored: false,
          timezone: "Europe/Madrid",
          summaryTime: "23:00",
          historyImport: null,
        });
        expect(again.id).toBe(first.id);
        expect(again.name).toBe("Renamed");
        expect(again.monitored).toBe(true);
        expect(again.timezone).toBe("America/Bogota");
        expect(again.summaryTime).toBe("06:30");

        const rows = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM groups WHERE chat_id = $1",
          [chatId],
        );
        expect(rows.rows[0]?.count).toBe("1");
      });

      it("falls back to the id when no chat id is provided", async () => {
        const store = new PostgresStore(pool);
        const id = randomUUID();
        await store.upsertGroup({
          id,
          chatId: null,
          name: "First name",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        const updated = await store.upsertGroup({
          id,
          chatId: null,
          name: "Second name",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        expect(updated.id).toBe(id);
        expect(updated.name).toBe("Second name");
        expect(await store.listGroups()).toHaveLength(1);
      });

      it("enforces chat uniqueness in the database", async () => {
        const store = new PostgresStore(pool);
        const chatId = "duplicate-chat@g.us";
        await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Original",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        await expect(
          pool.query(
            "INSERT INTO groups (id, chat_id, name, monitored, timezone) VALUES ($1, $2, $3, true, 'Europe/Madrid')",
            [randomUUID(), chatId, "Duplicate"],
          ),
        ).rejects.toThrow();
      });
    });

    describe("write validation", () => {
      it("rejects a summary whose result violates the contract", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        const invalid = {
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: { overview: "" },
          createdAt: nowIso(),
        } as unknown as Summary;
        await expect(store.saveSummary(invalid)).rejects.toThrow();
        expect(await store.getSummaryByRunId(run.id)).toBeUndefined();
      });

      it("rejects an invalid connection status", async () => {
        const store = new PostgresStore(pool);
        const invalid = {
          state: "bogus",
          since: nowIso(),
          lastMessageAt: null,
        } as unknown as ConnectionStatus;
        await expect(store.setConnectionStatus(invalid)).rejects.toThrow();
      });
    });

    describe("setAdmin insert-only (setup race)", () => {
      it("lets exactly one of two concurrent setAdmin calls win", async () => {
        const store = new PostgresStore(pool);
        const results = await Promise.all([
          store.setAdmin({
            passwordHash: hashPassword(ADMIN_PASSWORD),
            recoveryCodeHashes: new Set(),
          }),
          store.setAdmin({
            passwordHash: hashPassword(NEW_PASSWORD),
            recoveryCodeHashes: new Set(),
          }),
        ]);
        expect(results.filter((created) => created)).toHaveLength(1);
      });
    });

    describe("settings with a tampered saved key", () => {
      it("surfaces a clear conflict and lets a fully-specified PUT recover", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);

        const put = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "v1",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-original",
          },
        });
        expect(put.statusCode).toBe(200);

        // Corrupt the stored ciphertext (tamper or key rotation).
        await pool.query(
          "UPDATE ai_provider_configs SET api_key_encrypted = $1",
          ["enc:v1:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUE="],
        );

        const get = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        expect(get.statusCode).toBe(409);
        expect(ApiError.parse(get.json()).error.message).toMatch(/unreadable/i);
        expect(get.body).not.toContain("sk-");

        // A PUT that still needs the old key reports the same conflict.
        const keep = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: { provider: "openai-compatible", model: "v2" },
        });
        expect(keep.statusCode).toBe(409);

        // A fully-specified PUT replaces the broken key without reading it.
        const replace = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "v2",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-new-secret",
          },
        });
        expect(replace.statusCode).toBe(200);
        expect(ProviderConfigPublic.parse(replace.json()).hasApiKey).toBe(true);

        const after = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        expect(after.statusCode).toBe(200);
        expect(after.body).not.toContain("sk-new-secret");
      });
    });

    describe("history import (system-managed columns, ADR 0007)", () => {
      async function importRow(groupId: string) {
        const result = await pool.query<{
          history_import_status: string | null;
          history_import_requested_at: Date | null;
          history_import_started_at: Date | null;
          history_import_finished_at: Date | null;
          history_import_imported_count: number;
          history_import_error: string | null;
        }>(
          "SELECT history_import_status, history_import_requested_at, " +
            "history_import_started_at, history_import_finished_at, " +
            "history_import_imported_count, history_import_error " +
            "FROM groups WHERE id = $1",
          [groupId],
        );
        return result.rows[0];
      }

      it("a request transitions the SQL row to pending with zeroed progress", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);

        const requested = await store.requestHistoryImport(groupId);
        expect(requested?.changed).toBe(true); // this call did it
        expect(requested?.group.historyImport?.status).toBe("pending");

        const row = await importRow(groupId);
        expect(row?.history_import_status).toBe("pending");
        expect(row?.history_import_requested_at).toBeInstanceOf(Date);
        expect(row?.history_import_started_at).toBeNull();
        expect(row?.history_import_finished_at).toBeNull();
        expect(row?.history_import_imported_count).toBe(0);
        expect(row?.history_import_error).toBeNull();

        // Unknown groups report undefined (the route turns that into 404).
        expect(await store.requestHistoryImport(randomUUID())).toBeUndefined();
      });

      it("is a no-op while pending/running and re-accepted after done", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);

        await store.requestHistoryImport(groupId);
        const pendingRow = await importRow(groupId);

        // Running in flight: still a no-op (and does not even bump
        // requested_at).
        await pool.query(
          "UPDATE groups SET history_import_status = 'running', " +
            "history_import_started_at = now(), " +
            "history_import_imported_count = 5 WHERE id = $1",
          [groupId],
        );
        const whileRunning = await store.requestHistoryImport(groupId);
        expect(whileRunning?.changed).toBe(false); // nothing transitioned
        expect(whileRunning?.group.historyImport?.status).toBe("running");
        expect(whileRunning?.group.historyImport?.importedCount).toBe(5);
        expect(
          (await importRow(groupId))?.history_import_requested_at?.toISOString(),
        ).toBe(pendingRow?.history_import_requested_at?.toISOString());

        // After done: a NEW request is accepted and resets everything.
        await pool.query(
          "UPDATE groups SET history_import_status = 'done', " +
            "history_import_finished_at = now(), " +
            "history_import_imported_count = 55, " +
            "history_import_error = NULL WHERE id = $1",
          [groupId],
        );
        const reRequested = await store.requestHistoryImport(groupId);
        expect(reRequested?.changed).toBe(true);
        expect(reRequested?.group.historyImport?.status).toBe("pending");
        const resetRow = await importRow(groupId);
        expect(resetRow?.history_import_status).toBe("pending");
        expect(resetRow?.history_import_started_at).toBeNull();
        expect(resetRow?.history_import_finished_at).toBeNull();
        expect(resetRow?.history_import_imported_count).toBe(0);
      });

      it("updateGroup and discovery upsert never reset an import", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const chatId = `${randomUUID()}@g.us`;
        const id = randomUUID();
        await store.upsertGroup({
          id,
          chatId,
          name: "Import Group",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        const requested = await store.requestHistoryImport(id);

        // Admin prefs change (the only writer of mutable fields).
        await store.updateGroup({
          ...(requested as NonNullable<typeof requested>).group,
          timezone: "America/Bogota",
          summaryTime: "06:30",
        });
        expect((await importRow(id))?.history_import_status).toBe("pending");

        // Discovery re-registration (chat-keyed): name only.
        const renamed = await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Renamed",
          monitored: false,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        expect(renamed.id).toBe(id);
        expect(renamed.historyImport).toEqual(requested?.group.historyImport);

        // The id-keyed replace path also preserves the columns.
        await store.upsertGroup({
          id,
          chatId,
          name: "Replaced",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        expect((await importRow(id))?.history_import_status).toBe("pending");
      });

      it("routes: 404 unknown, 409 unmonitored, 202 accepted, 200 in flight", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);

        // 404: unknown group.
        const unknown = await app.inject({
          method: "POST",
          url: `/api/groups/${randomUUID()}/history-import`,
          headers: { cookie: session },
        });
        expect(unknown.statusCode).toBe(404);

        // 409: not monitored (privacy boundary).
        const groupId = await seedGroupRow(store);
        await store.updateGroup({
          ...(await store.getGroup(groupId))!,
          monitored: false,
        });
        const unmonitored = await app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/history-import`,
          headers: { cookie: session },
        });
        expect(unmonitored.statusCode).toBe(409);
        expect(ApiError.parse(unmonitored.json()).error.message).toBe(
          "Group must be monitored before importing history.",
        );

        // 202: accepted — and the SQL row proves the transition. (The
        // admin opts the group back into monitoring first.)
        await store.updateGroup({
          ...(await store.getGroup(groupId))!,
          monitored: true,
        });
        const accepted = await app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/history-import`,
          headers: { cookie: session },
        });
        expect(accepted.statusCode).toBe(202);
        expect(Group.parse(accepted.json()).historyImport?.status).toBe(
          "pending",
        );
        expect((await importRow(groupId))?.history_import_status).toBe(
          "pending",
        );

        // 200: already in flight — idempotent, unchanged.
        const again = await app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/history-import`,
          headers: { cookie: session },
        });
        expect(again.statusCode).toBe(200);
        expect(Group.parse(again.json()).historyImport).toEqual(
          Group.parse(accepted.json()).historyImport,
        );
      });

      it("cancelPendingHistoryImport clears PENDING rows in SQL and nothing else (SA-M1)", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const pendingId = await seedGroupRow(store);
        await store.requestHistoryImport(pendingId);

        // Pending -> cleared atomically; every column resets.
        expect(await store.cancelPendingHistoryImport(pendingId)).toBe(true);
        const cleared = await importRow(pendingId);
        expect(cleared?.history_import_status).toBeNull();
        expect(cleared?.history_import_requested_at).toBeNull();
        expect(cleared?.history_import_started_at).toBeNull();
        expect(cleared?.history_import_finished_at).toBeNull();
        expect(cleared?.history_import_imported_count).toBe(0);
        expect(cleared?.history_import_error).toBeNull();
        // Idempotent: nothing left to cancel.
        expect(await store.cancelPendingHistoryImport(pendingId)).toBe(false);

        // Running -> NOT touched (the bot-worker aborts its own work).
        const runningId = await seedGroupRow(store);
        await store.requestHistoryImport(runningId);
        await pool.query(
          "UPDATE groups SET history_import_status = 'running', " +
            "history_import_started_at = now(), " +
            "history_import_imported_count = 2 WHERE id = $1",
          [runningId],
        );
        expect(await store.cancelPendingHistoryImport(runningId)).toBe(false);
        const running = await importRow(runningId);
        expect(running?.history_import_status).toBe("running");
        expect(running?.history_import_imported_count).toBe(2);

        // Un-monitoring mid-flight wires the same rule through PATCH:
        // pending dies, running survives.
        const wiredId = await seedGroupRow(store);
        await store.requestHistoryImport(wiredId);
        await store.updateGroup({
          ...(await store.getGroup(wiredId))!,
          monitored: false,
        });
        await store.cancelPendingHistoryImport(wiredId);
        expect((await importRow(wiredId))?.history_import_status).toBeNull();
      });
    });

    describe("roster sync request (migration 0016)", () => {
      async function rosterRequestedAt(groupId: string): Promise<Date | null> {
        const result = await pool.query<{
          roster_sync_requested_at: Date | null;
        }>("SELECT roster_sync_requested_at FROM groups WHERE id = $1", [
          groupId,
        ]);
        return result.rows[0]?.roster_sync_requested_at ?? null;
      }

      it("records a request for a MONITORED group only", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        expect(await rosterRequestedAt(groupId)).toBeNull();

        await store.requestGroupRosterSync(groupId);
        expect(await rosterRequestedAt(groupId)).toBeInstanceOf(Date);

        // Un-monitored: the SQL WHERE clause refuses the write, so
        // un-monitoring also revokes a pending request.
        await store.updateGroup({
          ...(await store.getGroup(groupId))!,
          monitored: false,
        });
        await pool.query(
          "UPDATE groups SET roster_sync_requested_at = NULL WHERE id = $1",
          [groupId],
        );
        await store.requestGroupRosterSync(groupId);
        expect(await rosterRequestedAt(groupId)).toBeNull();

        // Unknown id: silent no-op (the route answers 404 before this).
        await expect(
          store.requestGroupRosterSync(randomUUID()),
        ).resolves.toBeUndefined();
      });

      it("PATCH enabling monitoring records the request; the route 202s", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          enqueue: noopEnqueuer,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);
        const groupId = await seedGroupRow(store);
        await store.updateGroup({
          ...(await store.getGroup(groupId))!,
          monitored: false,
        });
        expect(await rosterRequestedAt(groupId)).toBeNull();

        // 409 before monitoring.
        const refused = await app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/roster-sync`,
          headers: { cookie: session },
        });
        expect(refused.statusCode).toBe(409);

        // PATCH unmonitored -> monitored requests a sync automatically.
        const patched = await app.inject({
          method: "PATCH",
          url: `/api/groups/${groupId}`,
          headers: { cookie: session },
          payload: { monitored: true },
        });
        expect(patched.statusCode).toBe(200);
        expect(await rosterRequestedAt(groupId)).toBeInstanceOf(Date);

        // The manual refresh path answers 202 and keeps a request.
        await pool.query(
          "UPDATE groups SET roster_sync_requested_at = NULL WHERE id = $1",
          [groupId],
        );
        const accepted = await app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/roster-sync`,
          headers: { cookie: session },
        });
        expect(accepted.statusCode).toBe(202);
        expect(accepted.json()).toEqual({ ok: true });
        expect(await rosterRequestedAt(groupId)).toBeInstanceOf(Date);
      });
    });

    describe("product upgrade surfaces (ADR 0008)", () => {
      it("persists run instructions (first request wins on create-or-find)", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const interval = {
          start: "2026-11-01T00:00:00.000Z",
          end: "2026-11-02T00:00:00.000Z",
          timezone: "Europe/Madrid",
        };
        const first = await store.createOrFindRun({
          groupId,
          interval,
          kind: "manual",
          instructions: "Focus on decisions.",
        });
        expect(first.run.instructions).toBe("Focus on decisions.");
        const row = await pool.query<{ instructions: string | null }>(
          "SELECT instructions FROM summary_runs WHERE id = $1",
          [first.run.id],
        );
        expect(row.rows[0]?.instructions).toBe("Focus on decisions.");

        // Identity excludes instructions: the repeat keeps the first.
        const repeat = await store.createOrFindRun({
          groupId,
          interval,
          kind: "manual",
          instructions: "Different instructions.",
        });
        expect(repeat.created).toBe(false);
        expect(repeat.run.instructions).toBe("Focus on decisions.");

        // No instructions -> NULL.
        const other = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-11-02T00:00:00.000Z",
            end: "2026-11-03T00:00:00.000Z",
            timezone: "Europe/Madrid",
          },
          kind: "manual",
        });
        expect(other.run.instructions).toBeNull();
      });

      it("stores connection linking and the logout request (SQL semantics)", async () => {
        const store = new PostgresStore(pool);
        await store.setConnectionStatus({
          state: "disconnected",
          since: nowIso(),
          lastMessageAt: null,
          linking: null,
          check: null,
        });

        // Linking appears while valid (and in a linking state) and hides
        // when expired, cleared, or the session is CONNECTED (M-4).
        await store.updateConnectionLinking({
          qr: "2@abc123pairingpayload",
          expiresAt: "2100-01-01T00:00:00.000Z",
        });
        expect((await store.getConnectionStatus()).linking).toEqual({
          kind: "qr", // default for QR payloads
          qr: "2@abc123pairingpayload",
          expiresAt: "2100-01-01T00:00:00.000Z",
        });
        // The published kind is stored and served (migration 0005).
        await store.updateConnectionLinking({
          kind: "pairing-code",
          qr: "12345678",
          expiresAt: "2100-01-01T00:00:00.000Z",
        });
        expect((await store.getConnectionStatus()).linking).toEqual({
          kind: "pairing-code",
          qr: "12345678",
          expiresAt: "2100-01-01T00:00:00.000Z",
        });
        // M-4: a valid payload is NOT served once connected (or in any
        // non-linking state).
        await store.setConnectionStatus({
          state: "connected",
          since: nowIso(),
          lastMessageAt: null,
          linking: null,
          check: null,
        });
        expect((await store.getConnectionStatus()).linking).toBeNull();
        await store.setConnectionStatus({
          state: "disconnected",
          since: nowIso(),
          lastMessageAt: null,
          linking: null,
          check: null,
        });
        await store.updateConnectionLinking({
          qr: "2@expired",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
        expect((await store.getConnectionStatus()).linking).toBeNull();
        await store.updateConnectionLinking(null);

        // requestLogout is idempotent: the first timestamp survives.
        await store.requestLogout();
        const first = await pool.query<{ logout_requested_at: Date }>(
          "SELECT logout_requested_at FROM whatsapp_connections",
        );
        await store.requestLogout();
        const second = await pool.query<{ logout_requested_at: Date }>(
          "SELECT logout_requested_at FROM whatsapp_connections",
        );
        expect(second.rows[0]?.logout_requested_at.toISOString()).toBe(
          first.rows[0]?.logout_requested_at.toISOString(),
        );

        // clearLogoutRequest is the bot-worker's consume path.
        await store.clearLogoutRequest();
        expect(
          (
            await store.getConnectionStatus()
          ),
        ).toBeDefined();
        const cleared = await pool.query<{ logout_requested_at: Date | null }>(
          "SELECT logout_requested_at FROM whatsapp_connections",
        );
        expect(cleared.rows[0]?.logout_requested_at).toBeNull();

        // requestSessionReset records a LOCAL reset request (migration
        // 0014), idempotently, without touching the logout flag.
        await store.requestSessionReset();
        const resetFirst = await pool.query<{
          session_reset_requested_at: Date | null;
          logout_requested_at: Date | null;
        }>(
          "SELECT session_reset_requested_at, logout_requested_at " +
            "FROM whatsapp_connections",
        );
        expect(resetFirst.rows[0]?.session_reset_requested_at).toBeInstanceOf(
          Date,
        );
        expect(resetFirst.rows[0]?.logout_requested_at).toBeNull();
        await store.requestSessionReset();
        const resetSecond = await pool.query<{
          session_reset_requested_at: Date | null;
        }>(
          "SELECT session_reset_requested_at FROM whatsapp_connections",
        );
        expect(
          resetSecond.rows[0]?.session_reset_requested_at?.toISOString(),
        ).toBe(resetFirst.rows[0]?.session_reset_requested_at?.toISOString());
        // Never part of the public connection status.
        expect(
          JSON.stringify(await store.getConnectionStatus()),
        ).not.toContain("reset");
      });

      it("upserts and lists group members (roster refresh)", async () => {
        const store = new PostgresStore(pool);
        const chatId = `${randomUUID()}@g.us`;
        await store.upsertGroupMembers(chatId, [
          {
            userId: "2@s.whatsapp.net",
            name: "Bo",
            phone: "2@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
          {
            userId: "1@s.whatsapp.net",
            name: "Ana",
            phone: "1@s.whatsapp.net",
            isAdmin: true,
            active: true,
          },
          {
            userId: "3@lid",
            name: null,
            phone: "3@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
        ]);
        const members = await store.listGroupMembers(chatId);
        expect(members.map((member) => member.userId)).toEqual([
          "1@s.whatsapp.net",
          "2@s.whatsapp.net",
          "3@lid", // NULL name sorts LAST (mirrors SQL)
        ]);
        expect(members[2]?.phone).toBe("3@s.whatsapp.net");

        // Refresh updates in place (same chat_id + user_id).
        await store.upsertGroupMembers(chatId, [
          {
            userId: "2@s.whatsapp.net",
            name: "Bo (renamed)",
            phone: null,
            isAdmin: true,
            active: false,
          },
        ]);
        const refreshed = await store.listGroupMembers(chatId);
        expect(refreshed).toHaveLength(3);
        const bo = refreshed.find((member) => member.userId === "2@s.whatsapp.net");
        expect(bo?.name).toBe("Bo (renamed)");
        expect(bo?.phone).toBe("2@s.whatsapp.net"); // COALESCE keeps it
        expect(bo?.isAdmin).toBe(true);
        expect(bo?.active).toBe(false);

        // COALESCE name semantics (fix round A, m9): a refresh WITHOUT a
        // display name must not wipe a known one.
        await store.upsertGroupMembers(chatId, [
          {
            userId: "2@s.whatsapp.net",
            name: null,
            phone: null,
            isAdmin: false,
            active: true,
          },
        ]);
        const coalesced = await store.listGroupMembers(chatId);
        expect(
          coalesced.find((member) => member.userId === "2@s.whatsapp.net")?.name,
        ).toBe("Bo (renamed)");
      });

      it("aggregates contacts from monitored groups and resolves their messages", async () => {
        const store = new PostgresStore(pool);
        const chatA = `${randomUUID()}@g.us`;
        const chatB = `${randomUUID()}@g.us`;
        const groupA = randomUUID();
        const groupB = randomUUID();
        await store.upsertGroup({
          id: groupA,
          chatId: chatA,
          name: "Monitored A",
          monitored: true,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroup({
          id: groupB,
          chatId: chatB,
          name: "Private B",
          monitored: false,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroupMembers(chatA, [
          {
            userId: "111@lid",
            name: "Ana",
            phone: "111@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
          {
            userId: "222@lid",
            name: "Bob",
            phone: null,
            isAdmin: false,
            active: true,
          },
        ]);
        await store.upsertGroupMembers(chatB, [
          {
            userId: "333@lid",
            name: "Eve",
            phone: null,
            isAdmin: false,
            active: true,
          },
        ]);

        const connectionId = randomUUID();
        await pool.query(
          "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
          [connectionId],
        );
        const insertMessage = async (
          chatId: string,
          senderId: string,
          sentAt: string,
        ) => {
          await pool.query(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             VALUES ($1, $2, $3, $4, NULL, $5, 'hello')`,
            [connectionId, chatId, `wa-${randomUUID()}`, senderId, new Date(sentAt)],
          );
        };
        await insertMessage(chatA, "111:4@s.whatsapp.net", "2026-11-01T10:00:00Z");
        await insertMessage(chatA, "222@lid", "2026-11-01T11:00:00Z");
        await insertMessage(chatB, "333@lid", "2026-11-01T12:00:00Z");

        const contacts = await store.listContacts();
        expect(contacts.map((contact) => contact.name)).toEqual(["Ana", "Bob"]);
        const ana = contacts.find((contact) => contact.name === "Ana");
        expect(ana?.id).toBe("111@s.whatsapp.net");
        expect(ana?.groups.map((group) => group.name)).toEqual(["Monitored A"]);
        expect(ana?.messageCount).toBe(1);

        const detail = await store.getContact("111@s.whatsapp.net");
        expect(detail?.aliases).toEqual(["111@lid", "111@s.whatsapp.net"]);
        const page = await store.listContactMessages(detail?.aliases ?? [], {
          limit: 50,
        });
        expect(page).toHaveLength(1);
        expect(page[0]?.groupName).toBe("Monitored A");
        expect(page[0]?.senderName).toBe("Ana"); // roster fallback
        expect(page[0]?.senderId).toBe("111:4@s.whatsapp.net");

        // Admin override wins in the contact list, detail, and messages.
        const renamed = await store.renameContact(
          "111@s.whatsapp.net",
          "Ana Renamed",
        );
        expect(renamed?.name).toBe("Ana Renamed");
        const afterRename = await store.listContacts();
        expect(
          afterRename.find((contact) => contact.id === "111@s.whatsapp.net")?.name,
        ).toBe("Ana Renamed");
        const renamedMessages = await store.listContactMessages(
          detail?.aliases ?? [],
          { limit: 50 },
        );
        expect(renamedMessages[0]?.senderName).toBe("Ana Renamed");

        // Unmonitored groups contribute neither contacts nor messages.
        expect(contacts.some((contact) => contact.name === "Eve")).toBe(false);
        expect(await store.getContact("333@lid")).toBeUndefined();
      });

      it("lists chat messages newest-first with sender names, range, and cursor", async () => {
        const store = new PostgresStore(pool);
        const chatId = `${randomUUID()}@g.us`;
        await pool.query(
          `INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')`,
          [randomUUID()],
        );
        const insert = (
          id: string,
          sentAt: string,
          body: string,
          senderName: string | null,
        ) =>
          pool.query(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             SELECT id, $1, $2, 'user@s.whatsapp.net', $3, $4, $5
             FROM whatsapp_connections LIMIT 1`,
            [chatId, `wa-${id}`, senderName, new Date(sentAt), body],
          );
        const idA = randomUUID();
        const idB = randomUUID();
        const idC = randomUUID();
        await insert(idA, "2026-11-01T09:00:00Z", "early", "Ana");
        await insert(idB, "2026-11-01T10:00:00Z", "middle", null);
        await insert(idC, "2026-11-01T11:00:00Z", "late", "Cid");

        const page1 = await store.listGroupMessages(chatId, {
          limit: 2,
        });
        expect(page1.map((message) => message.body)).toEqual(["late", "middle"]);
        expect(page1[0]?.senderName).toBe("Cid");
        expect(page1[1]?.senderName).toBeNull();
        expect(page1[0]?.chatId).toBeUndefined();

        const page2 = await store.listGroupMessages(chatId, {
          limit: 2,
          cursor: `${page1[1]?.sentAt}|${page1[1]?.id}`,
        });
        expect(page2.map((message) => message.body)).toEqual(["early"]);

        // A malformed cursor (non-UUID id) is a clean store error, never
        // a `::uuid` cast failure (fix round A, audit L-4). The route
        // validates first and answers 400; this is the backstop.
        await expect(
          store.listGroupMessages(chatId, {
            limit: 2,
            cursor: "2026-11-01T10:00:00.000Z|not-a-uuid",
          }),
        ).rejects.toThrow(/invalid message cursor/);

        // Half-open [from, to).
        const ranged = await store.listGroupMessages(chatId, {
          from: "2026-11-01T09:00:00Z",
          to: "2026-11-01T11:00:00Z",
          limit: 50,
        });
        expect(ranged.map((message) => message.body)).toEqual([
          "middle",
          "early",
        ]);
      });

      it("resolves display names from overrides, then roster names, then push names", async () => {
        const store = new PostgresStore(pool);
        const chatId = `${randomUUID()}@g.us`;
        await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Names Group",
          monitored: true,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroupMembers(chatId, [
          {
            userId: "111@lid",
            name: "Ana Roster",
            phone: "111@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
          // Roster row without a name: Baileys metadata carries only JIDs.
          {
            userId: "222@lid",
            name: null,
            phone: "222@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
          // Nothing known at all: the name stays NULL.
          {
            userId: "333@lid",
            name: null,
            phone: null,
            isAdmin: false,
            active: true,
          },
        ]);
        const connectionId = randomUUID();
        await pool.query(
          "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
          [connectionId],
        );
        const insertMessage = async (
          senderId: string,
          senderName: string | null,
          sentAt: string,
        ) => {
          await pool.query(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             VALUES ($1, $2, $3, $4, $5, $6, 'hello')`,
            [
              connectionId,
              chatId,
              `wa-${randomUUID()}`,
              senderId,
              senderName,
              new Date(sentAt),
            ],
          );
        };
        await insertMessage("111:4@s.whatsapp.net", "Ana Push", "2026-11-01T10:00:00Z");
        await insertMessage("222:1@s.whatsapp.net", "Bea Old", "2026-11-01T09:00:00Z");
        await insertMessage("222:2@s.whatsapp.net", "Bea Newest", "2026-11-01T11:00:00Z");
        await insertMessage("333@lid", "Cid Push", "2026-11-01T08:00:00Z");

        // Before the rename: roster name > message push name, and a
        // nameless member falls back to its newest push name.
        expect(
          (await store.listGroupMembers(chatId)).map((member) => [
            member.userId,
            member.name,
          ]),
        ).toEqual([
          ["111@lid", "Ana Roster"],
          ["222@lid", "Bea Newest"],
          ["333@lid", "Cid Push"],
        ]);

        await store.renameContact("111@s.whatsapp.net", "Ana Renamed");

        // Members tab: override > roster name > newest push name.
        expect(
          (await store.listGroupMembers(chatId)).map((member) => [
            member.userId,
            member.name,
          ]),
        ).toEqual([
          ["111@lid", "Ana Renamed"],
          ["222@lid", "Bea Newest"],
          ["333@lid", "Cid Push"],
        ]);

        // Chat view: the override beats the stored push name; members
        // without an override or roster name keep their own push name.
        expect(
          (await store.listGroupMessages(chatId, { limit: 50 })).map(
            (message) => message.senderName,
          ),
        ).toEqual([
          "Bea Newest", // 11:00 — 222:2, own push name
          "Ana Renamed", // 10:00 — override wins over "Ana Push"
          "Bea Old", // 09:00 — 222:1, own push name
          "Cid Push", // 08:00 — 333@lid, no roster name
        ]);

        // Contact messages and assistant search follow the same rule.
        expect(
          (
            await store.listContactMessages(["111@lid", "111@s.whatsapp.net"], {
              limit: 50,
            })
          )[0]?.senderName,
        ).toBe("Ana Renamed");
        expect(
          (await store.searchMessages({ text: "hello", limit: 50 })).map(
            (hit) => hit.senderName,
          ),
        ).toEqual(["Bea Newest", "Ana Renamed", "Bea Old", "Cid Push"]);
      });

      it("lists group summaries with their run intervals", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const run = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-10-31T23:00:00.000Z",
            end: "2026-11-01T23:00:00.000Z",
            timezone: "Europe/Madrid",
          },
          kind: "scheduled",
        });
        await store.saveSummary({
          id: randomUUID(),
          runId: run.run.id,
          provider: "mock",
          model: "mock-1",
          result: {
            overview: "Integration overview.",
            keyDiscussions: [],
            confirmedDecisions: [],
            proposals: [],
            unresolvedQuestions: [],
            tasks: [],
            links: [],
            aiGenerated: true,
          },
          createdAt: nowIso(),
        });

        const summaries = await store.listGroupSummaries(groupId, { limit: 20 });
        expect(summaries).toHaveLength(1);
        expect(GroupSummary.parse(summaries[0])).toBeDefined();
        expect(summaries[0]?.interval.start).toBe("2026-10-31T23:00:00.000Z");
        expect(summaries[0]?.interval.timezone).toBe("Europe/Madrid");

        // Other groups see none of it.
        expect(
          await store.listGroupSummaries(randomUUID(), { limit: 20 }),
        ).toEqual([]);
      });
    });

    describe("searchMessages (assistant search)", () => {
      /**
       * Two monitored groups (one chat each) plus an unmonitored one.
       * Ana is on both monitored rosters; Eve only on the unmonitored
       * chat, whose message must never be searchable.
       */
      async function seedSearchFixture() {
        const store = new PostgresStore(pool);
        const chatA = `${randomUUID()}@g.us`;
        const chatB = `${randomUUID()}@g.us`;
        const chatPrivate = `${randomUUID()}@g.us`;
        const groupA = randomUUID();
        const groupB = randomUUID();
        const groupPrivate = randomUUID();
        await store.upsertGroup({
          id: groupA,
          chatId: chatA,
          name: "Monitored A",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroup({
          id: groupB,
          chatId: chatB,
          name: "Monitored B",
          monitored: true,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroup({
          id: groupPrivate,
          chatId: chatPrivate,
          name: "Private C",
          monitored: false,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroupMembers(chatA, [
          {
            userId: "111@lid",
            name: "Ana",
            phone: "111@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
        ]);
        await store.upsertGroupMembers(chatB, [
          {
            userId: "111@lid",
            name: "Ana",
            phone: "111@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
        ]);
        await pool.query(
          "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
          [randomUUID()],
        );
        const insert = async (
          chatId: string,
          senderId: string,
          sentAt: string,
          body: string,
        ): Promise<string> => {
          const result = await pool.query<{ id: string }>(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             SELECT id, $1, $2, $3, NULL, $4, $5
             FROM whatsapp_connections LIMIT 1
             RETURNING id`,
            [chatId, `wa-${randomUUID()}`, senderId, new Date(sentAt), body],
          );
          return result.rows[0]?.id ?? "";
        };
        const launchA = await insert(
          chatA,
          "111:4@s.whatsapp.net",
          "2026-11-16T09:00:00Z",
          "El lanzamiento queda confirmado para el viernes",
        );
        const launchB = await insert(
          chatB,
          "111@lid",
          "2026-11-16T11:00:00Z",
          "Revisé el informe de lanzamiento",
        );
        const privateMessage = await insert(
          chatPrivate,
          "333@lid",
          "2026-11-16T12:00:00Z",
          "lanzamiento secreto",
        );
        return { store, groupA, groupB, launchA, launchB, privateMessage };
      }

      it("searches monitored groups only, newest first, with group names", async () => {
        const { store, launchA, launchB } = await seedSearchFixture();
        const hits = await store.searchMessages({
          senderAliases: ["111@lid", "111@s.whatsapp.net"],
          limit: 10,
        });
        expect(hits.map((hit) => hit.id)).toEqual([launchB, launchA]);
        expect(hits[0]?.groupName).toBe("Monitored B");
        // Device suffix on the stored sender id is normalized before
        // matching, and the roster supplies the display name.
        expect(hits[1]?.senderId).toBe("111:4@s.whatsapp.net");
        expect(hits[1]?.senderName).toBe("Ana");
        expect(hits.every((hit) => hit.body !== "lanzamiento secreto")).toBe(true);
      });

      it("filters by text (substring or trigram) and by group", async () => {
        const { store, groupA, launchA, launchB } = await seedSearchFixture();
        const all = await store.searchMessages({
          senderAliases: ["111@lid", "111@s.whatsapp.net"],
          text: "lanzamiento",
          limit: 10,
        });
        expect(all.map((hit) => hit.id).sort()).toEqual(
          [launchA, launchB].sort(),
        );

        const scoped = await store.searchMessages({
          groupId: groupA,
          text: "lanzamiento",
          limit: 10,
        });
        expect(scoped.map((hit) => hit.id)).toEqual([launchA]);

        // A typo still matches through pg_trgm similarity.
        const fuzzy = await store.searchMessages({
          senderAliases: ["111@lid", "111@s.whatsapp.net"],
          text: "lanzaminto",
          limit: 10,
        });
        expect(fuzzy.length).toBeGreaterThan(0);
      });

      it("applies the half-open range and returns nothing for no aliases", async () => {
        const { store, launchA } = await seedSearchFixture();
        const ranged = await store.searchMessages({
          senderAliases: ["111@lid", "111@s.whatsapp.net"],
          from: "2026-11-16T08:00:00Z",
          to: "2026-11-16T10:00:00Z",
          limit: 10,
        });
        expect(ranged.map((hit) => hit.id)).toEqual([launchA]);

        expect(
          await store.searchMessages({ senderAliases: [], limit: 10 }),
        ).toEqual([]);
      });

      it("uses an admin rename override for the sender name", async () => {
        const { store, launchA } = await seedSearchFixture();
        await store.renameContact("111@s.whatsapp.net", "Ana Renamed");
        const hits = await store.searchMessages({
          senderAliases: ["111@s.whatsapp.net"],
          text: "lanzamiento",
          limit: 10,
        });
        const hit = hits.find((candidate) => candidate.id === launchA);
        expect(hit?.senderName).toBe("Ana Renamed");
      });

      it("treats % and _ in the text query literally (LIKE escaping)", async () => {
        const { store, groupA } = await seedSearchFixture();
        const chatId = (await store.getGroup(groupA))?.chatId ?? "";
        expect(chatId).not.toBe("");
        const insert = async (body: string): Promise<string> => {
          const result = await pool.query<{ id: string }>(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             SELECT id, $1, $2, '444@lid', NULL, $3, $4
             FROM whatsapp_connections LIMIT 1
             RETURNING id`,
            [chatId, `wa-${randomUUID()}`, new Date("2026-11-16T13:00:00Z"), body],
          );
          return result.rows[0]?.id ?? "";
        };
        const percent = await insert("Descuento del 100% confirmado");
        // Only reachable through a LIKE wildcard: no literal "%".
        const decoyPercent = await insert("Descuento del 1000 confirmado");
        const underscore = await insert("Archivo presupuesto_2026 enviado");

        // A bare "%" would mean "match anything" without escaping; the
        // similarity branch scores 0 for a one-character query.
        const wildcard = await store.searchMessages({
          groupId: groupA,
          text: "%",
          limit: 10,
        });
        expect(wildcard.map((hit) => hit.id)).toEqual([percent]);

        // A bare "_" would mean "match any single character".
        const single = await store.searchMessages({
          groupId: groupA,
          text: "_",
          limit: 10,
        });
        expect(single.map((hit) => hit.id)).toEqual([underscore]);

        // A wildcard inside a longer term does not widen the match.
        const literalPercent = await store.searchMessages({
          groupId: groupA,
          text: "100%",
          limit: 10,
        });
        expect(literalPercent.map((hit) => hit.id)).toEqual([percent]);
        expect(literalPercent.map((hit) => hit.id)).not.toContain(decoyPercent);

        // Ordinary text is unaffected: the escape is a no-op for it, so
        // substring and trigram matching keep working.
        const normal = await store.searchMessages({
          groupId: groupA,
          text: "lanzamiento",
          limit: 10,
        });
        expect(normal.length).toBeGreaterThan(0);
      });
    });

    describe("deleteAllData (guarded danger-zone action)", () => {
      it("removes captured data and keeps administrative state", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);

        // Administrative state that must SURVIVE the deletion.
        await store.setAdmin({
          passwordHash: "hash",
          recoveryCodeHashes: new Set(["recovery-hash"]),
        });
        await store.createSession("session-token");
        await store.setProviderConfig({
          provider: "mock",
          model: "mock-1",
          baseUrl: null,
          apiKey: null,
        });
        await store.setDefaultTimezone("America/Caracas");
        await store.setDefaultDateFormat("YYYY-MM-DD");
        await store.setConnectionStatus({
          state: "connected",
          since: "2026-11-01T00:00:00Z",
          lastMessageAt: "2026-11-01T11:00:00Z",
          linking: null,
          check: null,
        });

        // Captured data.
        const groupId = randomUUID();
        const chatId = `${randomUUID()}@g.us`;
        await store.upsertGroup({
          id: groupId,
          chatId,
          name: "Delete Group",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
          historyImport: null,
        });
        await store.upsertGroupMembers(chatId, [
          {
            userId: "111@s.whatsapp.net",
            name: "Ana",
            phone: "111@s.whatsapp.net",
            isAdmin: false,
            active: true,
          },
          {
            userId: "222@lid",
            name: "Beto",
            phone: null,
            isAdmin: true,
            active: true,
          },
        ]);
        await store.renameContact("111@s.whatsapp.net", "Ana Override");
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: "2026-11-02T00:00:00Z",
        });
        const connection = await pool.query<{ id: string }>(
          "SELECT id FROM whatsapp_connections LIMIT 1",
        );
        const connectionId = connection.rows[0]?.id ?? "";
        await pool.query(
          `INSERT INTO messages
             (connection_id, chat_id, whatsapp_message_id, sender_id,
              sender_name, sent_at, body)
           VALUES ($1, $2, $3, '111@s.whatsapp.net', 'Ana', $4, 'hello')`,
          [
            connectionId,
            chatId,
            `wa-${randomUUID()}`,
            new Date("2026-11-01T10:00:00Z"),
          ],
        );

        const deleted = await store.deleteAllData();
        expect(deleted).toEqual({
          groups: 1,
          messages: 1,
          summaryRuns: 1,
          summaries: 1,
          groupMembers: 2,
          contactOverrides: 1,
        });

        // Captured data is gone.
        const remaining = await pool.query<{
          groups: number;
          messages: number;
          summary_runs: number;
          summaries: number;
          group_members: number;
          contact_overrides: number;
        }>(
          `SELECT (SELECT count(*) FROM groups)::int AS groups,
                  (SELECT count(*) FROM messages)::int AS messages,
                  (SELECT count(*) FROM summary_runs)::int AS summary_runs,
                  (SELECT count(*) FROM summaries)::int AS summaries,
                  (SELECT count(*) FROM group_members)::int AS group_members,
                  (SELECT count(*) FROM contact_overrides)::int AS contact_overrides`,
        );
        expect(remaining.rows[0]).toEqual({
          groups: 0,
          messages: 0,
          summary_runs: 0,
          summaries: 0,
          group_members: 0,
          contact_overrides: 0,
        });

        // Administrative state is kept (settings, provider, admin,
        // sessions, connection row) and only last_message_at is cleared.
        expect(await store.getAdmin()).not.toBeNull();
        expect(await store.validateSession("session-token")).toBe(true);
        expect(await store.getProviderConfig()).not.toBeNull();
        expect(await store.getDefaultTimezone()).toBe("America/Caracas");
        expect(await store.getDefaultDateFormat()).toBe("YYYY-MM-DD");
        const status = await store.getConnectionStatus();
        expect(status.state).toBe("connected");
        expect(status.lastMessageAt).toBeNull();
        const connectionCount = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM whatsapp_connections",
        );
        expect(connectionCount.rows[0]?.n).toBe(1);
      });
    });

    describe("deleteMessagesBefore (automatic retention)", () => {
      it("deletes only messages strictly older than the cutoff", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: "2026-11-02T00:00:00Z",
        });

        const connectionId = randomUUID();
        await pool.query(
          "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
          [connectionId],
        );
        const insertMessage = async (sentAt: string) => {
          await pool.query(
            `INSERT INTO messages
               (connection_id, chat_id, whatsapp_message_id, sender_id,
                sender_name, sent_at, body)
             VALUES ($1, '120363000000000001@g.us', $2, '111@s.whatsapp.net',
                     NULL, $3, 'hello')`,
            [connectionId, `wa-${randomUUID()}`, new Date(sentAt)],
          );
        };
        await insertMessage("2026-11-01T10:00:00Z"); // older
        await insertMessage("2026-11-02T00:00:00Z"); // exactly at the cutoff
        await insertMessage("2026-11-03T10:00:00Z"); // newer

        const deleted = await store.deleteMessagesBefore(
          new Date("2026-11-02T00:00:00Z"),
        );
        expect(deleted).toBe(1);

        const remaining = await pool.query<{ sent_at: Date }>(
          "SELECT sent_at FROM messages ORDER BY sent_at",
        );
        expect(remaining.rows.map((row) => row.sent_at.toISOString())).toEqual([
          "2026-11-02T00:00:00.000Z",
          "2026-11-03T10:00:00.000Z",
        ]);

        // Messages only: the run and its summary survive the pass, so a
        // summary's source refs may dangle but the summary is kept.
        expect(await store.getRun(run.id)).toBeDefined();
        expect(await store.getSummaryByRunId(run.id)).toBeDefined();

        // An earlier cutoff matches nothing and reports 0.
        expect(
          await store.deleteMessagesBefore(new Date("2020-01-01T00:00:00Z")),
        ).toBe(0);
      });
    });
  },
);
