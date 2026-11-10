import type { Pool, QueryResultRow } from "pg";
import {
  ConnectionStatus,
  Group,
  GroupSummary,
  Summary,
  SummaryRun,
  type ApiMessage,
  type ConnectionLinking,
  type ContactDetail,
  type ContactMessage,
  type ContactSummary,
  type DateFormat,
  type GroupMember,
} from "@summarly/contracts";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  decodeMessageCursor,
  hashSessionToken,
  nowIso,
  servedLinking,
  type AdminRecord,
  type CreateRunInput,
  type GroupMemberInput,
  type ListMessagesOptions,
  type ProviderRecord,
  type Store,
} from "./store.js";

/**
 * PostgreSQL implementation of the Store interface (the durable source of
 * truth, docs/decisions/0001). All SQL is parameterized; values are never
 * interpolated into query strings. Contract schemas are used to validate
 * rows at the database boundary.
 *
 * Provider API keys are encrypted at rest with AES-256-GCM
 * (lib/crypto.ts); plaintext keys only ever exist in process memory and
 * are never included in API responses (routes mask them).
 */

type AdminRow = QueryResultRow & {
  password_hash: string;
  recovery_code_hashes: string[];
};

type GroupRow = QueryResultRow & {
  id: string;
  chat_id: string | null;
  name: string;
  monitored: boolean;
  timezone: string;
  summary_time: string | null;
  // System-managed history-import columns (ADR 0007).
  history_import_status: string | null;
  history_import_requested_at: Date | null;
  history_import_started_at: Date | null;
  history_import_finished_at: Date | null;
  history_import_imported_count: number;
  history_import_error: string | null;
};

type RunRow = QueryResultRow & {
  id: string;
  group_id: string;
  kind: string;
  status: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  attempts: number;
  instructions: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type CreatedRunRow = RunRow & { created: boolean };

type SummaryRow = QueryResultRow & {
  id: string;
  run_id: string;
  provider: string;
  model: string;
  result: unknown;
  created_at: Date;
};

type ProviderRow = QueryResultRow & {
  provider: string;
  model: string;
  base_url: string | null;
  api_key_encrypted: string | null;
};

type ConnectionRow = QueryResultRow & {
  state: string;
  since: Date;
  last_message_at: Date | null;
  linking_qr: string | null;
  linking_qr_expires_at: Date | null;
  linking_kind: string | null;
  logout_requested_at: Date | null;
  session_check_requested_at: Date | null;
  session_check_checked_at: Date | null;
  session_check_ok: boolean | null;
  session_check_latency_ms: number | null;
  session_check_error: string | null;
};

type MemberRow = QueryResultRow & {
  user_id: string;
  name: string | null;
  phone: string | null;
  is_admin: boolean;
  active: boolean;
  updated_at: Date;
};

type ContactRow = QueryResultRow & {
  contact_key: string;
  name: string | null;
  phone: string | null;
  groups: Array<{ id: string; name: string }>;
  user_ids: string[];
  phones: string[] | null;
  message_count: number;
  last_message_at: Date | null;
};

type ContactMessageRow = MessageRow & {
  group_id: string;
  group_name: string;
};

/**
 * Shared contact aggregation (list + detail). A contact's canonical key
 * is the PN JID when known, else the LID; aliases are every JID form
 * seen on the roster. Message stats join aliases to stored sender ids
 * after stripping device suffixes, and only count monitored groups.
 */
const CONTACTS_CTE = `
WITH member_rows AS (
  SELECT gm.chat_id,
         gm.user_id,
         gm.name,
         gm.phone,
         gm.updated_at,
         COALESCE(gm.phone, gm.user_id) AS contact_key,
         g.id AS group_id,
         g.name AS group_name
  FROM group_members gm
  JOIN groups g ON g.chat_id = gm.chat_id AND g.monitored = true
  WHERE gm.active = true
),
contacts AS (
  SELECT mr.contact_key,
         COALESCE(
           o.name,
           (array_agg(mr.name ORDER BY mr.updated_at DESC)
              FILTER (WHERE mr.name IS NOT NULL))[1]
         ) AS name,
         max(mr.phone) AS phone,
         jsonb_agg(DISTINCT jsonb_build_object('id', mr.group_id, 'name', mr.group_name)) AS groups,
         array_agg(DISTINCT mr.user_id) AS user_ids,
         array_agg(DISTINCT mr.phone) FILTER (WHERE mr.phone IS NOT NULL) AS phones
  FROM member_rows mr
  LEFT JOIN contact_overrides o ON o.contact_id = mr.contact_key
  GROUP BY mr.contact_key, o.name
),
aliases AS (
  SELECT contact_key,
         unnest(user_ids || COALESCE(phones, ARRAY[]::text[])) AS alias
  FROM contacts
),
message_stats AS (
  SELECT a.contact_key,
         count(*)::int AS message_count,
         max(m.sent_at) AS last_message_at
  FROM aliases a
  JOIN messages m
    ON regexp_replace(m.sender_id, ':.*@', '@') = a.alias
  JOIN groups g ON g.chat_id = m.chat_id AND g.monitored = true
  GROUP BY a.contact_key
)
`;

type MessageRow = QueryResultRow & {
  id: string;
  sent_at: Date;
  sender_id: string;
  sender_name: string | null;
  body: string;
  message_type: string;
};

const RUN_COLUMNS =
  "id, group_id, kind, status, start_at, end_at, timezone, attempts, " +
  "instructions, error_code, error_message, created_at, updated_at";

const SUMMARY_COLUMNS = "id, run_id, provider, model, result, created_at";

const GROUP_COLUMNS =
  "id, chat_id, name, monitored, timezone, summary_time, " +
  "history_import_status, history_import_requested_at, " +
  "history_import_started_at, history_import_finished_at, " +
  "history_import_imported_count, history_import_error";

function toAdminRecord(row: AdminRow): AdminRecord {
  return {
    passwordHash: row.password_hash,
    recoveryCodeHashes: new Set(row.recovery_code_hashes),
  };
}

function toGroup(row: GroupRow): Group {
  return Group.parse({
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    monitored: row.monitored,
    timezone: row.timezone,
    summaryTime: row.summary_time,
    // System-managed history-import state (ADR 0007). Invariant: a set
    // status always has requested_at (requestHistoryImport and the
    // bot-worker maintain it); if it is ever violated the parse below
    // fails loudly at this boundary instead of inventing a timestamp.
    historyImport:
      row.history_import_status === null
        ? null
        : {
            status: row.history_import_status,
            requestedAt: row.history_import_requested_at?.toISOString() ?? "",
            startedAt: row.history_import_started_at?.toISOString() ?? null,
            finishedAt: row.history_import_finished_at?.toISOString() ?? null,
            importedCount: row.history_import_imported_count,
            error: row.history_import_error,
          },
  });
}

function toSummaryRun(row: RunRow): SummaryRun {
  return SummaryRun.parse({
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    status: row.status,
    interval: {
      start: row.start_at.toISOString(),
      end: row.end_at.toISOString(),
      timezone: row.timezone,
    },
    attempts: row.attempts,
    instructions: row.instructions,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    error:
      row.error_code !== null && row.error_message !== null
        ? { code: row.error_code, message: row.error_message }
        : null,
  });
}

function toSummary(row: SummaryRow): Summary {
  return Summary.parse({
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    result: row.result,
    createdAt: row.created_at.toISOString(),
  });
}

export class PostgresStore implements Store {
  constructor(
    private readonly pool: Pool,
    /** AES-256-GCM master key for provider credentials; see lib/crypto.ts. */
    private readonly encryptionKey: Buffer | null = null,
  ) {}

  private requireKey(): Buffer {
    if (this.encryptionKey === null) {
      throw new Error(
        "ENCRYPTION_KEY is required to read or write AI provider credentials.",
      );
    }
    return this.encryptionKey;
  }

  // ---- Admin credentials ----

  async getAdmin(): Promise<AdminRecord | null> {
    const result = await this.pool.query<AdminRow>(
      "SELECT password_hash, recovery_code_hashes FROM admin_credentials LIMIT 1",
    );
    const row = result.rows[0];
    return row === undefined ? null : toAdminRecord(row);
  }

  async setAdmin(record: AdminRecord): Promise<boolean> {
    // Insert-only (M8): concurrent first-run setup attempts race on the
    // single-row constraint; exactly one wins and the losers' recovery
    // codes are never silently discarded by an overwrite.
    const result = await this.pool.query(
      `INSERT INTO admin_credentials (password_hash, recovery_code_hashes)
       VALUES ($1, $2)
       ON CONFLICT ((true)) DO NOTHING
       RETURNING id`,
      [record.passwordHash, [...record.recoveryCodeHashes]],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void> {
    // One statement = one transaction: the password update and the
    // session eviction commit together or not at all (M9).
    await this.pool.query(
      `WITH updated AS (
         UPDATE admin_credentials
         SET password_hash = $1,
             recovery_code_hashes = COALESCE($2::text[], recovery_code_hashes),
             updated_at = now()
       ),
       cleared AS (
         DELETE FROM admin_sessions
       )
       SELECT 1`,
      [
        input.passwordHash,
        input.recoveryCodeHashes === undefined
          ? null
          : [...input.recoveryCodeHashes],
      ],
    );
  }

  async consumeRecoveryCode(
    codeHash: string,
    newPasswordHash: string,
  ): Promise<boolean> {
    // One statement = one transaction (M9): consuming the one-time code,
    // setting the new password, and evicting all sessions commit
    // together, so a code can never be used twice and a reset can never
    // leave sessions alive.
    const result = await this.pool.query(
      `WITH consumed AS (
         UPDATE admin_credentials
         SET password_hash = $2,
             recovery_code_hashes = array_remove(recovery_code_hashes, $1),
             updated_at = now()
         WHERE $1 = ANY(recovery_code_hashes)
         RETURNING id
       ),
       cleared AS (
         DELETE FROM admin_sessions
         WHERE EXISTS (SELECT 1 FROM consumed)
       )
       SELECT id FROM consumed`,
      [codeHash, newPasswordHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Sessions ----

  async createSession(token: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO admin_sessions (token_hash) VALUES ($1) ON CONFLICT (token_hash) DO NOTHING",
      [hashSessionToken(token)],
    );
  }

  async validateSession(token: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM admin_sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [
      hashSessionToken(token),
    ]);
  }

  async clearSessions(): Promise<void> {
    await this.pool.query("DELETE FROM admin_sessions");
  }

  // ---- Groups ----

  async listGroups(): Promise<Group[]> {
    const result = await this.pool.query<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM groups ORDER BY name ASC, id ASC`,
    );
    return result.rows.map(toGroup);
  }

  async getGroup(id: string): Promise<Group | undefined> {
    const result = await this.pool.query<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toGroup(row);
  }

  async updateGroup(group: Group): Promise<Group | undefined> {
    const result = await this.pool.query<GroupRow>(
      `UPDATE groups
       SET name = $2, monitored = $3, timezone = $4, summary_time = $5, updated_at = now()
       WHERE id = $1
       RETURNING ${GROUP_COLUMNS}`,
      [group.id, group.name, group.monitored, group.timezone, group.summaryTime],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toGroup(row);
  }

  async upsertGroup(group: Group): Promise<Group> {
    // Natural key is chat_id when provided (idempotent registration by
    // chat). NEVER-CLOBBER (ADR 0004 / audit M3): a chat-keyed upsert
    // updates ONLY the name — monitored, timezone, summary_time (and id)
    // are admin preferences and are never overwritten here. updateGroup
    // is the only admin-preference writer. The stored id wins over the
    // caller's id so foreign keys (messages, summary_runs) stay stable
    // across rediscovery.
    if (group.chatId !== null) {
      const byChat = await this.pool.query<GroupRow>(
        `UPDATE groups
         SET name = $2, updated_at = now()
         WHERE chat_id = $1
         RETURNING ${GROUP_COLUMNS}`,
        [group.chatId, group.name],
      );
      const chatRow = byChat.rows[0];
      if (chatRow !== undefined) return toGroup(chatRow);
    }
    const inserted = await this.pool.query<GroupRow>(
      `INSERT INTO groups (
         id, chat_id, name, monitored, timezone, summary_time,
         history_import_status, history_import_requested_at,
         history_import_started_at, history_import_finished_at,
         history_import_imported_count, history_import_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING ${GROUP_COLUMNS}`,
      [
        group.id,
        group.chatId,
        group.name,
        group.monitored,
        group.timezone,
        group.summaryTime,
        // New rows may carry an initial history-import state (tests);
        // writers of EXISTING rows never touch these columns below.
        group.historyImport?.status ?? null,
        group.historyImport === null || group.historyImport === undefined
          ? null
          : new Date(group.historyImport.requestedAt),
        group.historyImport?.startedAt == null
          ? null
          : new Date(group.historyImport.startedAt),
        group.historyImport?.finishedAt == null
          ? null
          : new Date(group.historyImport.finishedAt),
        group.historyImport?.importedCount ?? 0,
        group.historyImport?.error ?? null,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) return toGroup(insertedRow);
    // The insert lost to an existing row: either the id is already
    // registered (replace it, including its chat_id — an explicit-id
    // write is the caller's full statement) or a concurrent upsert
    // registered the same chat first (name-only: never-clobber).
    const byId = await this.pool.query<GroupRow>(
      `UPDATE groups
       SET chat_id = $2, name = $3, monitored = $4, timezone = $5, summary_time = $6, updated_at = now()
       WHERE id = $1
       RETURNING ${GROUP_COLUMNS}`,
      [group.id, group.chatId, group.name, group.monitored, group.timezone, group.summaryTime],
    );
    const idRow = byId.rows[0];
    if (idRow !== undefined) return toGroup(idRow);
    if (group.chatId !== null) {
      const byChat = await this.pool.query<GroupRow>(
        `UPDATE groups
         SET name = $2, updated_at = now()
         WHERE chat_id = $1
         RETURNING ${GROUP_COLUMNS}`,
        [group.chatId, group.name],
      );
      const chatRow = byChat.rows[0];
      if (chatRow !== undefined) return toGroup(chatRow);
    }
    throw new Error("upsertGroup failed to persist the group");
  }

  async requestHistoryImport(
    groupId: string,
  ): Promise<{ group: Group; changed: boolean } | undefined> {
    // Atomic transition (ADR 0007): only a group that is NOT already
    // pending/running gets a fresh request (status, requested_at and
    // progress fields reset together). Concurrent requests are safe:
    // the WHERE clause lets exactly one through — that one reports
    // `changed: true` (202) while the others observe the in-flight
    // state and report `changed: false` (200), so the response code is
    // decided by the WRITE, not by a pre-write read (review CR-m1).
    const updated = await this.pool.query<GroupRow>(
      `UPDATE groups
       SET history_import_status = 'pending',
           history_import_requested_at = now(),
           history_import_started_at = NULL,
           history_import_finished_at = NULL,
           history_import_imported_count = 0,
           history_import_error = NULL,
           updated_at = now()
       WHERE id = $1
         AND (history_import_status IS NULL
              OR history_import_status NOT IN ('pending', 'running'))
       RETURNING ${GROUP_COLUMNS}`,
      [groupId],
    );
    const row = updated.rows[0];
    if (row !== undefined) return { group: toGroup(row), changed: true };
    // No transition: either the group is unknown or an import is
    // already in flight (idempotent — return it unchanged).
    const existing = await this.getGroup(groupId);
    return existing === undefined
      ? undefined
      : { group: existing, changed: false };
  }

  async cancelPendingHistoryImport(groupId: string): Promise<boolean> {
    // SA-M1 (consent): un-monitoring revokes a PENDING import. One
    // conditional statement; `running` rows are deliberately NOT
    // matched — the bot-worker aborts its own in-flight work when it
    // notices the group is unmonitored. done/failed states are history.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = NULL,
           history_import_requested_at = NULL,
           history_import_started_at = NULL,
           history_import_finished_at = NULL,
           history_import_imported_count = 0,
           history_import_error = NULL,
           updated_at = now()
       WHERE id = $1 AND history_import_status = 'pending'`,
      [groupId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Summary runs ----

  async createOrFindRun(
    input: CreateRunInput,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    // Identity is (group_id, start_at, end_at, kind). timestamptz equality
    // is instant-based, so "…Z" and "+02:00" spellings of the same moment
    // hit the same row via ON CONFLICT. The timezone label is presentation
    // metadata, not identity: the first request's label is kept (the
    // conflicting insert performs a no-op update and returns the stored row).
    //
    // Implementation note (deliberate trade-off): the conflict branch uses
    // `DO UPDATE SET group_id = summary_runs.group_id` (a no-op update)
    // rather than `DO NOTHING` + a follow-up `SELECT`, because only
    // DO UPDATE guarantees a RETURNING row for both branches in a single
    // round-trip, race-free. `(xmax = 0)` then distinguishes a fresh
    // insert (true) from a reused row (false).
    // Cost: every duplicate create-or-find call writes a new row version
    // of the run (dead tuple for autovacuum). Duplicates are rare and
    // bounded (API retries and reconciliation), so this trades a little
    // write amplification for simpler, provably-correct semantics. If
    // measurement ever shows bloat here, switch to DO NOTHING + SELECT.
    const result = await this.pool.query<CreatedRunRow>(
      `INSERT INTO summary_runs (group_id, kind, status, start_at, end_at, timezone, attempts, instructions)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0, $6)
       ON CONFLICT (group_id, start_at, end_at, kind)
       DO UPDATE SET group_id = summary_runs.group_id
       RETURNING ${RUN_COLUMNS}, (xmax = 0) AS created`,
      [
        input.groupId,
        input.kind,
        new Date(input.interval.start),
        new Date(input.interval.end),
        input.interval.timezone,
        // First request's instructions win on a repeated create-or-find
        // (the conflict branch is a no-op update) — ADR 0008.
        input.instructions ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createOrFindRun returned no row");
    return { run: toSummaryRun(row), created: row.created };
  }

  async findRunByIdentity(
    input: CreateRunInput,
  ): Promise<SummaryRun | undefined> {
    // Identity is (group, start instant, end instant, kind) — the same
    // tuple as the UNIQUE constraint. Read-only: the scheduler uses it
    // to avoid re-creating/re-enqueueing an already-scheduled window.
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM summary_runs
       WHERE group_id = $1 AND start_at = $2 AND end_at = $3 AND kind = $4`,
      [
        input.groupId,
        new Date(input.interval.start),
        new Date(input.interval.end),
        input.kind,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummaryRun(row);
  }

  async getRun(id: string): Promise<SummaryRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM summary_runs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummaryRun(row);
  }

  async listRuns(): Promise<SummaryRun[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM summary_runs ORDER BY created_at DESC, id DESC`,
    );
    return result.rows.map(toSummaryRun);
  }

  async updateRun(run: SummaryRun): Promise<SummaryRun> {
    const result = await this.pool.query<RunRow>(
      `UPDATE summary_runs
       SET status = $2, attempts = $3, error_code = $4, error_message = $5, updated_at = $6
       WHERE id = $1
       RETURNING ${RUN_COLUMNS}`,
      [
        run.id,
        run.status,
        run.attempts,
        run.error?.code ?? null,
        run.error?.message ?? null,
        new Date(run.updatedAt),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Summary run not found: ${run.id}`);
    return toSummaryRun(row);
  }

  // ---- Summaries ----

  async saveSummary(summary: Summary): Promise<Summary> {
    // Validate before writing (M7): the read path parses rows through
    // the contract schemas, so the write path must never be able to
    // persist a row those schemas reject.
    const valid = Summary.parse(summary);
    // UNIQUE(run_id) makes writes idempotent: a repeated job execution
    // replaces the result instead of creating a duplicate completed
    // summary (architecture §6). The first write's id/createdAt are kept.
    const result = await this.pool.query<SummaryRow>(
      `INSERT INTO summaries (id, run_id, provider, model, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         result = EXCLUDED.result
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        valid.id,
        valid.runId,
        valid.provider,
        valid.model,
        valid.result,
        new Date(valid.createdAt),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("saveSummary returned no row");
    return toSummary(row);
  }

  async getSummary(id: string): Promise<Summary | undefined> {
    const result = await this.pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummary(row);
  }

  async getSummaryByRunId(runId: string): Promise<Summary | undefined> {
    const result = await this.pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummary(row);
  }

  // ---- AI provider configuration ----

  async getProviderConfig(): Promise<ProviderRecord | null> {
    const result = await this.pool.query<ProviderRow>(
      "SELECT provider, model, base_url, api_key_encrypted FROM ai_provider_configs LIMIT 1",
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKey:
        row.api_key_encrypted === null
          ? null
          : decryptSecret(this.requireKey(), row.api_key_encrypted),
    };
  }

  async setProviderConfig(record: ProviderRecord): Promise<ProviderRecord> {
    const encrypted =
      record.apiKey === null
        ? null
        : encryptSecret(this.requireKey(), record.apiKey);
    await this.pool.query(
      `INSERT INTO ai_provider_configs (provider, model, base_url, api_key_encrypted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ((true)) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         base_url = EXCLUDED.base_url,
         api_key_encrypted = EXCLUDED.api_key_encrypted,
         updated_at = now()`,
      [record.provider, record.model, record.baseUrl, encrypted],
    );
    return record;
  }

  async getDefaultTimezone(): Promise<string> {
    const result = await this.pool.query<{ default_timezone: string }>(
      "SELECT default_timezone FROM app_settings WHERE id = 1",
    );
    return result.rows[0]?.default_timezone ?? "UTC";
  }

  async setDefaultTimezone(timezone: string): Promise<string> {
    await this.pool.query(
      `INSERT INTO app_settings (id, default_timezone, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET
         default_timezone = EXCLUDED.default_timezone,
         updated_at = now()`,
      [timezone],
    );
    return timezone;
  }

  async getDefaultDateFormat(): Promise<DateFormat> {
    const result = await this.pool.query<{ default_date_format: DateFormat }>(
      "SELECT default_date_format FROM app_settings WHERE id = 1",
    );
    return result.rows[0]?.default_date_format ?? "DD/MM/YYYY";
  }

  async setDefaultDateFormat(dateFormat: DateFormat): Promise<DateFormat> {
    await this.pool.query(
      `INSERT INTO app_settings (id, default_date_format, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET
         default_date_format = EXCLUDED.default_date_format,
         updated_at = now()`,
      [dateFormat],
    );
    return dateFormat;
  }

  // ---- WhatsApp connection status ----

  async getConnectionStatus(): Promise<ConnectionStatus> {
    const result = await this.pool.query<ConnectionRow>(
      "SELECT state, since, last_message_at, linking_qr, " +
        "linking_qr_expires_at, linking_kind, logout_requested_at, " +
        "session_check_requested_at, session_check_checked_at, " +
        "session_check_ok, session_check_latency_ms, session_check_error " +
        "FROM whatsapp_connections LIMIT 1",
    );
    const row = result.rows[0];
    if (row === undefined) {
      // No row has ever been written (bot-worker has not reported yet).
      return ConnectionStatus.parse({
        state: "unavailable",
        since: nowIso(),
        lastMessageAt: null,
        linking: null,
        check: null,
      });
    }
    // The RAW pairing payload (ADR 0008: `qr` is a live pairing ticket
    // — served on the authenticated API only, never logged). A NULL
    // kind means the bot-worker has not published one yet: it is a QR
    // payload (the documented default). The kind is narrowed, not
    // parsed: the column CHECK bounds its domain and a read-path throw
    // would turn a bad row into a 500 for the whole endpoint.
    const rawLinking: ConnectionLinking | null =
      row.linking_qr === null || row.linking_qr_expires_at === null
        ? null
        : {
            kind: row.linking_kind === "pairing-code" ? "pairing-code" : "qr",
            qr: row.linking_qr,
            expiresAt: row.linking_qr_expires_at.toISOString(),
          };
    // Visibility gate (fix round A, audit M-4): served ONLY while the
    // session is being linked (connecting/disconnected) AND unexpired —
    // shared rule, InMemoryStore parity.
    const requestedAt = row.session_check_requested_at;
    const checkedAt = row.session_check_checked_at;
    const pending =
      requestedAt !== null &&
      (checkedAt === null || checkedAt < requestedAt);
    const check =
      requestedAt === null
        ? null
        : {
            status: pending
              ? ("pending" as const)
              : row.session_check_ok === true
                ? ("ok" as const)
                : ("failed" as const),
            requestedAt: requestedAt.toISOString(),
            checkedAt: checkedAt === null ? null : checkedAt.toISOString(),
            latencyMs: row.session_check_latency_ms,
            error: row.session_check_error,
          };
    return ConnectionStatus.parse({
      state: row.state,
      since: row.since.toISOString(),
      lastMessageAt:
        row.last_message_at === null ? null : row.last_message_at.toISOString(),
      linking: servedLinking(row.state, rawLinking),
      check,
    });
  }

  async setConnectionStatus(status: ConnectionStatus): Promise<void> {
    // Validate before writing (M7), mirroring the read-path validation.
    // Only the state columns are written: linking and logout are owned
    // by their dedicated writers (ADR 0008).
    const valid = ConnectionStatus.parse(status);
    await this.pool.query(
      `INSERT INTO whatsapp_connections (state, since, last_message_at)
       VALUES ($1, $2, $3)
       ON CONFLICT ((true)) DO UPDATE SET
         state = EXCLUDED.state,
         since = EXCLUDED.since,
         last_message_at = EXCLUDED.last_message_at,
         updated_at = now()`,
      [valid.state, new Date(valid.since), valid.lastMessageAt],
    );
  }

  async requestSessionCheck(): Promise<void> {
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET session_check_requested_at = now(),
           session_check_checked_at = NULL,
           session_check_ok = NULL,
           session_check_latency_ms = NULL,
           session_check_error = NULL,
           updated_at = now()`,
    );
  }

  async updateConnectionLinking(
    linking: {
      qr: string;
      expiresAt: string;
      kind?: ConnectionLinking["kind"];
    } | null,
  ): Promise<void> {
    // Single-row invariant (migration 0001: UNIQUE index on (true)):
    // this UPDATE targets THE whatsapp_connections row — a no-op when
    // the bot-worker has never reported (no row), the exact row
    // otherwise. It must never gain a WHERE clause that could match
    // more than that one row.
    // Row created by bot-worker reporting; no row = nothing to update.
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET linking_qr = $1, linking_qr_expires_at = $2, linking_kind = $3,
           updated_at = now()`,
      [
        linking === null ? null : linking.qr,
        linking === null ? null : new Date(linking.expiresAt),
        // NULL kind = "not published yet": served as qr (default).
        linking === null ? null : (linking.kind ?? "qr"),
      ],
    );
  }

  async requestLogout(): Promise<void> {
    // Single-row invariant (see updateConnectionLinking): updates THE
    // connection row only, and only when one exists.
    // Idempotent: an already-pending request keeps its original
    // timestamp (COALESCE) so the bot-worker sees a stable request.
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET logout_requested_at = COALESCE(logout_requested_at, now()),
           updated_at = now()`,
    );
  }

  async clearLogoutRequest(): Promise<void> {
    // Single-row invariant (see updateConnectionLinking). This is the
    // bot-worker's consume path for the admin's logout request.
    await this.pool.query(
      "UPDATE whatsapp_connections SET logout_requested_at = NULL, updated_at = now()",
    );
  }

  // ---- Group detail data (ADR 0008) ----

  async upsertGroupMembers(
    chatId: string,
    members: GroupMemberInput[],
  ): Promise<void> {
    if (members.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [chatId];
    members.forEach((member, index) => {
      const base = index * 5 + 2;
      values.push(
        `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`,
      );
      params.push(
        member.userId,
        member.name,
        member.phone,
        member.isAdmin,
        member.active,
      );
    });
    // Roster refresh semantics (fix round A, m9): a refresh without a
    // display name (Baileys group metadata carries only JIDs) must
    // never wipe a name learned from a message pushName — hence
    // COALESCE on name (and phone). This is the REFERENCE writer the
    // bot-worker's roster capture must match (COALESCE parity).
    await this.pool.query(
      `INSERT INTO group_members (chat_id, user_id, name, phone, is_admin, active, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (chat_id, user_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, group_members.name),
         phone = COALESCE(EXCLUDED.phone, group_members.phone),
         is_admin = EXCLUDED.is_admin,
         active = EXCLUDED.active,
         updated_at = now()`,
      params,
    );
  }

  async listGroupMembers(chatId: string): Promise<GroupMember[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT user_id, name, phone, is_admin, active, updated_at
       FROM group_members
       WHERE chat_id = $1
       ORDER BY is_admin DESC, name ASC NULLS LAST, user_id ASC`,
      [chatId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      phone: row.phone,
      isAdmin: row.is_admin,
      active: row.active,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async listGroupMessages(
    chatId: string,
    options: ListMessagesOptions,
  ): Promise<ApiMessage[]> {
    const cursor =
      options.cursor === undefined
        ? undefined
        : decodeMessageCursor(options.cursor);
    // A provided cursor that does not decode (fix round A, audit L-4 —
    // a non-UUID id used to reach the `::uuid` cast and 500) is a
    // caller bug: throw instead of silently returning page 1. The
    // route validates first and answers 400; this is the backstop.
    if (options.cursor !== undefined && cursor === undefined) {
      throw new Error("invalid message cursor");
    }
    // Keyset predicate (sent_at, id) < (cursor, id). Precision note
    // (fix round A, m3): sent_at is written from JavaScript Date values
    // (millisecond precision) and the cursor round-trips ms-precision
    // ISO strings, so the row-wise comparison is exact for every row
    // our writers produce. If microsecond-precision rows ever appear
    // (e.g. raw SQL imports), change the predicate to
    // (date_trunc('milliseconds', sent_at), id) < (...) — and widen the
    // (chat_id, sent_at) index accordingly.
    const result = await this.pool.query<MessageRow>(
      `SELECT m.id, m.sent_at, m.sender_id,
              COALESCE(m.sender_name, gm.name) AS sender_name,
              m.body, m.message_type
       FROM messages m
       LEFT JOIN LATERAL (
         SELECT COALESCE(o.name, member.name) AS name
         FROM group_members member
         LEFT JOIN contact_overrides o
           ON o.contact_id = COALESCE(member.phone, member.user_id)
         WHERE member.chat_id = m.chat_id
           AND (
             member.user_id = regexp_replace(m.sender_id, ':.*@', '@')
             OR member.phone = regexp_replace(m.sender_id, ':.*@', '@')
           )
         ORDER BY (member.user_id = regexp_replace(m.sender_id, ':.*@', '@')) DESC
         LIMIT 1
       ) gm ON true
       WHERE m.chat_id = $1
         AND ($2::timestamptz IS NULL OR m.sent_at >= $2)
         AND ($3::timestamptz IS NULL OR m.sent_at < $3)
         AND ($4::timestamptz IS NULL OR
              (m.sent_at, m.id) < ($4::timestamptz, $5::uuid))
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT $6`,
      [
        chatId,
        options.from === undefined ? null : new Date(options.from),
        options.to === undefined ? null : new Date(options.to),
        cursor === undefined ? null : new Date(cursor.sentAt),
        cursor === undefined ? null : cursor.id,
        options.limit,
      ],
    );
    // Row mapping is a CAST, deliberately (fix round A, m4): these rows
    // are written by the capture path, whose clamping to the contract
    // bounds is the bot-worker's job (round B). Running ApiMessage.parse
    // here would turn ONE out-of-bound row (e.g. an over-long push name)
    // into a 500 for the whole page; instead the read path trusts the
    // writer and only the REQUEST boundary (cursor/range/limit) is
    // validated. chatId is deliberately omitted from the rows: the
    // caller asked for one group and the ApiMessage contract keeps it
    // optional.
    return result.rows.map((row) => ({
      id: row.id,
      sentAt: row.sent_at.toISOString(),
      // sender_id is nullable in the schema; the contract requires a
      // value, so the gap is filled here (writer-side clamping follows
      // in round B).
      senderId: row.sender_id ?? "unknown",
      senderName: row.sender_name,
      body: row.body,
      messageType: row.message_type,
    })) as ApiMessage[];
  }

  async listContacts(): Promise<ContactSummary[]> {
    const result = await this.pool.query<ContactRow>(
      `${CONTACTS_CTE}
       SELECT c.contact_key, c.name, c.phone, c.groups,
              c.user_ids, c.phones,
              COALESCE(ms.message_count, 0) AS message_count,
              ms.last_message_at
       FROM contacts c
       LEFT JOIN message_stats ms ON ms.contact_key = c.contact_key
       ORDER BY c.name ASC NULLS LAST, c.contact_key ASC`,
    );
    return result.rows.map((row) => this.toContactSummary(row));
  }

  async getContact(contactId: string): Promise<ContactDetail | undefined> {
    const result = await this.pool.query<ContactRow>(
      `${CONTACTS_CTE}
       SELECT c.contact_key, c.name, c.phone, c.groups,
              c.user_ids, c.phones,
              COALESCE(ms.message_count, 0) AS message_count,
              ms.last_message_at
       FROM contacts c
       LEFT JOIN message_stats ms ON ms.contact_key = c.contact_key
       WHERE c.contact_key = $1`,
      [contactId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      ...this.toContactSummary(row),
      aliases: [...new Set([...row.user_ids, ...(row.phones ?? [])])].sort(),
    };
  }

  async renameContact(
    contactId: string,
    name: string,
  ): Promise<ContactDetail | undefined> {
    const contact = await this.getContact(contactId);
    if (contact === undefined) return undefined;
    await this.pool.query(
      `INSERT INTO contact_overrides (contact_id, name, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (contact_id) DO UPDATE SET
         name = EXCLUDED.name,
         updated_at = now()`,
      [contactId, name.trim().slice(0, 300)],
    );
    return this.getContact(contactId);
  }

  async listContactMessages(
    aliases: readonly string[],
    options: ListMessagesOptions,
  ): Promise<ContactMessage[]> {
    const cursor =
      options.cursor === undefined
        ? undefined
        : decodeMessageCursor(options.cursor);
    if (options.cursor !== undefined && cursor === undefined) {
      throw new Error("invalid message cursor");
    }
    const result = await this.pool.query<ContactMessageRow>(
      `SELECT m.id, m.sent_at, m.sender_id,
              COALESCE(m.sender_name, gm.name) AS sender_name,
              m.body, m.message_type,
              g.id AS group_id, g.name AS group_name
       FROM messages m
       JOIN groups g ON g.chat_id = m.chat_id AND g.monitored = true
       JOIN unnest($1::text[]) AS a(alias)
         ON a.alias = regexp_replace(m.sender_id, ':.*@', '@')
       LEFT JOIN LATERAL (
         SELECT COALESCE(o.name, member.name) AS name
         FROM group_members member
         LEFT JOIN contact_overrides o
           ON o.contact_id = COALESCE(member.phone, member.user_id)
         WHERE member.chat_id = m.chat_id
           AND (
             member.user_id = regexp_replace(m.sender_id, ':.*@', '@')
             OR member.phone = regexp_replace(m.sender_id, ':.*@', '@')
           )
         ORDER BY (member.user_id = regexp_replace(m.sender_id, ':.*@', '@')) DESC
         LIMIT 1
       ) gm ON true
       WHERE ($2::timestamptz IS NULL OR m.sent_at >= $2)
         AND ($3::timestamptz IS NULL OR m.sent_at < $3)
         AND ($4::timestamptz IS NULL OR
              (m.sent_at, m.id) < ($4::timestamptz, $5::uuid))
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT $6`,
      [
        aliases,
        options.from === undefined ? null : new Date(options.from),
        options.to === undefined ? null : new Date(options.to),
        cursor === undefined ? null : new Date(cursor.sentAt),
        cursor === undefined ? null : cursor.id,
        options.limit,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sentAt: row.sent_at.toISOString(),
      senderId: row.sender_id ?? "unknown",
      senderName: row.sender_name,
      body: row.body,
      messageType: row.message_type,
      groupId: row.group_id,
      groupName: row.group_name,
    })) as ContactMessage[];
  }

  private toContactSummary(row: ContactRow): ContactSummary {
    return {
      id: row.contact_key,
      name: row.name,
      phone: row.phone,
      groups: [...(row.groups ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      messageCount: row.message_count,
      lastMessageAt:
        row.last_message_at === null
          ? null
          : row.last_message_at.toISOString(),
    };
  }

  async listGroupSummaries(
    groupId: string,
    options: { limit: number },
  ): Promise<GroupSummary[]> {
    const result = await this.pool.query<
      SummaryRow & {
        start_at: Date;
        end_at: Date;
        timezone: string;
      }
    >(
      `SELECT s.id, s.run_id, s.provider, s.model, s.result, s.created_at,
              r.start_at, r.end_at, r.timezone
       FROM summaries s
       JOIN summary_runs r ON r.id = s.run_id
       WHERE r.group_id = $1
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $2`,
      [groupId, options.limit],
    );
    return result.rows.map((row) =>
      GroupSummary.parse({
        id: row.id,
        runId: row.run_id,
        provider: row.provider,
        model: row.model,
        result: row.result,
        createdAt: row.created_at.toISOString(),
        interval: {
          start: row.start_at.toISOString(),
          end: row.end_at.toISOString(),
          timezone: row.timezone,
        },
      }),
    );
  }
}
