import { describe, expect, it } from "vitest";
import {
  SUMMARY_JOB,
  type SummaryJobOptions,
  type SummaryRunJob,
} from "@summarly/contracts";
import {
  RedisSummaryEnqueuer,
  type SummaryQueueLike,
} from "../src/lib/enqueue.js";
import { noopEnqueuer } from "./helpers.js";

/**
 * Job-id mechanism (docs/decisions/0003, verified against bullmq
 * 6.5.2's addStandardJob/removeJob Lua scripts):
 *
 *   - jobId = summaryRunId -> at most one live job per run (a second
 *     add with the same id is dropped by BullMQ as `duplicated`);
 *   - a retained DEAD job (completed/failed) must be REMOVED before
 *     re-adding, otherwise the re-enqueue is silently dropped;
 *   - an ACTIVE (locked) job is never removed: BullMQ's remove script
 *     refuses it with code 0 and the enqueuer then leaves it alone.
 */

const RUN_ID = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";

interface AddedCall {
  name: string;
  data: SummaryRunJob;
  opts: (SummaryJobOptions & { jobId?: string }) | undefined;
}

/** In-memory stand-in for BullMQ's Queue with scripted remove codes. */
class FakeQueue implements SummaryQueueLike {
  readonly states = new Map<string, string>();
  readonly removed: string[] = [];
  readonly added: AddedCall[] = [];
  readonly obliterated: Array<{ force?: boolean }> = [];
  removeResult = 1;
  failOnGet = false;
  failOnObliterate = false;

  async getJob(
    jobId: string,
  ): Promise<{ getState(): Promise<string> } | undefined> {
    if (this.failOnGet) throw new Error("Connection is closed.");
    const state = this.states.get(jobId);
    if (state === undefined) return undefined;
    return { getState: async () => state };
  }

  async remove(jobId: string): Promise<number> {
    this.removed.push(jobId);
    if (this.removeResult === 1) this.states.delete(jobId);
    return this.removeResult;
  }

  async add(
    name: string,
    data: SummaryRunJob,
    opts?: SummaryJobOptions & { jobId?: string },
  ): Promise<unknown> {
    this.added.push({ name, data, opts });
    this.states.set(opts?.jobId ?? "auto", "waiting");
    return { id: opts?.jobId };
  }

  async obliterate(opts?: { force?: boolean }): Promise<void> {
    if (this.failOnObliterate) throw new Error("Connection is closed.");
    this.obliterated.push(opts ?? {});
    this.states.clear();
  }

  async close(): Promise<void> {}
}

function makeEnqueuer(queue: FakeQueue, retryBaseMs = 25): RedisSummaryEnqueuer {
  return new RedisSummaryEnqueuer({ queue, retryBaseMs });
}

describe("RedisSummaryEnqueuer (job-id semantics)", () => {
  it("adds the job with jobId = summaryRunId and the shared retry policy", async () => {
    const queue = new FakeQueue();
    const outcome = await makeEnqueuer(queue).enqueueSummaryRun(RUN_ID);

    expect(outcome).toBe("enqueued");
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0]?.name).toBe(SUMMARY_JOB);
    expect(queue.added[0]?.data).toEqual({ summaryRunId: RUN_ID });
    // Identifier-only payload + the one agreed policy (contracts).
    expect(queue.added[0]?.opts).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 25 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
      jobId: RUN_ID,
    });
    expect(queue.removed).toEqual([]);
  });

  it("dedupes against any LIVE job state (at most one live job per run)", async () => {
    for (const state of [
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "waiting-children",
    ]) {
      const queue = new FakeQueue();
      queue.states.set(RUN_ID, state);
      const outcome = await makeEnqueuer(queue).enqueueSummaryRun(RUN_ID);

      expect(outcome, state).toBe("already-queued");
      expect(queue.added, state).toHaveLength(0);
      // Never remove a live job — especially not an active one.
      expect(queue.removed, state).toEqual([]);
    }
  });

  it("removes a retained DEAD job before re-adding (re-enqueue is never lost)", async () => {
    for (const state of ["completed", "failed"]) {
      const queue = new FakeQueue();
      queue.states.set(RUN_ID, state);
      const outcome = await makeEnqueuer(queue).enqueueSummaryRun(RUN_ID);

      expect(outcome, state).toBe("enqueued");
      // Dead first, then removed, then re-added under the same job id.
      expect(queue.removed, state).toEqual([RUN_ID]);
      expect(queue.added, state).toHaveLength(1);
      expect(queue.added[0]?.opts?.jobId, state).toBe(RUN_ID);
    }
  });

  it("leaves the job alone when BullMQ reports it locked (code 0)", async () => {
    // The dead job became active between the state check and the
    // remove: the remove script refuses locked jobs with code 0 and the
    // enqueuer must NOT add a second job on top of it.
    const queue = new FakeQueue();
    queue.states.set(RUN_ID, "completed");
    queue.removeResult = 0;
    const outcome = await makeEnqueuer(queue).enqueueSummaryRun(RUN_ID);

    expect(outcome).toBe("already-queued");
    expect(queue.removed).toEqual([RUN_ID]);
    expect(queue.added).toHaveLength(0);
  });

  it("propagates queue errors so callers can leave the run recoverable", async () => {
    const queue = new FakeQueue();
    queue.failOnGet = true;
    await expect(
      makeEnqueuer(queue).enqueueSummaryRun(RUN_ID),
    ).rejects.toThrow("Connection is closed.");
    expect(queue.added).toHaveLength(0);
  });

  it("defaults to the shared retry base", async () => {
    const queue = new FakeQueue();
    await new RedisSummaryEnqueuer({ queue }).enqueueSummaryRun(RUN_ID);
    expect(queue.added[0]?.opts?.backoff.delay).toBe(30000);
  });
});

describe("RedisSummaryEnqueuer.purgeAll (danger-zone queue cleanup)", () => {
  it("obliterates the whole queue with force", async () => {
    const queue = new FakeQueue();
    queue.states.set(RUN_ID, "waiting");

    await makeEnqueuer(queue).purgeAll();

    // BullMQ 6.5.2: obliterate({ force: true }) removes waiting,
    // active, delayed, and retained jobs.
    expect(queue.obliterated).toEqual([{ force: true }]);
    expect(queue.states.size).toBe(0);
  });

  it("propagates obliterate errors so the route can log them", async () => {
    const queue = new FakeQueue();
    queue.failOnObliterate = true;
    await expect(makeEnqueuer(queue).purgeAll()).rejects.toThrow(
      "Connection is closed.",
    );
  });

  it("no-ops safely when the queue surface cannot obliterate", async () => {
    const queue: SummaryQueueLike = {
      async getJob() {
        return undefined;
      },
      async remove() {
        return 0;
      },
      async add() {
        return {};
      },
      async close() {},
    };
    await expect(
      new RedisSummaryEnqueuer({ queue }).purgeAll(),
    ).resolves.toBeUndefined();
  });
});

describe("noopEnqueuer", () => {
  it("is a safe no-op for tests that do not care about the queue", async () => {
    expect(await noopEnqueuer.enqueueSummaryRun(RUN_ID)).toBe("already-queued");
  });
});
