import type { Store } from "./store.js";

/**
 * Configurable automatic message retention (privacy, ADR 0004 §11).
 *
 * `MESSAGE_RETENTION_DAYS` deletes captured `messages` older than N days
 * on a periodic backend pass; `0` (the default) keeps them forever.
 * Retention applies to messages ONLY: summaries, summary runs, groups,
 * the member roster, contact overrides, and settings are kept, so a
 * summary's source-message references may point at rows that no longer
 * exist. Database backups taken before a pass still contain the deleted
 * messages — retention is not a backup eraser.
 *
 * The pass is deliberately boring: one parameterized DELETE per tick,
 * a structured log line with counts and the cutoff (never message
 * content), and no throw path that could take the backend down.
 */

export const DEFAULT_RETENTION_DAYS = 0;
export const DEFAULT_RETENTION_INTERVAL_MS = 86_400_000; // one day
export const MIN_RETENTION_INTERVAL_MS = 60_000;

const DAY_MS = 86_400_000;

export type RetentionLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

/**
 * Parses `MESSAGE_RETENTION_DAYS`. Unset/empty → 0 (keep forever).
 * Must be a non-negative integer; negative or fractional values fail
 * fast at startup instead of silently changing the retention policy.
 */
export function parseRetentionDays(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `MESSAGE_RETENTION_DAYS must be a non-negative integer (days, 0 = keep forever), got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Parses `RETENTION_INTERVAL_MS`. Unset/empty → 24h. Must be a
 * positive integer number of milliseconds; the floor is CLAMPED to
 * 60 000 ms so a misconfigured value cannot turn the pass into a hot
 * loop (same convention as RECONCILE_INTERVAL_MS).
 */
export function parseRetentionIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_RETENTION_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `RETENTION_INTERVAL_MS must be a positive integer (milliseconds), got "${raw}".`,
    );
  }
  return Math.max(parsed, MIN_RETENTION_INTERVAL_MS);
}

export interface RetentionServiceOptions {
  store: Pick<Store, "deleteMessagesBefore">;
  /** Days to keep; <= 0 disables deletion entirely. */
  retentionDays: number;
  /** Timer cadence (env RETENTION_INTERVAL_MS). */
  intervalMs: number;
  now?: () => number;
  log?: RetentionLogger;
}

/**
 * Interval-driven retention pass. `start()` also runs one pass
 * immediately (a restart must apply the configured policy right away).
 * The timer is `unref`'d so it never keeps the process alive, and
 * `stop()` clears it and awaits the in-flight pass (graceful shutdown).
 */
export class RetentionService {
  private readonly store: Pick<Store, "deleteMessagesBefore">;
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: RetentionLogger | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> = Promise.resolve(0);
  private running = false;

  constructor(options: RetentionServiceOptions) {
    this.store = options.store;
    this.retentionDays = options.retentionDays;
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /**
   * One retention pass. Returns the number of deleted messages (0 when
   * retention is disabled). Never throws: a failing delete is logged as
   * `retention_failed` with a safe reason and the next tick retries it.
   */
  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(this.now() - this.retentionDays * DAY_MS);
    try {
      const deleted = await this.store.deleteMessagesBefore(cutoff);
      // Counts and the cutoff only — never message content, sender ids,
      // or chat ids.
      this.log?.("retention_pass", {
        retentionDays: this.retentionDays,
        cutoff: cutoff.toISOString(),
        deleted,
      });
      return deleted;
    } catch (error) {
      // Safe reason only (error names never carry message content).
      this.log?.("retention_failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
      return 0;
    }
  }

  /** Starts the interval and runs one pass immediately. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // The timer must never hold the process open (graceful shutdown).
    this.timer.unref();
  }

  /** Clears the interval and awaits the in-flight pass. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private tick(): Promise<number> {
    if (this.running) {
      // Overlap guard: a slow DELETE must not stack with the next tick.
      return this.inFlight;
    }
    this.running = true;
    this.inFlight = this.runOnce()
      .catch((error: unknown) => {
        // runOnce already contains its errors; this is a final guard so
        // an unexpected rejection can never crash the backend.
        this.log?.("retention_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        return 0;
      })
      .finally(() => {
        this.running = false;
      });
    return this.inFlight;
  }
}
