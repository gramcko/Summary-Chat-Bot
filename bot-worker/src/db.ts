import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { NewMessage } from "./normalize.js";
import type {
  DiscoveredChat,
  HistoryCursor,
  SessionCheckResult,
} from "./whatsapp/adapter.js";

/**
 * bot-worker's own thin PostgreSQL access layer (architecture §4.3/§4.5,
 * ADR 0004). Deliberately NOT the backend's Store: bot-worker is an
 * independent service and depends only on the database schema. All SQL
 * is parameterized; values are never interpolated into query strings.
 *
 * Ingestion idempotency is enforced by the database constraint
 * UNIQUE(connection_id, chat_id, whatsapp_message_id): duplicate
 * deliveries hit ON CONFLICT DO NOTHING and count as already captured
 * (architecture §5.1).
 */

/**
 * Connection states persisted in `whatsapp_connections.state`. Mirrors
 * the CHECK constraint in backend/migrations/0001 and the
 * `ConnectionState` enum in @summarly/contracts/connection.ts (kept as a
 * local type on purpose: the bot-worker does not depend on the API
 * contract package).
 */
export type ConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "unavailable";

export interface InsertMessagesResult {
  inserted: number;
  /** Duplicate deliveries already captured by an earlier insert. */
  duplicates: number;
  /**
   * Rows for chats that were not monitored at INSERT time and were
   * refused by the database-level privacy boundary (see insertMessages).
   */
  droppedUnmonitored: number;
}

/** A claimed history import (ADR 0007). */
export interface HistoryImportClaim {
  groupId: string;
  chatJid: string;
  requestedAt: Date;
  /** Claim timestamp; guards completion against stale/older claims. */
  startedAt: Date;
}

/** A pending session health check (ADR 0008 follow-up). */
export interface SessionCheckClaim {
  connectionId: string;
  requestedAt: Date;
}

export interface HistoryImportOutcome {
  /** `done` = completed within budget (partial by design); `failed`. */
  status: "done" | "failed";
  /** Messages INSERTED by this import (duplicates do not count). */
  importedCount: number;
  /** Safe code/short message only; null on success. */
  error: string | null;
}

/**
 * The current linking payload (QR or pairing code) with its expiry and
 * KIND (ADR 0008, CR#6). `qr` is a LIVE PAIRING TICKET: stored for the
 * authenticated API only and never logged.
 */
export interface LinkingPayload {
  qr: string;
  expiresAt: Date;
  kind: "qr" | "pairing-code";
}

/** One roster entry to upsert (ADR 0008, best-effort). */
export interface GroupMemberUpsert {
  userId: string;
  /** Push/contact name when known; null keeps any previously stored name. */
  name: string | null;
  /**
   * Phone-number JID (`…@s.whatsapp.net`) when known; null keeps any
   * previously stored value. Fallback identifier for LID-only members.
   */
  phone: string | null;
  isAdmin: boolean;
}

export interface SyncMembersResult {
  upserted: number;
  /** Members marked inactive because they left the roster. */
  deactivated: number;
}

export interface UpsertChatsResult {
  inserted: number;
  updated: number;
}

export interface ChatDefaults {
  /** Time zone for NEW groups only; never overwrites admin settings. */
  timezone: string;
}

export interface InsertMessagesOptions {
  /**
   * Whether the insert may update `whatsapp_connections.last_message_at`
   * (default true). History imports pass false: imported messages are
   * historical and must not masquerade as live traffic (ADR 0007).
   */
  touchLastMessage?: boolean;
}

export interface BotDb {
  /**
   * Returns the id of the single linked-session row
   * (`whatsapp_connections`), creating it on first use.
   */
  ensureConnection(): Promise<string>;
  /** Persists a connection-state transition (updates state and since). */
  setConnectionState(connectionId: string, state: ConnectionState): Promise<void>;
  /** Subset of `chatJids` whose group row exists and is monitored. */
  filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>>;
  /** Idempotent batch insert; returns inserted vs already-captured counts. */
  insertMessages(
    connectionId: string,
    rows: NewMessage[],
    options?: InsertMessagesOptions,
  ): Promise<InsertMessagesResult>;
  /**
   * Privacy-first discovery upsert (ADR 0004): inserts NEW groups with
   * monitored = false and the default time zone; on an existing chat_id
   * ONLY the name is updated — monitored, timezone, summary_time, and id
   * are never clobbered.
   */
  upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult>;

  /**
   * Global default IANA time zone from `app_settings` (used for NEW
   * groups). Null when the setting/table is unavailable — the caller
   * falls back to its env default.
   */
  getDefaultTimezone(): Promise<string | null>;

  /**
   * Oldest captured message of a chat, used as the FIRST paging anchor
   * for on-demand history (ADR 0007). WhatsApp's
   * `historySyncOnDemandRequest` requires a real message key; a request
   * without one is silently ignored (observed as `history_timeout`).
   * Null when the chat has no captured messages yet. The oldest row's
   * `fromMe` flag is preserved so the history anchor matches WhatsApp's
   * expectation for own messages.
   */
  getOldestMessageCursor(chatId: string): Promise<HistoryCursor | null>;

  // ---- History imports (ADR 0007) ----

  /**
   * Atomically claims up to `limit` groups with
   * `history_import_status = 'pending'` that are ALSO `monitored`
   * (privacy boundary, SQL-enforced) and have a linked chat. Sets them
   * `running` with `started_at = now()` and returns the claims. Uses
   * FOR UPDATE SKIP LOCKED, so concurrent claimers never double-claim.
   */
  claimPendingHistoryImports(limit?: number): Promise<HistoryImportClaim[]>;
  /**
   * Finishes a claimed import (`done`/`failed` with counts and a safe
   * error code). Guarded by the claim's `started_at` so a stale claim
   * can never overwrite a newer import's outcome.
   */
  completeHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    outcome: HistoryImportOutcome,
  ): Promise<boolean>;
  /**
   * Publishes incremental progress (the running inserted count) so the
   * dashboard can render "N imported so far" before the terminal state
   * (CR-M2). Guarded exactly like completion (`running` + `started_at`
   * fence): a stale claim never overwrites a newer import's progress.
   */
  updateHistoryImportProgress(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    importedCount: number,
  ): Promise<boolean>;
  /**
   * Stale-claim recovery: `running` imports whose `started_at` is older
   * than `olderThanMs` (a crashed worker) go back to `pending` so they
   * can be claimed again. The staleness comparison runs in SQL against
   * the DATABASE clock (SA-L1) — never the worker clock — so clock skew
   * cannot requeue an active import. Returns how many rows were
   * requeued.
   */
  requeueStaleHistoryImports(olderThanMs: number): Promise<number>;
  /**
   * Graceful-shutdown release: the claim goes back to `pending`
   * immediately (guarded by `started_at`). Returns true when released.
   */
  releaseHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
  ): Promise<boolean>;

  // ---- Session control and roster (ADR 0008) ----

  /**
   * Publishes the current linking QR/pairing payload on the single
   * connection row, REPLACING any previous one (a new QR always
   * supersedes the old). The value is a live pairing ticket: stored for
   * the authenticated API, never logged. The payload's `kind`
   * (`qr` | `pairing-code`) is published alongside it (CR#6).
   */
  setLinkingQr(connectionId: string, payload: LinkingPayload): Promise<void>;
  /** Clears the linking payload (connected / logged out / session lost). */
  clearLinkingQr(connectionId: string): Promise<void>;
  /**
   * Opportunistic cleanup of EXPIRED linking payloads (CR#7): rows
   * whose `linking_qr_expires_at` is in the past lose the payload and
   * kind. Returns how many rows were cleared.
   */
  clearExpiredLinking(): Promise<number>;
  /**
   * Returns a pending session health check (requested by the backend)
   * or null. A check is pending when `session_check_requested_at` is set
   * and no later `session_check_checked_at` exists.
   */
  claimSessionCheck(): Promise<SessionCheckClaim | null>;
  /**
   * Writes the result of a claimed session check. Fenced by the claim's
   * `requestedAt` so a newer request is never overwritten by an older
   * probe. Returns true when the row was updated.
   */
  completeSessionCheck(
    claim: SessionCheckClaim,
    result: SessionCheckResult,
  ): Promise<boolean>;
  /**
   * Best-effort roster sync for ONE chat (ADR 0008): upserts the given
   * members as active (keeping a previously stored name when the new
   * one is missing) and marks members ABSENT from `members` as
   * active=false — never deletes. An EMPTY `members` list is a no-op:
   * missing metadata must never deactivate everyone. The MONITORED
   * boundary is enforced INSIDE the statement (EXISTS guard, H-1): a
   * chat that is not in `groups` with `monitored = true` syncs nothing.
   */
  syncGroupMembers(
    chatId: string,
    members: GroupMemberUpsert[],
  ): Promise<SyncMembersResult>;
  /**
   * Persists display names learned from WhatsApp contacts / message push
   * names (ADR 0008) on existing roster rows. Only rows in MONITORED
   * groups are touched (privacy boundary). Returns the updated row
   * count. Names are PII and never logged by the caller.
   */
  updateGroupMemberNames(
    entries: ReadonlyArray<{ jids: string[]; name: string }>,
  ): Promise<number>;
  /**
   * Atomically consumes the admin logout request (reads and clears
   * `logout_requested_at`); returns the request time, or null when no
   * request is pending.
   */
  consumeLogoutRequest(): Promise<Date | null>;
  /**
   * Terminal logout state (ADR 0008): state `unavailable` and linking
   * payload cleared. `last_message_at` is deliberately KEPT (it is
   * historical fact) and `logout_requested_at` is already consumed.
   */
  finalizeLogout(connectionId: string): Promise<void>;
}

type ConnectionRow = QueryResultRow & { id: string };
type ChatIdRow = QueryResultRow & { chat_id: string };
type InsertCountRow = QueryResultRow & { inserted: boolean };

/** Rows per INSERT statement (7 params each; stays far below limits). */
const INSERT_CHUNK = 200;

export class PostgresBotDb implements BotDb {
  constructor(private readonly pool: Pool) {}

  async ensureConnection(): Promise<string> {
    // The table has a single-row unique index; ON CONFLICT DO NOTHING
    // (no target: matches the expression index) makes concurrent starts
    // race-safe — the loser falls through to the SELECT.
    const inserted = await this.pool.query<ConnectionRow>(
      "INSERT INTO whatsapp_connections (state) VALUES ('connecting') " +
        "ON CONFLICT DO NOTHING RETURNING id",
    );
    const row = inserted.rows[0];
    if (row !== undefined) return row.id;
    const selected = await this.pool.query<ConnectionRow>(
      "SELECT id FROM whatsapp_connections LIMIT 1",
    );
    const existing = selected.rows[0];
    if (existing === undefined) {
      throw new Error("ensureConnection inserted nothing and found nothing");
    }
    return existing.id;
  }

  async setConnectionState(
    connectionId: string,
    state: ConnectionState,
  ): Promise<void> {
    // `since` marks when the current state started (contracts
    // ConnectionStatus). updated_at keeps the row auditable.
    await this.pool.query(
      "UPDATE whatsapp_connections SET state = $2, since = now(), " +
        "updated_at = now() WHERE id = $1",
      [connectionId, state],
    );
  }

  async filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>> {
    if (chatJids.length === 0) return new Set();
    const result = await this.pool.query<ChatIdRow>(
      "SELECT chat_id FROM groups WHERE monitored = true AND chat_id = ANY($1::text[])",
      [chatJids],
    );
    return new Set(result.rows.map((row) => row.chat_id));
  }

  async insertMessages(
    connectionId: string,
    rows: NewMessage[],
    options: InsertMessagesOptions = {},
  ): Promise<InsertMessagesResult> {
    const touchLastMessage = options.touchLastMessage !== false;
    if (rows.length === 0) {
      return { inserted: 0, duplicates: 0, droppedUnmonitored: 0 };
    }
    const client = await this.pool.connect();
    let inserted = 0;
    let monitoredNow = 0;
    try {
      await client.query("BEGIN");
      // Counting aid ONLY (not the privacy boundary): which chats are
      // monitored right now, for accurate log counts. Enforcement is the
      // EXISTS clause inside the INSERT below (CR-M2/audit M4: the row
      // must not depend on an earlier filter that could be stale).
      const monitoredResult = await client.query<{ chat_id: string }>(
        "SELECT chat_id FROM groups WHERE monitored = true AND chat_id = ANY($1::text[])",
        [[...new Set(rows.map((row) => row.chatJid))]],
      );
      const monitoredSet = new Set(
        monitoredResult.rows.map((row) => row.chat_id),
      );
      monitoredNow = rows.filter((row) => monitoredSet.has(row.chatJid)).length;

      for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
        const chunk = rows.slice(offset, offset + INSERT_CHUNK);
        const values: unknown[] = [connectionId];
        const tuples: string[] = [];
        let param = 2;
        for (const row of chunk) {
          tuples.push(
            `($1::uuid, $${param}::text, $${param + 1}::text, $${param + 2}::text, $${param + 3}::text, $${param + 4}::timestamptz, $${param + 5}::text, $${param + 6}::text, $${param + 7}::boolean)`,
          );
          values.push(
            row.chatJid,
            row.whatsappMessageId,
            row.senderJid,
            row.senderName,
            row.sentAt,
            row.body,
            row.messageType,
            row.fromMe,
          );
          param += 8;
        }
        // Privacy boundary INSIDE the write (audit M4): a row is only
        // inserted when its chat is currently monitored — even if the
        // caller's earlier filter said otherwise (a group unmonitored
        // between filter and insert is never written).
        const result = await client.query(
          `INSERT INTO messages
             (connection_id, chat_id, whatsapp_message_id, sender_id, sender_name, sent_at, body, message_type, from_me)
           SELECT t.connection_id, t.chat_id, t.whatsapp_message_id,
                  t.sender_id, t.sender_name, t.sent_at, t.body, t.message_type, t.from_me
           FROM (VALUES ${tuples.join(", ")}) AS t
             (connection_id, chat_id, whatsapp_message_id, sender_id, sender_name, sent_at, body, message_type, from_me)
           WHERE EXISTS (
             SELECT 1 FROM groups g
             WHERE g.chat_id = t.chat_id AND g.monitored = true
           )
           ON CONFLICT (connection_id, chat_id, whatsapp_message_id) DO NOTHING`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
      if (inserted > 0 && touchLastMessage) {
        // Operational metadata only: when the latest LIVE captured
        // message happened (contracts ConnectionStatus.lastMessageAt).
        // Historical imports skip this — they must not masquerade as
        // live traffic (ADR 0007).
        const newest = rows.reduce(
          (max, row) => (row.sentAt > max ? row.sentAt : max),
          rows[0]!.sentAt,
        );
        await client.query(
          "UPDATE whatsapp_connections SET " +
            "last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), " +
            "updated_at = now() WHERE id = $1",
          [connectionId, newest],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    // Counting note: rows refused by the EXISTS clause in a race window
    // (unmonitored between the counting aid and the INSERT) are counted
    // as duplicates; counts feed logs only, the data outcome is exact.
    const droppedUnmonitored = rows.length - monitoredNow;
    const duplicates = Math.max(0, monitoredNow - inserted);
    return { inserted, duplicates, droppedUnmonitored };
  }

  async upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult> {
    // One row per chat: a repeated chatJid in the input would make
    // ON CONFLICT DO UPDATE fail ("cannot affect row a second time").
    const byJid = new Map<string, string>();
    for (const chat of chats) {
      if (chat.chatJid !== "") byJid.set(chat.chatJid, chat.name);
    }
    const entries = [...byJid.entries()];
    if (entries.length === 0) return { inserted: 0, updated: 0 };

    let inserted = 0;
    let updated = 0;
    for (let offset = 0; offset < entries.length; offset += INSERT_CHUNK) {
      const chunk = entries.slice(offset, offset + INSERT_CHUNK);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let param = 1;
      for (const [chatJid, name] of chunk) {
        // groups.id has no database default (ADR 0004): generate uuids
        // at insert. NEW rows are opt-out of collection: monitored=false
        // and the DEFAULT_GROUP_TIMEZONE; the admin opts in per group in
        // the dashboard (AGENTS.md: minimize collection).
        tuples.push(`($${param}, $${param + 1}, $${param + 2}, false, $${param + 3}, NULL)`);
        values.push(randomUUID(), chatJid, name, defaults.timezone);
        param += 4;
      }
      // NEVER-clobber rule (ADR 0004, regression-tested): on an existing
      // chat_id ONLY the name is updated. monitored, timezone,
      // summary_time, and id keep whatever the admin configured.
      const result = await this.pool.query<InsertCountRow>(
        `INSERT INTO groups (id, chat_id, name, monitored, timezone, summary_time)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (chat_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        values,
      );
      for (const row of result.rows) {
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
    }
    return { inserted, updated };
  }

  async getDefaultTimezone(): Promise<string | null> {
    try {
      const result = await this.pool.query<{ default_timezone: string }>(
        "SELECT default_timezone FROM app_settings WHERE id = 1",
      );
      return result.rows[0]?.default_timezone ?? null;
    } catch (error) {
      // Older deployments may not have migration 0009 yet: fall back to
      // the env default instead of failing discovery.
      if ((error as { code?: string }).code === "42P01") return null;
      throw error;
    }
  }

  async getOldestMessageCursor(
    chatId: string,
  ): Promise<HistoryCursor | null> {
    // The on-demand history request must page BACK from a real message
    // key (Baileys README: "you need to have oldest message in chat").
    // An empty key is silently ignored by WhatsApp, which the import
    // service observes as a timeout.
    const result = await this.pool.query<{
      whatsapp_message_id: string;
      sent_at: Date;
      from_me: boolean;
    }>(
      `SELECT whatsapp_message_id, sent_at, from_me
       FROM messages
       WHERE chat_id = $1
       ORDER BY sent_at ASC, id ASC
       LIMIT 1`,
      [chatId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      messageId: row.whatsapp_message_id,
      fromMe: row.from_me,
      timestampSec: Math.floor(row.sent_at.getTime() / 1000),
    };
  }

  // ---- History imports (ADR 0007) ----

  async claimPendingHistoryImports(
    limit = 1,
  ): Promise<HistoryImportClaim[]> {
    // Atomic claim (single statement, FOR UPDATE SKIP LOCKED in the
    // subselect): concurrent claimers pick disjoint rows. The privacy
    // boundary is IN the WHERE clause — an unmonitored group is never
    // claimed even if a pending request exists (its status stays
    // 'pending' until the admin opts the group in).
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      history_import_requested_at: Date | null;
      history_import_started_at: Date;
    }>(
      // date_trunc('milliseconds') keeps the timestamp exactly
      // round-trippable through JavaScript Dates (which have ms, not µs,
      // precision) — completion/release match on this value as the
      // claim guard.
      `UPDATE groups
       SET history_import_status = 'running',
           history_import_started_at = date_trunc('milliseconds', now()),
           updated_at = now()
       WHERE id IN (
         SELECT id FROM groups
         WHERE history_import_status = 'pending'
           AND monitored = true
           AND chat_id IS NOT NULL
         ORDER BY history_import_requested_at ASC NULLS LAST
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, chat_id, history_import_requested_at, history_import_started_at`,
      [Math.max(1, Math.floor(limit))],
    );
    return result.rows.map((row) => ({
      groupId: row.id,
      chatJid: row.chat_id,
      requestedAt: row.history_import_requested_at ?? row.history_import_started_at,
      startedAt: row.history_import_started_at,
    }));
  }

  async completeHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    outcome: HistoryImportOutcome,
  ): Promise<boolean> {
    // The started_at guard makes completion idempotent-safe against
    // stale claims: a released/requeued import that was re-claimed has
    // a newer started_at and this write becomes a no-op.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = $2,
           history_import_finished_at = now(),
           history_import_imported_count = $3,
           history_import_error = $4,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $5`,
      [
        claim.groupId,
        outcome.status,
        Math.max(0, Math.floor(outcome.importedCount)),
        outcome.error === null ? null : outcome.error.slice(0, 200),
        claim.startedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateHistoryImportProgress(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    importedCount: number,
  ): Promise<boolean> {
    // Same fence as completion (CR-M2): stale claims never overwrite a
    // newer import's progress.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_imported_count = $2,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $3`,
      [
        claim.groupId,
        Math.max(0, Math.floor(importedCount)),
        claim.startedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async requeueStaleHistoryImports(olderThanMs: number): Promise<number> {
    // Crash recovery (ADR 0007): a 'running' claim whose worker died is
    // re-claimable after the staleness threshold. The comparison runs
    // against the DATABASE clock (make_interval + now(), SA-L1) so
    // worker/DB clock skew can never requeue a live import.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = 'pending',
           history_import_started_at = NULL,
           updated_at = now()
       WHERE history_import_status = 'running'
         AND history_import_started_at < now() - make_interval(secs => $1::double precision)`,
      [Math.max(0, olderThanMs) / 1000],
    );
    return result.rowCount ?? 0;
  }

  async releaseHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
  ): Promise<boolean> {
    // Graceful shutdown: hand the claim back immediately so the next
    // start picks it up without waiting for the staleness threshold.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = 'pending',
           history_import_started_at = NULL,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $2`,
      [claim.groupId, claim.startedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Session control and roster (ADR 0008) ----

  async setLinkingQr(
    connectionId: string,
    payload: LinkingPayload,
  ): Promise<void> {
    // A new payload REPLACES any previous one (a fresh QR supersedes an
    // expired one). The value is a live pairing ticket — it is written
    // for the authenticated API and must never be logged.
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET linking_qr = $2, linking_qr_expires_at = $3, linking_kind = $4,
           updated_at = now()
       WHERE id = $1`,
      [connectionId, payload.qr, payload.expiresAt, payload.kind],
    );
  }

  async clearLinkingQr(connectionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET linking_qr = NULL, linking_qr_expires_at = NULL,
           linking_kind = NULL, updated_at = now()
       WHERE id = $1`,
      [connectionId],
    );
  }

  async clearExpiredLinking(): Promise<number> {
    // Opportunistic cleanup on the session-control tick (CR#7): a
    // payload past its expiry must not linger as a stale ticket.
    const result = await this.pool.query(
      `UPDATE whatsapp_connections
       SET linking_qr = NULL, linking_qr_expires_at = NULL,
           linking_kind = NULL, updated_at = now()
       WHERE linking_qr_expires_at IS NOT NULL
         AND linking_qr_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async claimSessionCheck(): Promise<SessionCheckClaim | null> {
    const result = await this.pool.query<{
      id: string;
      session_check_requested_at: Date;
    }>(
      `SELECT id, session_check_requested_at
       FROM whatsapp_connections
       WHERE session_check_requested_at IS NOT NULL
         AND (
           session_check_checked_at IS NULL
           OR session_check_checked_at < session_check_requested_at
         )
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      connectionId: row.id,
      requestedAt: row.session_check_requested_at,
    };
  }

  async completeSessionCheck(
    claim: SessionCheckClaim,
    result: SessionCheckResult,
  ): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE whatsapp_connections
       SET session_check_checked_at = now(),
           session_check_ok = $2,
           session_check_latency_ms = $3,
           session_check_error = $4,
           updated_at = now()
       WHERE id = $1
         AND date_trunc('milliseconds', session_check_requested_at) = $5`,
      [
        claim.connectionId,
        result.ok,
        result.latencyMs,
        result.error === null ? null : result.error.slice(0, 200),
        claim.requestedAt,
      ],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async syncGroupMembers(
    chatId: string,
    members: GroupMemberUpsert[],
  ): Promise<SyncMembersResult> {
    // Dedupe by user id (last wins): ON CONFLICT DO UPDATE cannot
    // touch the same row twice in one statement.
    const byUser = new Map<string, GroupMemberUpsert>();
    for (const member of members) {
      if (member.userId !== "") byUser.set(member.userId, member);
    }
    // An EMPTY roster is "no data", never "the group is empty" (ADR
    // 0008): skip the sync entirely so missing metadata can never
    // deactivate every member.
    if (byUser.size === 0) return { upserted: 0, deactivated: 0 };

    const userIds = [...byUser.keys()];
    const values: unknown[] = [chatId, userIds];
    const tuples: string[] = [];
    let param = 3;
    for (const [userId, member] of byUser) {
      tuples.push(
        `($${param}::text, $${param + 1}::text, $${param + 2}::text, $${param + 3}::boolean)`,
      );
      values.push(userId, member.name, member.phone, member.isAdmin);
      param += 4;
    }
    // ONE statement (CR#8): upsert and deactivation share a snapshot,
    // so no observer can see the transient "everyone active" window the
    // two-statement version exposed (and a crash between them could
    // leave a half-synced roster).
    //
    // The MONITORED boundary is enforced INSIDE the statement (H-1):
    // both halves only run when the chat is currently in `groups` with
    // monitored = true — unmonitored (or unknown) chats sync nothing,
    // whatever the caller believed.
    const result = await this.pool.query<{
      upserted: number;
      deactivated: number;
    }>(
      `WITH guarded AS (
         SELECT 1 AS ok
         WHERE EXISTS (
           SELECT 1 FROM groups g WHERE g.chat_id = $1 AND g.monitored = true
         )
       ),
       upserted AS (
         INSERT INTO group_members (id, chat_id, user_id, name, phone, is_admin, active, updated_at)
         SELECT gen_random_uuid(), $1, v.user_id, v.name, v.phone, v.is_admin, true, now()
         FROM (VALUES ${tuples.join(", ")}) AS v(user_id, name, phone, is_admin)
         WHERE EXISTS (SELECT 1 FROM guarded)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, group_members.name),
           phone = COALESCE(EXCLUDED.phone, group_members.phone),
           is_admin = EXCLUDED.is_admin,
           active = true,
           updated_at = now()
         RETURNING 1
       ),
       deactivated AS (
         UPDATE group_members gm
         SET active = false, updated_at = now()
         WHERE gm.chat_id = $1
           AND gm.active = true
           AND NOT (gm.user_id = ANY($2::text[]))
           AND EXISTS (SELECT 1 FROM guarded)
         RETURNING 1
       )
       SELECT
         (SELECT count(*)::int FROM upserted) AS upserted,
         (SELECT count(*)::int FROM deactivated) AS deactivated`,
      values,
    );
    return {
      upserted: result.rows[0]?.upserted ?? 0,
      deactivated: result.rows[0]?.deactivated ?? 0,
    };
  }

  async updateGroupMemberNames(
    entries: ReadonlyArray<{ jids: string[]; name: string }>,
  ): Promise<number> {
    // Flatten aliases -> name rows, dedupe by alias (last name wins) and
    // clamp to the contract cap. Names are PII: nothing here is logged.
    const byJid = new Map<string, string>();
    for (const entry of entries) {
      const name = entry.name.trim().slice(0, 300);
      if (name === "") continue;
      for (const jid of entry.jids) {
        if (jid !== "") byJid.set(jid, name);
      }
    }
    if (byJid.size === 0) return 0;

    const rows = [...byJid.entries()];
    let updated = 0;
    // Bounded chunks keep the parameter count small on large contact
    // syncs (two arrays per chunk, no per-row parameters).
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      const result = await this.pool.query(
        `WITH incoming AS (
           SELECT unnest($1::text[]) AS user_id, unnest($2::text[]) AS name
         )
         UPDATE group_members gm
         SET name = incoming.name, updated_at = now()
         FROM incoming, groups g
         WHERE gm.user_id = incoming.user_id
           AND g.chat_id = gm.chat_id
           AND g.monitored = true
           AND gm.name IS DISTINCT FROM incoming.name`,
        [chunk.map(([jid]) => jid), chunk.map(([, name]) => name)],
      );
      updated += result.rowCount ?? 0;
    }
    return updated;
  }

  async consumeLogoutRequest(): Promise<Date | null> {
    // Atomic read-and-clear: the request is consumed exactly once even
    // if the logout work below crashes (the admin can re-request; the
    // flow is idempotent). RETURNING may reference the FROM-list's
    // pre-update value to report when the request was made.
    const result = await this.pool.query<{ requested_at: Date }>(
      `WITH prev AS (
         SELECT id, logout_requested_at AS requested_at
         FROM whatsapp_connections
         WHERE logout_requested_at IS NOT NULL
         LIMIT 1
       )
       UPDATE whatsapp_connections w
       SET logout_requested_at = NULL, updated_at = now()
       FROM prev
       WHERE w.id = prev.id
       RETURNING prev.requested_at`,
    );
    return result.rows[0]?.requested_at ?? null;
  }

  async finalizeLogout(connectionId: string): Promise<void> {
    // Terminal logout state: `unavailable`, linking payload (and kind)
    // gone. last_message_at is deliberately KEPT — it is historical fact.
    await this.pool.query(
      `UPDATE whatsapp_connections
       SET state = 'unavailable', since = now(),
           linking_qr = NULL, linking_qr_expires_at = NULL,
           linking_kind = NULL,
           updated_at = now()
       WHERE id = $1`,
      [connectionId],
    );
  }
}
