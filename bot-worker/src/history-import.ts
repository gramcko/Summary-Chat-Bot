import type { BotDb, HistoryImportClaim, HistoryImportOutcome } from "./db.js";
import { errorReason } from "./lib/errors.js";
import type { LogFields, Logger } from "./lib/log.js";
import { safeChatRef } from "./lib/privacy.js";
import { normalizeMessage, SKIP_REASONS, type NewMessage, type SkipReason } from "./normalize.js";
import type {
  AdapterEvent,
  HistoryCursor,
  HistoryFailureReason,
  RawInboundMessage,
  WhatsAppAdapter,
} from "./whatsapp/adapter.js";

/**
 * WhatsApp history import (ADR 0007): polls PostgreSQL for pending
 * import requests, fetches as much history as WhatsApp will give for
 * that ONE monitored group, ingests it idempotently through the same
 * monitored-filtered batch path as live capture, and reports progress.
 *
 * The effort is deliberately BOUNDED ("as many as possible, bounded"):
 * a per-request batch size, a round cap, a collected-message cap, and a
 * wall-clock budget. WhatsApp decides what history is available and may
 * return less, nothing, or several batches per request — a finished
 * import is partial BY DESIGN and `importedCount` reports what was
 * actually inserted (duplicates do not count).
 *
 * Privacy boundary (ADR 0007): only monitored groups are claimed (SQL),
 * the group is re-checked before EVERY round (unmonitoring stops the
 * import), the adapter drops other chats' history before normalization,
 * and imported rows go through the same monitored-only INSERT.
 */

export interface HistoryImportBudgets {
  /** Messages requested per round (WhatsApp may return fewer). */
  batchCount: number;
  /** Maximum request rounds per import. */
  maxRounds: number;
  /** Maximum messages collected per import (before dedupe). */
  maxMessages: number;
  /** Wall-clock budget per import, milliseconds. */
  timeBudgetMs: number;
  /** Hard cap on waiting for one round's response. */
  roundTimeoutMs: number;
  /** Quiet period after the last received batch that ends a round. */
  roundSettleMs: number;
  /** Grace after REQUEST_SUCCESS for a late history payload. */
  successGraceMs: number;
  /** Poll interval for pending imports (floor 1000, enforced in config). */
  pollMs: number;
  /** Staleness threshold for crash recovery of 'running' claims. */
  staleMs: number;
}

export const DEFAULT_HISTORY_IMPORT_BUDGETS: HistoryImportBudgets = {
  // WhatsApp caps `historySyncOnDemandRequest.onDemandMsgCount` at 50
  // (Baileys README: "quantity (max: 50 per query)"); larger values are
  // silently ignored.
  batchCount: 50,
  maxRounds: 20,
  maxMessages: 2000,
  timeBudgetMs: 120_000,
  roundTimeoutMs: 30_000,
  roundSettleMs: 2_000,
  successGraceMs: 5_000,
  pollMs: 5_000,
  staleMs: 600_000,
};

/** Upper bounds for the effort knobs (SA-L1). */
export const HISTORY_IMPORT_BOUNDS = {
  batchCount: 50,
  maxRounds: 100,
  maxMessages: 20_000,
} as const;

/**
 * Validates the merged budgets (SA-L1/CR-m2). Throws with a clear
 * message; the config layer wraps it in a ConfigError.
 *
 * The KEY invariant: an import must time out strictly BEFORE its claim
 * could be considered stale — otherwise the stale-claim requeue could
 * requeue a SLOW-BUT-ACTIVE import and a second claim would duplicate
 * the work (idempotent, but wrong):
 * `timeBudgetMs + roundTimeoutMs < staleMs`.
 */
export function validateHistoryImportBudgets(
  budgets: HistoryImportBudgets,
): void {
  const check = (name: keyof typeof HISTORY_IMPORT_BOUNDS, value: number) => {
    const max = HISTORY_IMPORT_BOUNDS[name];
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(
        `history import budget ${name} must be an integer between 1 and ${max} (got ${value}).`,
      );
    }
  };
  check("batchCount", budgets.batchCount);
  check("maxRounds", budgets.maxRounds);
  check("maxMessages", budgets.maxMessages);
  if (!Number.isInteger(budgets.timeBudgetMs) || budgets.timeBudgetMs < 1) {
    throw new Error(
      `history import budget timeBudgetMs must be a positive integer (got ${budgets.timeBudgetMs}).`,
    );
  }
  if (budgets.timeBudgetMs + budgets.roundTimeoutMs >= budgets.staleMs) {
    throw new Error(
      "history import budgets violate the staleness invariant: " +
        `timeBudgetMs (${budgets.timeBudgetMs}) + roundTimeoutMs ` +
        `(${budgets.roundTimeoutMs}) must stay below staleMs ` +
        `(${budgets.staleMs}) so a slow-but-active import is never ` +
        "requeued by the stale-claim recovery.",
    );
  }
}

export interface HistoryImportServiceOptions {
  adapter: WhatsAppAdapter;
  db: BotDb;
  log: Logger;
  /** Partial budgets (from env); missing fields use the defaults. */
  budgets?: Partial<HistoryImportBudgets>;
  /** Injectable for tests. */
  now?: () => number;
}

export class HistoryImportService {
  private readonly adapter: WhatsAppAdapter;
  private readonly db: BotDb;
  private readonly log: Logger;
  private readonly budgets: HistoryImportBudgets;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  /** The poll loop is scheduled (start/stop). */
  private loopActive = false;
  /** Shutdown requested: abort imports and release their claims. */
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();

  /** The chat being imported (null = no active import). */
  private importChat: string | null = null;
  /** Messages received for the current round (released after it). */
  private importBuffer: RawInboundMessage[] = [];
  /** Failure reported by the phone for the active request (if any). */
  private importFailure: HistoryFailureReason | null = null;
  /** REQUEST_SUCCESS seen for the active request (no payload yet). */
  private importSuccess = false;
  /** Bumps on every received history batch (settle tracking). */
  private activityVersion = 0;
  private wake: (() => void) | null = null;

  constructor(options: HistoryImportServiceOptions) {
    this.adapter = options.adapter;
    this.db = options.db;
    this.log = options.log;
    this.budgets = { ...DEFAULT_HISTORY_IMPORT_BUDGETS, ...options.budgets };
    // Fail fast on unsafe budget combinations (SA-L1), whether they came
    // from the environment (config) or were injected directly.
    validateHistoryImportBudgets(this.budgets);
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.adapter.subscribe((event) => this.onEvent(event));
  }

  /** Starts the polling loop (one import at a time). */
  start(): void {
    if (this.loopActive) return;
    this.loopActive = true;
    this.stopping = false;
    this.scheduleNext();
  }

  /**
   * Graceful shutdown: stops polling, interrupts any wait, and RELEASES
   * the active claim back to 'pending' (immediate recovery; a crashed
   * worker is covered by the stale-claim requeue instead).
   */
  async stop(): Promise<void> {
    this.loopActive = false;
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wakeNow();
    await this.running;
    this.unsubscribe();
    this.log("info", "history_import_stopped", {});
  }

  /**
   * One poll cycle: recover stale claims, then run at most one import.
   * Exposed for tests and manual runs; the polling loop calls it on a
   * timer. Runs regardless of the loop state (the loop guards itself).
   */
  async runOnce(): Promise<void> {
    const requeued = await this.db.requeueStaleHistoryImports(this.budgets.staleMs);
    if (requeued > 0) {
      this.log("warn", "history_claims_requeued", { count: requeued });
    }
    const claims = await this.db.claimPendingHistoryImports(1);
    const claim = claims[0];
    if (claim === undefined) return;
    await this.runImport(claim);
  }

  // ------------------------------------------------------------------
  // Event collection (history batches for the active import only)
  // ------------------------------------------------------------------

  private onEvent(event: AdapterEvent): void {
    if (event.type === "history-error") {
      // The phone explicitly refused/failed the request: stop waiting.
      if (this.importChat !== event.chatJid) return;
      this.importFailure = event.reason;
      this.wakeNow();
      return;
    }
    if (event.type === "history-success") {
      // REQUEST_SUCCESS with no history payload yet: remember it so a
      // round that ends empty finishes as `done` (no older history)
      // instead of `history_timeout`. Wake to shorten the wait, but
      // collectRoundBatch still gives the payload a short grace window.
      if (this.importChat !== event.chatJid) return;
      this.importSuccess = true;
      this.wakeNow();
      return;
    }
    if (event.type !== "history") return;
    // Ignore stale/foreign batches (ADR 0007): only the chat currently
    // being imported is collected; events after completion are dropped.
    if (this.importChat !== event.chatJid) return;
    // Bounded buffer (SA-L4): at most maxMessages*2 messages may be
    // held for the round; overflow drops the NEWEST with a counted log.
    const cap = this.budgets.maxMessages * 2;
    const room = cap - this.importBuffer.length;
    if (event.messages.length > room) {
      const dropped = event.messages.length - Math.max(room, 0);
      this.log("warn", "history_buffer_overflow", { count: dropped });
      if (room > 0) this.importBuffer.push(...event.messages.slice(0, room));
    } else {
      this.importBuffer.push(...event.messages);
    }
    this.activityVersion += 1;
    this.wakeNow();
  }

  private wakeNow(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Resolves on new activity or after `ms`, whichever comes first. */
  private waitForActivity(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.wake = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }

  /**
   * Collects one round's batches (CR-M1):
   *
   * 1. wait for the FIRST batch of the round up to `firstBatchMs` (the
   *    round timeout or the remaining deadline) — WhatsApp peer-data
   *    latency is unverified, so a slow first response must not end the
   *    round early (the old settle-only logic mis-reported it as "no
   *    history");
   * 2. only AFTER activity, apply the quiet (`settleMs`) window to
   *    gather the rest of the batches;
   * 3. release the collected entries from the buffer (SA-L4).
   *
   * A round whose first batch never arrives within the true timeout
   * returns an empty batch (=> `history_timeout` on a first round).
   */
  private async collectRoundBatch(
    startVersion: number,
    firstBatchMs: number,
    deadline: number,
    settleMs: number,
  ): Promise<RawInboundMessage[]> {
    const release = (): RawInboundMessage[] => {
      const batch = this.importBuffer.splice(0, this.importBuffer.length);
      return batch;
    };
    // Phase 1: wait for the first batch of THIS round.
    if (this.activityVersion === startVersion) {
      const remaining = deadline - this.now();
      if (remaining <= 0) return release();
      await this.waitForActivity(Math.min(firstBatchMs, remaining));
      if (this.activityVersion === startVersion) {
        // REQUEST_SUCCESS but no payload yet: give WhatsApp a short
        // grace window to deliver the history notification (they can
        // arrive as separate messages) before concluding "no history".
        if (this.importSuccess) {
          const graceRemaining = deadline - this.now();
          if (graceRemaining > 0) {
            await this.waitForActivity(
              Math.min(this.budgets.successGraceMs, graceRemaining),
            );
          }
        }
        if (this.activityVersion === startVersion) return release(); // no answer
      }
    }
    // Phase 2: settle — keep listening while batches keep arriving.
    for (;;) {
      const version = this.activityVersion;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.waitForActivity(Math.min(settleMs, remaining));
      if (this.activityVersion !== version) continue; // new data: settle restarts
      break; // quiet for the settle window
    }
    return release();
  }

  // ------------------------------------------------------------------
  // The import itself
  // ------------------------------------------------------------------

  private async runImport(claim: HistoryImportClaim): Promise<void> {
    const { budgets } = this;
    const deadline = this.now() + budgets.timeBudgetMs;
    this.importChat = claim.chatJid;
    this.importBuffer = [];
    this.importFailure = null;
    this.importSuccess = false;
    this.activityVersion = 0;

    const chatRef = safeChatRef(claim.chatJid);
    this.log("info", "history_import_started", {
      groupId: claim.groupId,
      chatRef,
    });

    let imported = 0;
    let collected = 0;
    let rounds = 0;
    let failure: string | null = null;
    let gotAnyBatch = false;
    const seenIds = new Set<string>();
    let oldest: HistoryCursor | null = null;

    // On-demand history pages BACK from a real message key. Without an
    // anchor WhatsApp ignores the request and the import would burn the
    // full round timeout (observed as `history_timeout`). Use the
    // oldest captured message; if the chat has none, fail fast with a
    // clear code instead of waiting.
    try {
      oldest = await this.db.getOldestMessageCursor(claim.chatJid);
    } catch (error) {
      this.log("error", "history_cursor_failed", {
        groupId: claim.groupId,
        chatRef,
        reason: errorReason(error),
      });
      failure = "history_internal";
    }
    if (failure === null && oldest === null) {
      this.log("warn", "history_no_anchor", {
        groupId: claim.groupId,
        chatRef,
      });
      failure = "history_no_anchor";
    }

    try {
      while (
        rounds < budgets.maxRounds &&
        collected < budgets.maxMessages &&
        this.now() < deadline &&
        failure === null &&
        !this.stopping
      ) {
        rounds += 1;

        // Privacy boundary re-checked EVERY round: unmonitoring the
        // group stops the import immediately (ADR 0007).
        const monitored = await this.db.filterMonitoredChatIds([claim.chatJid]);
        if (!monitored.has(claim.chatJid)) {
          failure = "group_unmonitored";
          break;
        }

        // Round start: release the previous round's buffer (SA-L4) and
        // snapshot the activity counter BEFORE the request, so batches
        // that arrive while the request is being relayed count as this
        // round's first response (CR-M1).
        this.importBuffer.length = 0;
        this.importSuccess = false;
        const startVersion = this.activityVersion;

        try {
          await this.adapter.requestHistory({
            chatJid: claim.chatJid,
            count: budgets.batchCount,
            cursor: oldest,
          });
        } catch (error) {
          this.log("error", "history_request_failed", {
            groupId: claim.groupId,
            chatRef,
            reason: errorReason(error),
          });
          failure = "history_unavailable";
          break;
        }

        const batch = await this.collectRoundBatch(
          startVersion,
          budgets.roundTimeoutMs,
          Math.min(deadline, this.now() + budgets.roundTimeoutMs),
          budgets.roundSettleMs,
        );
        if (this.importFailure !== null) {
          // The phone answered with a failure code. Ingest any messages
          // that did arrive, then stop with the specific reason.
          failure = this.importFailure;
          if (batch.length === 0) break;
        }
        if (batch.length === 0) {
          // WhatsApp answered with nothing: "history_timeout" when it
          // never answered at all, otherwise the available history is
          // simply exhausted (a successful partial import).
          if (this.importSuccess) {
            this.log("debug", "history_no_older_messages", {
              groupId: claim.groupId,
              chatRef,
              round: rounds,
            });
          } else if (!gotAnyBatch) {
            failure = "history_timeout";
          }
          break;
        }
        gotAnyBatch = true;

        // Dedupe within the import (rounds overlap when a cursor is not
        // honored); the DB dedupes across imports via ON CONFLICT.
        const fresh: RawInboundMessage[] = [];
        for (const raw of batch) {
          // The cursor tracks the OLDEST message ever received (even a
          // duplicate), so paging keeps moving backwards.
          const candidate: HistoryCursor | null =
            raw.messageId !== null && raw.timestampSec !== null
              ? {
                  messageId: raw.messageId,
                  fromMe: raw.fromMe,
                  timestampSec: raw.timestampSec,
                }
              : null;
          if (
            candidate !== null &&
            (oldest === null || candidate.timestampSec < oldest.timestampSec)
          ) {
            oldest = candidate;
          }
          if (raw.messageId !== null) {
            if (seenIds.has(raw.messageId)) continue;
            seenIds.add(raw.messageId);
          }
          fresh.push(raw);
        }
        // The message budget is EXACT: a batch is truncated to the
        // remaining room (partial by design, ADR 0007).
        const room = Math.max(0, budgets.maxMessages - collected);
        const take = fresh.slice(0, room);
        collected += take.length;

        const outcome = await this.ingestBatch(claim, take);
        imported += outcome.inserted;
        const fields: LogFields = {
          groupId: claim.groupId,
          chatRef,
          round: rounds,
          received: batch.length,
          fresh: take.length,
          inserted: outcome.inserted,
          duplicates: outcome.duplicates,
          imported,
        };
        this.log("debug", "history_round", fields);

        // CR-M2: publish progress after EVERY round (fenced exactly like
        // completion) so the dashboard's "N imported so far" can render
        // before the terminal state. The final count is written again,
        // exactly, by completeHistoryImport.
        await this.db.updateHistoryImportProgress(
          { groupId: claim.groupId, startedAt: claim.startedAt },
          imported,
        );

        if (take.length === 0) break; // no progress (or no room): stop
        if (collected >= budgets.maxMessages) break; // budget reached
      }

      if (this.stopping) {
        // Graceful shutdown mid-import: release instead of completing
        // (the "no response" case above may be caused by the stop).
        const released = await this.db.releaseHistoryImport({
          groupId: claim.groupId,
          startedAt: claim.startedAt,
        });
        this.log("info", "history_import_released", {
          groupId: claim.groupId,
          chatRef,
          imported,
          released,
        });
        return;
      }

      const outcome: HistoryImportOutcome =
        failure !== null
          ? { status: "failed", importedCount: imported, error: failure }
          : { status: "done", importedCount: imported, error: null };
      const completed = await this.db.completeHistoryImport(
        { groupId: claim.groupId, startedAt: claim.startedAt },
        outcome,
      );
      this.log("info", "history_import_completed", {
        groupId: claim.groupId,
        chatRef,
        status: outcome.status,
        importedCount: outcome.importedCount,
        rounds,
        collected,
        error: outcome.error,
        completed,
      });
    } catch (error) {
      // Unexpected failure (e.g. the database write): report 'failed'
      // with a safe code; never leave the claim silent.
      this.log("error", "history_import_crashed", {
        groupId: claim.groupId,
        chatRef,
        reason: errorReason(error),
      });
      await this.db
        .completeHistoryImport(
          { groupId: claim.groupId, startedAt: claim.startedAt },
          { status: "failed", importedCount: imported, error: "history_internal" },
        )
        .catch(() => {
          // Stale-claim recovery will requeue it (ADR 0007).
        });
    } finally {
      this.importChat = null;
      this.adapter.releaseHistoryChat(claim.chatJid);
    }
  }

  /**
   * Ingests one batch through the SAME monitored-filtered idempotent
   * path as live capture — minus `last_message_at`: historical imports
   * must not masquerade as live traffic (ADR 0007).
   */
  private async ingestBatch(
    claim: HistoryImportClaim,
    batch: RawInboundMessage[],
  ): Promise<{ inserted: number; duplicates: number }> {
    const rows: NewMessage[] = [];
    const skipped = new Map<SkipReason, number>();
    for (const raw of batch) {
      const result = normalizeMessage(raw);
      if (result.action === "capture") rows.push(result.row);
      else skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
    }
    if (skipped.size > 0) {
      const fields: LogFields = { chatRef: safeChatRef(claim.chatJid) };
      for (const reason of SKIP_REASONS) {
        const count = skipped.get(reason);
        if (count !== undefined) fields[reason] = count;
      }
      this.log("debug", "history_messages_skipped", fields);
    }
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };

    const chatJids = [...new Set(rows.map((row) => row.chatJid))];
    const monitored = await this.db.filterMonitoredChatIds(chatJids);
    const kept = rows.filter((row) => monitored.has(row.chatJid));
    if (kept.length === 0) return { inserted: 0, duplicates: 0 };

    const connectionId = await this.db.ensureConnection();
    const result = await this.db.insertMessages(connectionId, kept, {
      touchLastMessage: false,
    });
    return { inserted: result.inserted, duplicates: result.duplicates };
  }

  private scheduleNext(): void {
    if (!this.loopActive) return;
    this.timer = setTimeout(() => {
      this.running = this.running
        .then(() => this.runOnce())
        .catch((error) => {
          this.log("error", "history_poll_failed", { reason: errorReason(error) });
        })
        .then(() => {
          this.scheduleNext();
        });
    }, this.budgets.pollMs);
  }
}
