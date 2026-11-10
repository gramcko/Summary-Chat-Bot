import type { BotDb } from "./db.js";
import { errorReason } from "./lib/errors.js";
import type { Logger } from "./lib/log.js";
import type { SessionCheckResult, WhatsAppAdapter } from "./whatsapp/adapter.js";
import { purgeSessionDir } from "./whatsapp/session-storage.js";

/**
 * Admin logout control (ADR 0008): polls `whatsapp_connections`
 * (interval: SESSION_CONTROL_POLL_MS, floor 1000) for the
 * `logout_requested_at` flag the backend sets when the admin ends the
 * session. When set, the flow is:
 *
 * 1. consume the flag atomically (a second request while still logged
 *    out just clears it — the flow is idempotent);
 * 2. freeze the capture side (no reconnects, no state writes);
 * 3. adapter logout: revoke the linked device remotely — BOUNDED by a
 *    timeout (M-1), because a stalled network must never retain
 *    credentials or block shutdown;
 * 4. ALWAYS purge the local session files (known Baileys artefacts
 *    only, M-3) and finalize the connection row: state `unavailable`,
 *    linking payload + kind cleared (last_message_at kept — historical
 *    fact);
 * 5. RE-ARM the capture side (CR-M1): reset the teardown latches and
 *    restart the socket so a fresh QR is published through the normal
 *    flow within one poll — "link a device again" must be true without
 *    a worker restart.
 *
 * Each tick also opportunistically clears EXPIRED linking payloads
 * (CR#7). This is deliberately its own poller (not the history-import
 * tick): the two have different intervals and lifecycles — the import
 * tick pauses while an import runs, which must never delay a logout.
 */

/** Default bound on the remote logout call (M-1). */
export const LOGOUT_TIMEOUT_MS = 15_000;

/** Bound on the live session health probe. */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;

export interface SessionControlServiceOptions {
  adapter: WhatsAppAdapter;
  db: BotDb;
  log: Logger;
  /**
   * Capture-side coordination: `beginLogout` freezes state writes and
   * reconnects; `rearm` resets those latches and restarts the socket
   * after the teardown so linking works again (CR-M1).
   */
  capture: { beginLogout(): void; rearm(): Promise<void> };
  /** Session-state directory to purge on logout (never logged). */
  sessionDir: string;
  /** Poll interval in milliseconds (floor 1000). */
  pollMs: number;
  /** Bound on the remote logout (tests inject small values). */
  logoutTimeoutMs?: number;
}

/** Rejects when `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`operation timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class SessionControlService {
  private readonly adapter: WhatsAppAdapter;
  private readonly db: BotDb;
  private readonly log: Logger;
  private readonly capture: { beginLogout(): void; rearm(): Promise<void> };
  private readonly sessionDir: string;
  private readonly pollMs: number;
  private readonly logoutTimeoutMs: number;

  private loopActive = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  /**
   * True while the session is torn down and NOT yet re-armed: requests
   * in this window only clear the flag (idempotent double-clicks). A
   * successful re-arm clears it — after that a request is a NEW logout.
   */
  private loggedOut = false;

  constructor(options: SessionControlServiceOptions) {
    this.adapter = options.adapter;
    this.db = options.db;
    this.log = options.log;
    this.capture = options.capture;
    this.sessionDir = options.sessionDir;
    this.pollMs = Math.max(1000, Math.floor(options.pollMs));
    this.logoutTimeoutMs = options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS;
  }

  start(): void {
    if (this.loopActive) return;
    this.loopActive = true;
    this.scheduleNext();
  }

  /** Stops polling and waits for an in-flight cycle. */
  async stop(): Promise<void> {
    this.loopActive = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
    this.log("info", "session_control_stopped", {});
  }

  /**
   * One poll cycle (exposed for tests; the loop calls it on a timer).
   * Returns true when a logout request was consumed.
   */
  async runOnce(): Promise<boolean> {
    // Opportunistic cleanup (CR#7): an expired pairing payload is a
    // stale ticket and must not linger between event-driven clears.
    const cleared = await this.db.clearExpiredLinking();
    if (cleared > 0) {
      this.log("debug", "linking_expired_cleared", { count: cleared });
    }

    const requestedAt = await this.db.consumeLogoutRequest();
    if (requestedAt === null) {
      // No logout pending: process an admin-requested session health
      // check (the dashboard "Test session" button).
      await this.runSessionCheck();
      return false;
    }
    if (this.loggedOut) {
      // Idempotent (ADR 0008): still logged out and not re-armed — the
      // request only cleared the flag, there is nothing to tear down.
      this.log("info", "logout_request_cleared", {
        note: "already logged out; request flag cleared",
      });
      return true;
    }

    this.log("info", "logout_started", {
      requestedAt: requestedAt.toISOString(),
    });
    // Freeze the capture side FIRST: no reconnect attempts and no
    // further connection-state writes while the session is torn down.
    this.capture.beginLogout();

    // M-1: the remote logout is BOUNDED — a stalled network must not
    // skip the local purge/finalize or block shutdown.
    let ok = true;
    try {
      await withTimeout(this.adapter.logout(), this.logoutTimeoutMs);
    } catch (error) {
      ok = false;
      this.log("error", "logout_failed", { reason: errorReason(error) });
    }

    // Local cleanup ALWAYS runs (bounded above): purge the auth-state
    // files (known Baileys artefacts only — anything else is left and
    // reported, M-3) and finalize the row.
    try {
      const purge = purgeSessionDir(this.sessionDir, (kept) => {
        this.log("warn", "session_purge_kept_unknown_files", { count: kept });
      });
      this.log("info", "session_state_purged", {
        removed: purge.removed,
        kept: purge.kept,
      });
    } catch (error) {
      // A purge failure must not skip the finalize below.
      this.log("error", "session_purge_failed", { reason: errorReason(error) });
    }
    const connectionId = await this.db.ensureConnection();
    await this.db.finalizeLogout(connectionId);
    this.log("info", "logout_completed", { ok });

    // CR-M1: re-arm linking — reset the teardown latches and restart
    // the socket so the normal flow publishes a fresh QR within one
    // poll. If re-arm fails the latch stays set (requests keep clearing
    // the flag; a worker restart recovers — documented in ADR 0004).
    try {
      await this.capture.rearm();
      this.loggedOut = false;
    } catch (error) {
      this.loggedOut = true;
      this.log("error", "session_rearm_failed", { reason: errorReason(error) });
    }
    return true;
  }

  /**
   * Processes at most one pending session health check. The adapter
   * probe is bounded so a stalled network cannot block logout/control.
   * The result write is fenced by the request timestamp, so a newer
   * request is never overwritten by an older probe.
   */
  private async runSessionCheck(): Promise<void> {
    const claim = await this.db.claimSessionCheck();
    if (claim === null) return;
    let result: SessionCheckResult;
    try {
      result = await withTimeout(
        this.adapter.checkSession(),
        SESSION_CHECK_TIMEOUT_MS,
      );
    } catch (error) {
      result = {
        ok: false,
        latencyMs: null,
        error: errorReason(error).slice(0, 200),
      };
    }
    const completed = await this.db.completeSessionCheck(claim, result);
    this.log("info", "session_check_completed", {
      ok: result.ok,
      latencyMs: result.latencyMs,
      completed,
    });
  }

  private scheduleNext(): void {
    if (!this.loopActive) return;
    this.timer = setTimeout(() => {
      this.running = this.running
        .then(() => this.runOnce())
        .catch((error) => {
          this.log("error", "session_control_poll_failed", {
            reason: errorReason(error),
          });
        })
        .then(() => {
          this.scheduleNext();
        });
    }, this.pollMs);
  }
}
