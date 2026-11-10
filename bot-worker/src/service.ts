import { reconnectDelayMs } from "./backoff.js";
import type { BackoffPolicy } from "./config.js";
import type { BotDb, ConnectionState } from "./db.js";
import { errorReason } from "./lib/errors.js";
import { normalizeJidAlias } from "./lib/jid.js";
import type { LogFields, Logger } from "./lib/log.js";
import { safeChatRef } from "./lib/privacy.js";
import {
  normalizeMessage,
  SKIP_REASONS,
  type NewMessage,
  type SkipReason,
} from "./normalize.js";
import type {
  AdapterEvent,
  GroupMemberInfo,
  RawInboundMessage,
  WhatsAppAdapter,
} from "./whatsapp/adapter.js";
import {
  LINKING_QR_TTL_MS,
  PAIRING_CODE_TTL_MS,
} from "./whatsapp/adapter.js";

/**
 * Capture orchestration (architecture §4.3/§5.1, ADR 0004): maps
 * adapter connection events to `whatsapp_connections` rows, runs
 * privacy-first group discovery, and persists incoming group messages
 * idempotently. Everything here is testable with a fake adapter and a
 * fake (or real) database — no WhatsApp account is ever required.
 *
 * Connection state machine:
 *
 *   connecting  — a socket is being established (also during linking)
 *   connected   — the WhatsApp connection is open
 *   disconnected — transiently closed; a capped exponential backoff
 *                  reconnect is scheduled
 *   lost-logged-out — terminal: session revoked/replaced/invalid; no
 *                  more reconnects, a re-link is required (persisted as
 *                  state "unavailable")
 */

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "lost-logged-out";

export const STATUS_TO_DB: Record<SessionStatus, ConnectionState> = {
  connecting: "connecting",
  connected: "connected",
  disconnected: "disconnected",
  "lost-logged-out": "unavailable",
};

/** Linking material handed to the presenter (terminal). Never logged. */
export type LinkingInfo =
  | { kind: "qr"; qr: string }
  | { kind: "pairing-code"; code: string };

export interface CaptureServiceOptions {
  adapter: WhatsAppAdapter;
  db: BotDb;
  log: Logger;
  /** IANA time zone for newly discovered groups (DEFAULT_GROUP_TIMEZONE). */
  defaultTimezone: string;
  backoff: BackoffPolicy;
  /** Back-pressure limits; defaults to DEFAULT_CAPTURE_LIMITS. */
  limits?: Partial<CaptureLimits>;
  /** Linking UX callback (prints QR / pairing code); never a logger. */
  onLinking?: (linking: LinkingInfo) => void;
}

/** Safe error summary for logs: truncated driver text, nothing else. */
export const safeReason = errorReason;

/**
 * Linking-payload TTLs (defined on the adapter contract so the Baileys
 * adapter's pairing-flow re-arm uses the same expiry as the published
 * payload, CR#6). Re-exported here for the service's callers/tests.
 */
export { LINKING_QR_TTL_MS, PAIRING_CODE_TTL_MS };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture back-pressure limits (CR-M2 / audit L4). The in-memory queue
 * is bounded and failed batches are retried a bounded number of times —
 * re-inserts are idempotent via ON CONFLICT, so retrying is always safe.
 */
export interface CaptureLimits {
  /** Maximum queued raw messages; overflow drops the NEWEST (counted). */
  queueCap: number;
  /** Attempts per batch (1 initial + retries) before it is dropped. */
  maxBatchAttempts: number;
  /** Linear backoff base between batch retries. */
  batchRetryBaseMs: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  queueCap: 5000,
  maxBatchAttempts: 3,
  batchRetryBaseMs: 50,
};

export class CaptureService {
  private readonly adapter: WhatsAppAdapter;
  private readonly db: BotDb;
  private readonly log: Logger;
  private readonly defaultTimezone: string;
  private readonly backoff: BackoffPolicy;
  private readonly limits: CaptureLimits;
  private readonly onLinking: ((linking: LinkingInfo) => void) | undefined;
  private readonly unsubscribe: () => void;

  private status: SessionStatus = "disconnected";
  private connectionId: string | null = null;
  private attempt = 0;
  private stopped = true;
  private sessionLost = false;
  /** Admin logout in progress: no state writes, no reconnects (ADR 0008). */
  private loggingOut = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serializes async event processing (ordering: open before close...). */
  private chain: Promise<void> = Promise.resolve();
  /** Pending messages; bursts coalesce into one batched insert. */
  private messageQueue: RawInboundMessage[] = [];
  private drainPromise: Promise<void> | null = null;

  constructor(options: CaptureServiceOptions) {
    this.adapter = options.adapter;
    this.db = options.db;
    this.log = options.log;
    this.defaultTimezone = options.defaultTimezone;
    this.backoff = options.backoff;
    this.limits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
    this.onLinking = options.onLinking;
    this.unsubscribe = options.adapter.subscribe((event) => this.onEvent(event));
  }

  /** Current status (for tests and status reporting). */
  get sessionStatus(): SessionStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.sessionLost = false;
    this.attempt = 0;
    this.connectionId = await this.db.ensureConnection();
    this.log("info", "connection_registered", {
      connectionId: this.connectionId,
    });
    await this.doConnect();
  }

  /**
   * Graceful shutdown: stop reconnecting, close the socket (the adapter
   * saves its auth state), let in-flight batches persist, then mark the
   * connection disconnected. A lost session stays "unavailable".
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.unsubscribe();
    try {
      await this.adapter.disconnect();
    } catch (error) {
      this.log("error", "disconnect_failed", { reason: safeReason(error) });
    }
    await this.idle();
    if (this.status !== "lost-logged-out") {
      await this.setStatus("disconnected");
    }
    this.log("info", "capture_stopped", {});
  }

  /** Resolves when all queued events and batches are fully processed. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      const drain = this.drainPromise;
      await chain;
      if (drain !== null) await drain;
      if (this.chain === chain && this.drainPromise === drain) return;
    }
  }

  /**
   * Admin logout in progress (ADR 0008): stops reconnect attempts and
   * freezes connection-state writes so the session-control flow's final
   * `unavailable` write is the last word. Idempotent.
   */
  beginLogout(): void {
    this.loggingOut = true;
    this.sessionLost = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.log("info", "logout_beginning", {});
  }

  /**
   * Re-arms linking after an admin logout (CR-M1): the teardown latches
   * must not make "link a device again" a lie — reset them, reconnect
   * the adapter (a fresh session state presents a new QR through the
   * normal flow within one poll), and let state writes flow again.
   * Idempotent; a stopped service stays stopped.
   */
  async rearm(): Promise<void> {
    if (this.stopped) return;
    this.loggingOut = false;
    this.sessionLost = false;
    this.attempt = 0;
    this.log("info", "session_rearmed", {});
    await this.doConnect();
  }

  // ------------------------------------------------------------------
  // Event routing
  // ------------------------------------------------------------------

  private onEvent(event: AdapterEvent): void {
    if (event.type === "history") {
      // On-demand batches are consumed by HistoryImportService, which
      // has its own subscription. Connect-time ("initial") batches are
      // the opt-in full-history backfill: persist monitored groups only.
      if (event.origin === "initial") {
        this.enqueue(() => this.ingestInitialHistory(event));
      }
      return;
    }
    if (event.type === "messages") {
      // Bounded queue (audit L4): on overflow the NEWEST messages are
      // dropped (already-queued work is older and closer to being
      // persisted); every drop is counted.
      const room = this.limits.queueCap - this.messageQueue.length;
      if (event.messages.length > room) {
        const dropped = event.messages.length - Math.max(room, 0);
        this.log("warn", "messages_dropped_overflow", {
          count: dropped,
          queued: this.messageQueue.length,
          queueCap: this.limits.queueCap,
        });
        if (room > 0) {
          this.messageQueue.push(...event.messages.slice(0, room));
        }
      } else {
        this.messageQueue.push(...event.messages);
      }
      this.scheduleDrain();
      return;
    }
    this.enqueue(() => this.processEvent(event));
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error) => {
      this.log("error", "event_handler_failed", { reason: safeReason(error) });
    });
  }

  private async processEvent(event: AdapterEvent): Promise<void> {
    switch (event.type) {
      case "connecting":
        await this.setStatus("connecting");
        break;
      case "open":
        this.attempt = 0;
        await this.setStatus("connected");
        // Linking finished: the pairing ticket must not linger (ADR 0008).
        await this.clearLinking();
        await this.runDiscovery();
        break;
      case "qr":
        // The QR / pairing code is linkable authentication material: it
        // is shown by the presenter and PUBLISHED for the authenticated
        // dashboard, never passed to the logger (ADR 0008).
        this.log("info", "linking_qr_pending", {});
        await this.publishLinking(event.qr, LINKING_QR_TTL_MS, "qr");
        this.onLinking?.({ kind: "qr", qr: event.qr });
        break;
      case "pairing-code":
        this.log("info", "linking_pairing_code_pending", {});
        await this.publishLinking(event.code, PAIRING_CODE_TTL_MS, "pairing-code");
        this.onLinking?.({ kind: "pairing-code", code: event.code });
        break;
      case "close":
        await this.handleClose(event);
        break;
      case "chat-updated":
        await this.db.upsertDiscoveredChats([event.chat], {
          timezone: this.defaultTimezone,
        });
        break;
      case "participants":
        await this.refreshRoster(event.chatJid);
        break;
      case "contact-names":
        await this.persistContactNames(event.contacts);
        break;
      case "messages":
        break; // routed through the message queue; never reaches here
    }
  }

  private async handleClose(event: {
    retryable: boolean;
    reason: string;
  }): Promise<void> {
    if (this.stopped || this.sessionLost) return;
    if (!event.retryable) {
      // Session revoked, replaced, corrupt, or the account restricted
      // (ADR 0004): stop retrying, mark the connection "unavailable",
      // and require a manual re-link. Session files are NEVER deleted
      // automatically here (the ADMIN logout control may delete them).
      this.sessionLost = true;
      await this.setStatus("lost-logged-out");
      await this.clearLinking();
      this.log("error", "session_lost_relink_required", {
        reason: event.reason,
        note:
          "The WhatsApp session is no longer valid (logged out, replaced, or " +
          "corrupt). Stop the bot-worker and link the account again (scan the " +
          "QR code or use a pairing code). Session files are not deleted " +
          "automatically — remove them manually before re-linking (ADR 0004). " +
          "Note: account_forbidden means WhatsApp restricts the ACCOUNT itself " +
          "— re-linking may not help while the restriction stands.",
      });
      return;
    }
    await this.setStatus("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.sessionLost) return;
    if (this.reconnectTimer !== null) return;
    this.attempt += 1;
    const delayMs = reconnectDelayMs(this.attempt, this.backoff);
    this.log("info", "reconnect_scheduled", {
      attempt: this.attempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.enqueue(() => this.doConnect());
    }, delayMs);
  }

  private async doConnect(): Promise<void> {
    if (this.stopped || this.sessionLost) return;
    await this.setStatus("connecting");
    // Race guard (CR): stop() may have completed while the status write
    // was in flight — do not open a connection after shutdown.
    if (this.stopped || this.sessionLost) return;
    try {
      await this.refreshHistoryCaptureChats();
      await this.adapter.connect();
    } catch (error) {
      this.log("error", "connect_failed", { reason: safeReason(error) });
      await this.setStatus("disconnected");
      this.scheduleReconnect();
      return;
    }
    // Race guard (CR): stop() raced connect() — close whatever the
    // adapter created late so no orphan socket survives shutdown.
    if (this.stopped) {
      try {
        await this.adapter.disconnect();
      } catch {
        // Already closed; nothing to release.
      }
    }
  }

  private async setStatus(status: SessionStatus): Promise<void> {
    // During an admin logout the session-control flow owns the final
    // state write (`unavailable`); nothing here may clobber it (0008).
    if (this.loggingOut) return;
    if (this.status === status) return;
    this.status = status;
    this.log("info", "connection_status", {
      status,
      dbState: STATUS_TO_DB[status],
    });
    if (this.connectionId !== null) {
      try {
        await this.db.setConnectionState(
          this.connectionId,
          STATUS_TO_DB[status],
        );
      } catch (error) {
        // A failed status write must never break reconnection handling.
        this.log("error", "status_persist_failed", {
          reason: safeReason(error),
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Discovery (privacy-first opt-in; ADR 0004)
  // ------------------------------------------------------------------

  private async runDiscovery(): Promise<void> {
    let chats: Array<{ chatJid: string; name: string; members: GroupMemberInfo[] }> = [];
    // NEW groups use the admin-configured default zone from Settings;
    // the env value is only a fallback for older/unmigrated databases.
    let timezone = this.defaultTimezone;
    try {
      timezone = (await this.db.getDefaultTimezone()) ?? timezone;
    } catch (error) {
      this.log("warn", "default_timezone_read_failed", {
        reason: safeReason(error),
      });
    }
    try {
      chats = await this.adapter.fetchChats();
      const result = await this.db.upsertDiscoveredChats(chats, {
        timezone,
      });
      this.log("info", "discovery_complete", {
        chats: chats.length,
        inserted: result.inserted,
        updated: result.updated,
      });
    } catch (error) {
      this.log("error", "discovery_failed", { reason: safeReason(error) });
      return;
    }
    // Roster sync (ADR 0008, best-effort): upsert the participants of
    // the discovered chats from the SAME metadata snapshot; members
    // absent from it are marked inactive (kept as history). Never fatal,
    // names optional. PRIVACY BOUNDARY (H-1): rosters sync only for
    // MONITORED groups — a group the admin has not opted in never has
    // its members collected (the SQL enforces the same rule).
    const chatJids = chats.map((chat) => chat.chatJid);
    const monitored =
      chatJids.length > 0 ? await this.db.filterMonitoredChatIds(chatJids) : new Set<string>();
    for (const chat of chats) {
      if (!monitored.has(chat.chatJid)) continue;
      await this.syncRoster(chat.chatJid, chat.members);
    }
    // Refresh the opt-in initial-history capture set (ADR 0007): only
    // monitored groups are ever eligible.
    await this.refreshHistoryCaptureChats();
  }

  /** Loads the monitored group set used by the full initial-sync mode. */
  private async refreshHistoryCaptureChats(): Promise<void> {
    try {
      const chatJids = await this.db.listMonitoredChatIds();
      this.adapter.setHistoryCaptureChats(new Set(chatJids));
    } catch (error) {
      this.log("warn", "history_capture_set_failed", {
        reason: safeReason(error),
      });
    }
  }

  /**
   * Persists a connect-time ("initial") history batch for monitored
   * groups only (opt-in `WA_HISTORY_SYNC=full`, ADR 0007). It uses the
   * same normalization and idempotent insert as live capture, but never
   * touches `last_message_at` (historical traffic is not live traffic).
   */
  private async ingestInitialHistory(
    event: Extract<AdapterEvent, { type: "history" }>,
  ): Promise<void> {
    if (event.messages.length === 0) return;
    const rows: NewMessage[] = [];
    for (const raw of event.messages) {
      const result = normalizeMessage(raw);
      if (result.action === "capture") rows.push(result.row);
    }
    if (rows.length === 0) return;
    const chatJids = [...new Set(rows.map((row) => row.chatJid))];
    const monitored = await this.db.filterMonitoredChatIds(chatJids);
    const kept = rows.filter((row) => monitored.has(row.chatJid));
    if (kept.length === 0) return;
    const connectionId =
      this.connectionId ?? (await this.db.ensureConnection());
    const result = await this.db.insertMessages(connectionId, kept, {
      touchLastMessage: false,
    });
    this.log("info", "history_initial_imported", {
      chatRef: safeChatRef(event.chatJid),
      received: event.messages.length,
      captured: kept.length,
      inserted: result.inserted,
      duplicates: result.duplicates,
    });
  }

  /** Upserts ONE chat's roster; empty rosters are "no data" (skipped). */
  private async syncRoster(
    chatJid: string,
    members: GroupMemberInfo[],
  ): Promise<void> {
    if (members.length === 0) return;
    try {
      const result = await this.db.syncGroupMembers(chatJid, members);
      this.log("debug", "members_synced", {
        chatRef: safeChatRef(chatJid),
        members: members.length,
        upserted: result.upserted,
        deactivated: result.deactivated,
      });
    } catch (error) {
      this.log("error", "roster_sync_failed", {
        chatRef: safeChatRef(chatJid),
        reason: safeReason(error),
      });
    }
  }

  /**
   * Persists display names learned from contacts / message push names
   * (ADR 0008). The DB write is restricted to monitored groups; names
   * are PII, so only the affected-row count is logged.
   */
  private async persistContactNames(
    contacts: ReadonlyArray<{ jids: string[]; name: string }>,
  ): Promise<void> {
    if (contacts.length === 0) return;
    try {
      const updated = await this.db.updateGroupMemberNames(contacts);
      if (updated > 0) {
        this.log("debug", "member_names_updated", { updated });
      }
    } catch (error) {
      // Best-effort like the roster sync: a name write must never break
      // the event chain.
      this.log("error", "member_names_update_failed", {
        reason: safeReason(error),
      });
    }
  }

  /** A participant event: refresh that chat's roster from metadata. */
  private async refreshRoster(chatJid: string): Promise<void> {
    // PRIVACY BOUNDARY (H-1): only MONITORED groups have their rosters
    // tracked — for an unmonitored chat there is nothing to sync and
    // nothing to fetch (the SQL would refuse it anyway).
    const monitored = await this.db.filterMonitoredChatIds([chatJid]);
    if (!monitored.has(chatJid)) return;
    let members: GroupMemberInfo[];
    try {
      members = await this.adapter.fetchRoster(chatJid);
    } catch (error) {
      // The contract says fetchRoster is best-effort; still guard so a
      // throwing implementation can never break the event chain.
      this.log("error", "roster_sync_failed", {
        chatRef: safeChatRef(chatJid),
        reason: safeReason(error),
      });
      return;
    }
    await this.syncRoster(chatJid, members);
  }

  /**
   * Publishes the linking payload for the authenticated dashboard
   * (ADR 0008). The value is a live pairing ticket — it is stored in
   * the DB row and NEVER logged (tests assert both sides). The `kind`
   * (qr | pairing-code) is published alongside it (CR#6).
   */
  private async publishLinking(
    payload: string,
    ttlMs: number,
    kind: "qr" | "pairing-code",
  ): Promise<void> {
    if (this.connectionId === null) return;
    try {
      await this.db.setLinkingQr(this.connectionId, {
        qr: payload,
        expiresAt: new Date(Date.now() + ttlMs),
        kind,
      });
    } catch (error) {
      this.log("error", "linking_publish_failed", { reason: safeReason(error) });
    }
  }

  private async clearLinking(): Promise<void> {
    if (this.connectionId === null) return;
    try {
      await this.db.clearLinkingQr(this.connectionId);
    } catch (error) {
      this.log("error", "linking_clear_failed", { reason: safeReason(error) });
    }
  }

  // ------------------------------------------------------------------
  // Message capture (architecture §5.1)
  // ------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.drainPromise !== null) return;
    // Deferred one microtask so a burst of synchronous event deliveries
    // coalesces into a single batched insert (architecture §5.1).
    this.drainPromise = Promise.resolve()
      .then(() => this.drainLoop())
      .catch((error) => {
        this.log("error", "message_drain_failed", {
          reason: safeReason(error),
        });
      })
      .finally(() => {
        this.drainPromise = null;
        // Lost-wakeup guard: messages that arrived between the final
        // empty check and the flag reset start a new drain.
        if (this.messageQueue.length > 0) this.scheduleDrain();
      });
  }

  private async drainLoop(): Promise<void> {
    while (this.messageQueue.length > 0) {
      // Everything queued while the previous batch was persisting is
      // coalesced into this batch (bursts → one insert).
      const batch = this.messageQueue.splice(0, this.messageQueue.length);
      await this.processBatchWithRetry(batch);
    }
  }

  /**
   * Bounded-loss write path (CR-M2 / audit L4): a failed batch is
   * re-queued a bounded number of times with small backoff — the
   * idempotent ON CONFLICT insert makes re-delivery safe — and only
   * dropped (whole, with counts in the log) when retries are exhausted
   * or shutdown is in progress.
   */
  private async processBatchWithRetry(batch: RawInboundMessage[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.processBatch(batch);
        return;
      } catch (error) {
        if (attempt >= this.limits.maxBatchAttempts) {
          this.log("error", "message_drain_failed", {
            reason: safeReason(error),
            attempts: attempt,
            // The whole batch is lost: nothing from it was committed.
            captured: 0,
            lost: batch.length,
          });
          return;
        }
        this.log("warn", "message_batch_retry", {
          attempt,
          count: batch.length,
          reason: safeReason(error),
        });
        await sleep(this.limits.batchRetryBaseMs * attempt);
      }
    }
  }

  private async processBatch(batch: RawInboundMessage[]): Promise<void> {
    const rows: NewMessage[] = [];
    const skipped = new Map<SkipReason, number>();
    for (const raw of batch) {
      const result = normalizeMessage(raw);
      if (result.action === "capture") {
        rows.push(result.row);
      } else {
        skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
      }
    }
    if (skipped.size > 0) {
      // Counts and reasons only — never content (AGENTS.md).
      const fields: LogFields = { total: batch.length };
      for (const reason of SKIP_REASONS) {
        const count = skipped.get(reason);
        if (count !== undefined) fields[reason] = count;
      }
      this.log("debug", "messages_skipped", fields);
    }
    if (rows.length === 0) return;
    if (this.connectionId === null) {
      this.log("error", "messages_dropped_no_connection", {
        count: rows.length,
      });
      return;
    }

    const chatJids = [...new Set(rows.map((row) => row.chatJid))];
    const monitored = await this.db.filterMonitoredChatIds(chatJids);
    const kept = rows.filter((row) => monitored.has(row.chatJid));
    const droppedUnmonitored = rows.length - kept.length;
    if (droppedUnmonitored > 0) {
      this.log("debug", "messages_dropped_unmonitored", {
        count: droppedUnmonitored,
      });
    }
    if (kept.length === 0) return;

    const result = await this.db.insertMessages(this.connectionId, kept);
    // Message push names are the most reliable name source for unsaved
    // contacts in LID-addressed groups (ADR 0008). Persist them on the
    // roster too; best-effort, never fatal.
    const named: Array<{ jids: string[]; name: string }> = [];
    for (const row of kept) {
      if (row.senderJid !== null && row.senderName !== null) {
        const alias = normalizeJidAlias(row.senderJid);
        if (alias !== null) named.push({ jids: [alias], name: row.senderName });
      }
    }
    if (named.length > 0) await this.persistContactNames(named);
    const perChat = new Map<string, number>();
    for (const row of kept) {
      perChat.set(row.chatJid, (perChat.get(row.chatJid) ?? 0) + 1);
    }
    for (const [chatJid, count] of perChat) {
      // Hashed chat reference (audit L1): legacy group JIDs embed phone
      // numbers and must never reach the logs.
      this.log("debug", "messages_captured", {
        chatRef: safeChatRef(chatJid),
        captured: count,
      });
    }
    this.log("debug", "messages_persisted", {
      captured: kept.length,
      inserted: result.inserted,
      duplicates: result.duplicates,
      droppedUnmonitored: result.droppedUnmonitored,
    });
  }
}
