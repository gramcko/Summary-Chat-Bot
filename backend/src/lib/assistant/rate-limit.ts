import { HttpError } from "../errors.js";

export interface AssistantRateLimiterOptions {
  /** Requests allowed per IP per window (default 20). */
  limit?: number;
  /** Window length in milliseconds (default 60 000 = one minute). */
  windowMs?: number;
  /** Clock seam for deterministic tests. */
  now?: () => number;
  /** Bounded memory: max tracked source IPs (default 10 000). */
  maxTrackedIps?: number;
}

export const DEFAULT_ASSISTANT_RATE_LIMIT = 20;
export const DEFAULT_ASSISTANT_RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

interface Bucket {
  /** Start of the current fixed window (epoch ms). */
  windowStart: number;
  count: number;
}

/**
 * Small fixed-window, per-IP limiter for `POST /api/assistant/chat`.
 *
 * Deliberately in-memory and deliberately simple: this is an
 * operational guard against a runaway dashboard tab, not business data,
 * and a restart clearing it is acceptable for a single-process
 * self-hosted install (same trade-off as the login throttle).
 *
 * A fixed window can let a client send up to `2 * limit` requests
 * around a window boundary; that burst is bounded and harmless for this
 * endpoint, which only reads authorized data and creates idempotent
 * summary runs.
 *
 * `request.ip` honors X-Forwarded-For only from TRUSTED_PROXIES (see
 * app.ts), so a direct client cannot spoof its way out of a bucket.
 */
export class AssistantRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxTrackedIps: number;

  constructor(options: AssistantRateLimiterOptions = {}) {
    this.limit = options.limit ?? DEFAULT_ASSISTANT_RATE_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_ASSISTANT_RATE_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_IPS;
  }

  /**
   * Counts one request for `ip`. Throws 429 `rate_limited` with an
   * accurate `Retry-After` once the bucket is exhausted.
   */
  check(ip: string): void {
    const now = this.now();
    const bucket = this.bucketFor(ip, now);
    if (bucket.count >= this.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStart + this.windowMs - now) / 1000),
      );
      throw new HttpError(
        429,
        "rate_limited",
        "Too many assistant requests. Please wait a moment and try again.",
        undefined,
        { "Retry-After": String(retryAfterSeconds) },
      );
    }
    bucket.count += 1;
  }

  private bucketFor(ip: string, now: number): Bucket {
    const existing = this.buckets.get(ip);
    if (existing !== undefined) {
      if (now - existing.windowStart < this.windowMs) return existing;
      // Window elapsed: reuse the entry as a fresh bucket.
      existing.windowStart = now;
      existing.count = 0;
      return existing;
    }
    if (this.buckets.size >= this.maxTrackedIps) {
      // Evict the oldest tracked IP (Map iteration order is insertion
      // order; an existing IP keeps its position).
      const oldest = this.buckets.keys().next();
      if (oldest.done !== true) this.buckets.delete(oldest.value);
    }
    const bucket: Bucket = { windowStart: now, count: 0 };
    this.buckets.set(ip, bucket);
    return bucket;
  }
}
