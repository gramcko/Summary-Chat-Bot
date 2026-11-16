import { Queue } from "bullmq";
import {
  SUMMARY_JOB,
  SUMMARY_QUEUE,
  summaryJobOptions,
  type SummaryJobOptions,
  type SummaryRunJob,
} from "@summarly/contracts";

/**
 * Backend queue producer for `generate-summary` jobs (architecture
 * A5.2/A6, docs/decisions/0003-queue-strategy.md).
 *
 * Job-id mechanism (verified against the installed bullmq 6.5.2
 * sources — `scripts/addStandardJob-9.lua` and `scripts/removeJob-2.lua`):
 *
 * - `jobId = summaryRunId`. BullMQ's add script treats a duplicate id
 *   as a hard dedupe: when the job key EXISTS the new job is silently
 *   dropped (`handleDuplicatedJob` emits a `duplicated` event and
 *   returns the existing id). That gives "at most ONE live job per
 *   run" for free — concurrent double-enqueues collapse into one job.
 * - The same mechanism is also a trap: a FINISHED job is retained in
 *   Redis for a while (`removeOnComplete`/`removeOnFail` keep the last
 *   {@link SUMMARY_FINISHED_JOBS_KEPT} per state), and its job key
 *   still EXISTS — so a plain re-add after completion would be
 *   silently dropped and the re-enqueue would be lost.
 * - Therefore every enqueue goes through {@link enqueueSummaryRun}:
 *   a live job (waiting/active/delayed/prioritized/waiting-children)
 *   is left alone (dedupe), while a DEAD job (completed/failed) is
 *   removed first and then re-added. Removal is safe by construction:
 *   BullMQ's remove script refuses LOCKED (active) jobs — it returns
 *   code 0 and removes nothing — so an active job can never be yanked
 *   mid-processing even if its state changed between our check and the
 *   remove. Code 0 (or a job that became live again) means "leave it";
 *   we then skip the add and keep exactly one live job per run.
 *
 * Enqueue failures propagate to the caller: routes leave the run
 * `pending` and log a safe operational error (architecture A6 — the
 * durable run is created BEFORE the enqueue attempt, so a failed
 * enqueue is always recoverable by the reconciliation pass).
 */

/** Result of one enqueue attempt (for logs and tests). */
export type EnqueueOutcome = "enqueued" | "already-queued";

/**
 * The queue surface the producer needs. Structurally satisfied by
 * BullMQ's `Queue<SummaryRunJob>` and by in-memory fakes in unit tests.
 */
export interface SummaryQueueLike {
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined>;
  remove(
    jobId: string,
    opts?: { removeChildren?: boolean },
  ): Promise<number>;
  add(
    name: string,
    data: SummaryRunJob,
    opts?: SummaryJobOptions & { jobId?: string },
  ): Promise<unknown>;
  /**
   * Drops ALL queue state (waiting/active/retained jobs). Optional so
   * test doubles only implement it when they exercise purgeAll.
   * BullMQ's signature: `obliterate(opts?: { force?: boolean })`.
   */
  obliterate?(opts?: { force?: boolean }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Enqueue boundary used by routes and the reconciliation pass. Kept as
 * a tiny interface so the API stays testable without Redis. (Tests
 * bring their own in-memory implementations — see tests/helpers.ts.)
 */
export interface SummaryEnqueuer {
  enqueueSummaryRun(runId: string): Promise<EnqueueOutcome>;
  /**
   * Drops every queued/retained summary job (guarded admin "delete all
   * captured data" action). Optional: test enqueuers may omit it, and
   * the route treats a failure as non-fatal.
   */
  purgeAll?(): Promise<void>;
}

export type EnqueueLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

export interface SummaryEnqueuerOptions {
  queue: SummaryQueueLike;
  /** Base delay of the exponential retry backoff (see contracts). */
  retryBaseMs?: number;
  log?: EnqueueLogger;
}

/**
 * Job-id based enqueuer. See the module comment for the dedupe /
 * dead-job-removal mechanism and its BullMQ verification notes.
 */
export class RedisSummaryEnqueuer implements SummaryEnqueuer {
  private readonly queue: SummaryQueueLike;
  private readonly retryBaseMs: number;
  private readonly log: EnqueueLogger | undefined;

  constructor(options: SummaryEnqueuerOptions) {
    this.queue = options.queue;
    this.retryBaseMs = options.retryBaseMs ?? summaryJobOptions().backoff.delay;
    this.log = options.log;
  }

  async enqueueSummaryRun(runId: string): Promise<EnqueueOutcome> {
    const existing = await this.queue.getJob(runId);
    if (existing !== undefined) {
      const state = await existing.getState();
      const dead = state === "completed" || state === "failed";
      if (!dead) {
        // A live job already covers this run (goal: at most one live
        // job per run). A second add would be dropped as `duplicated`
        // anyway — report the dedupe explicitly.
        this.log?.("enqueue_deduped", { summaryRunId: runId, jobState: state });
        return "already-queued";
      }
      // DEAD job retained by bounded retention: its key still exists,
      // so a plain add would be silently dropped (the re-enqueue would
      // be lost). Remove it first. BullMQ's remove refuses locked
      // (active) jobs with code 0 — if the job became live again in
      // the meantime we leave it alone.
      const removed = await this.queue.remove(runId);
      if (removed !== 1) {
        this.log?.("enqueue_deduped", {
          summaryRunId: runId,
          jobState: "locked",
        });
        return "already-queued";
      }
      this.log?.("enqueue_removed_dead_job", { summaryRunId: runId, jobState: state });
    }

    await this.queue.add(
      SUMMARY_JOB,
      { summaryRunId: runId },
      { ...summaryJobOptions(this.retryBaseMs), jobId: runId },
    );
    return "enqueued";
  }

  async purgeAll(): Promise<void> {
    // BullMQ 6.5.2: `obliterate(opts?: { force?: boolean })` removes
    // every job (waiting/active/delayed/retained). `force: true` is
    // required to purge with an active job — the guarded admin action
    // runs after the database transaction, so those runs are gone.
    if (this.queue.obliterate === undefined) {
      this.log?.("queue_purge_skipped", { reason: "not_supported" });
      return;
    }
    await this.queue.obliterate({ force: true });
    this.log?.("queue_purged", { scope: "summaries" });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Builds the real BullMQ-backed enqueuer for a Redis URL. */
export function createRedisSummaryEnqueuer(options: {
  redisUrl: string;
  retryBaseMs?: number;
  /** BullMQ key-prefix namespace (see parseQueuePrefix in contracts). */
  prefix?: string;
  log?: EnqueueLogger;
}): RedisSummaryEnqueuer & { close(): Promise<void> } {
  // Plain connection options: BullMQ owns the client lifecycle and
  // closes it with the queue. The PRODUCER connection is deliberately
  // bounded (audit L7): `commandTimeout` + a small `maxRetriesPerRequest`
  // make an enqueue during a Redis outage FAIL FAST (the run stays
  // pending and is reconciled later) instead of holding the HTTP
  // request open. Workers keep maxRetriesPerRequest: null — BullMQ
  // requires unbounded retries for blocking commands there.
  const queue = new Queue<SummaryRunJob>(SUMMARY_QUEUE, {
    connection: {
      url: options.redisUrl,
      commandTimeout: 5000,
      maxRetriesPerRequest: 3,
    },
    prefix: options.prefix,
  });
  // Connection/infrastructure errors surface as `error` events (audit
  // L11): log them safely — names and truncated messages only, never
  // raw payloads (BullMQ/ioredis text can embed connection URLs).
  queue.on("error", (error: Error) => {
    options.log?.("queue_error", {
      reason: error.name,
      detail: error.message.slice(0, 200),
    });
  });
  return new RedisSummaryEnqueuer({
    queue,
    retryBaseMs: options.retryBaseMs,
    log: options.log,
  });
}
