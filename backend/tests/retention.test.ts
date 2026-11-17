import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiMessage, Summary } from "@summarly/contracts";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL_MS,
  MIN_RETENTION_INTERVAL_MS,
  parseRetentionDays,
  parseRetentionIntervalMs,
  RetentionService,
} from "../src/lib/retention.js";
import { InMemoryStore, type Store } from "../src/lib/store.js";

/**
 * Automatic message retention (MESSAGE_RETENTION_DAYS): captured
 * messages older than N days are deleted; 0 keeps them forever.
 * Retention applies to messages ONLY — summaries, runs, and settings
 * are kept (a summary's source refs may dangle afterwards).
 */

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const CHAT_ID = "120363000000000001@g.us";

function apiMessage(sentAt: string): ApiMessage {
  return {
    id: randomUUID(),
    chatId: CHAT_ID,
    sentAt,
    senderId: "111@s.whatsapp.net",
    senderName: null,
    body: "hello",
    messageType: "text",
  };
}

/** A store stub that records the cutoffs it was asked to delete before. */
function recordingStore(calls: Date[]): Pick<Store, "deleteMessagesBefore"> {
  return {
    deleteMessagesBefore: async (before: Date) => {
      calls.push(before);
      return 3;
    },
  };
}

describe("InMemoryStore.deleteMessagesBefore", () => {
  it("deletes only messages strictly older than the cutoff and returns the count", async () => {
    const store = new InMemoryStore();
    const older = apiMessage("2026-11-01T10:00:00Z");
    const atCutoff = apiMessage("2026-11-09T12:00:00Z");
    const newer = apiMessage("2026-11-15T10:00:00Z");
    store.seedMessages([older, atCutoff, newer]);

    const deleted = await store.deleteMessagesBefore(
      new Date("2026-11-09T12:00:00Z"),
    );
    expect(deleted).toBe(1);

    const remaining = await store.listGroupMessages(CHAT_ID, { limit: 50 });
    expect(remaining.map((message) => message.id).sort()).toEqual(
      [atCutoff.id, newer.id].sort(),
    );

    // Nothing left before an earlier cutoff is a no-op (count 0).
    expect(await store.deleteMessagesBefore(new Date("2020-01-01T00:00:00Z"))).toBe(
      0,
    );
  });

  it("keeps summary runs and summaries (retention applies to messages only)", async () => {
    const store = new InMemoryStore();
    const groupId = randomUUID();
    const { run } = await store.createOrFindRun({
      groupId,
      interval: {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-02T00:00:00Z",
        timezone: "UTC",
      },
      kind: "manual",
    });
    const summary: Summary = {
      id: randomUUID(),
      runId: run.id,
      provider: "mock",
      model: "mock-1",
      result: {
        overview: "Retention test summary.",
        keyDiscussions: [],
        confirmedDecisions: [],
        proposals: [],
        unresolvedQuestions: [],
        tasks: [],
        links: [],
        aiGenerated: true,
      },
      createdAt: "2026-11-02T00:00:00Z",
    };
    await store.saveSummary(summary);
    store.seedMessages([apiMessage("2026-10-01T10:00:00Z")]);

    expect(await store.deleteMessagesBefore(new Date("2026-11-01T00:00:00Z"))).toBe(
      1,
    );
    expect(await store.getRun(run.id)).toBeDefined();
    expect(await store.getSummaryByRunId(run.id)).toBeDefined();
  });
});

describe("retention configuration parsing", () => {
  it("parses MESSAGE_RETENTION_DAYS with 0 (keep forever) as the default", () => {
    expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(parseRetentionDays("")).toBe(0);
    expect(parseRetentionDays(" 0 ")).toBe(0);
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays("365")).toBe(365);
  });

  it("rejects negative and fractional retention days", () => {
    expect(() => parseRetentionDays("-1")).toThrow(/non-negative integer/);
    expect(() => parseRetentionDays("1.5")).toThrow(/non-negative integer/);
    expect(() => parseRetentionDays("forever")).toThrow(/non-negative integer/);
  });

  it("parses RETENTION_INTERVAL_MS with a one-day default and a 60s floor", () => {
    expect(parseRetentionIntervalMs(undefined)).toBe(
      DEFAULT_RETENTION_INTERVAL_MS,
    );
    expect(parseRetentionIntervalMs("")).toBe(86_400_000);
    expect(parseRetentionIntervalMs("60000")).toBe(60_000);
    expect(parseRetentionIntervalMs("1000")).toBe(MIN_RETENTION_INTERVAL_MS);
    expect(() => parseRetentionIntervalMs("0")).toThrow(/positive integer/);
    expect(() => parseRetentionIntervalMs("soon")).toThrow(/positive integer/);
  });
});

describe("RetentionService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when retention is disabled (0 days)", async () => {
    const calls: Date[] = [];
    const events: string[] = [];
    const service = new RetentionService({
      store: recordingStore(calls),
      retentionDays: 0,
      intervalMs: 60_000,
      now: () => NOW,
      log: (event) => events.push(event),
    });

    expect(await service.runOnce()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("deletes before now - N days and logs the pass without content", async () => {
    const calls: Date[] = [];
    const logged: Array<{
      event: string;
      fields: Record<string, string | number | boolean | null>;
    }> = [];
    const service = new RetentionService({
      store: recordingStore(calls),
      retentionDays: 7,
      intervalMs: 60_000,
      now: () => NOW,
      log: (event, fields) => logged.push({ event, fields }),
    });

    expect(await service.runOnce()).toBe(3);
    expect(calls).toHaveLength(1);
    // Cutoff math: exactly 7 * 24h before `now`, as an instant.
    expect(calls[0]?.getTime()).toBe(NOW - 7 * DAY_MS);
    expect(logged).toEqual([
      {
        event: "retention_pass",
        fields: {
          retentionDays: 7,
          cutoff: "2026-11-09T12:00:00.000Z",
          deleted: 3,
        },
      },
    ]);
  });

  it("runs one pass at startup and then on the interval; stop() halts it", async () => {
    vi.useFakeTimers();
    const calls: Date[] = [];
    const service = new RetentionService({
      store: recordingStore(calls),
      retentionDays: 30,
      intervalMs: 1000,
      now: () => NOW,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0); // startup pass
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);

    await service.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2); // timer fully stopped

    // Idempotent start/stop.
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);
    await service.stop();
  });

  it("logs retention_failed and does not throw when the delete fails", async () => {
    const logged: Array<{
      event: string;
      fields: Record<string, string | number | boolean | null>;
    }> = [];
    const service = new RetentionService({
      store: {
        deleteMessagesBefore: async () => {
          throw new Error("database is unreachable");
        },
      },
      retentionDays: 7,
      intervalMs: 1000,
      now: () => NOW,
      log: (event, fields) => logged.push({ event, fields }),
    });

    await expect(service.runOnce()).resolves.toBe(0);
    expect(logged).toEqual([
      { event: "retention_failed", fields: { reason: "Error" } },
    ]);
  });

  it("survives a failing interval pass (start never crashes the backend)", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const service = new RetentionService({
      store: {
        deleteMessagesBefore: async () => {
          throw new Error("database is unreachable");
        },
      },
      retentionDays: 7,
      intervalMs: 1000,
      now: () => NOW,
      log: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);
    await service.stop();
    expect(events).toEqual(["retention_failed", "retention_failed"]);
  });
});
