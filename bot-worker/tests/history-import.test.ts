import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HistoryImportService,
  type HistoryImportBudgets,
} from "../src/history-import.js";
import {
  FakeAdapter,
  FakeDb,
  findEvents,
  logsContain,
  rawMessage,
  recordingLogger,
  sleep,
  waitFor,
  type LogEntry,
} from "./fakes.js";
import { safeChatRef } from "../src/lib/privacy.js";

/**
 * History import (ADR 0007) with a fake adapter and fake database: no
 * WhatsApp account, no network. Covers claim/complete flow, budgets,
 * the privacy boundary, failure codes, stale recovery, and shutdown.
 */

const GROUP_A = "111111111111-22222222@g.us";
const GROUP_B = "333333333333-44444444@g.us";

interface Harness {
  adapter: FakeAdapter;
  db: FakeDb;
  logs: LogEntry[];
  service: HistoryImportService;
}

function harness(
  budgets: Partial<HistoryImportBudgets> = {},
  now?: () => number,
): Harness {
  const adapter = new FakeAdapter();
  const db = new FakeDb();
  const logs: LogEntry[] = [];
  const service = new HistoryImportService({
    adapter,
    db,
    log: recordingLogger(logs),
    budgets: {
      roundSettleMs: 20,
      roundTimeoutMs: 120,
      pollMs: 5,
      ...budgets,
    },
    now,
  });
  return { adapter, db, logs, service };
}

/** Registers a monitored group with a pending history-import request. */
function seedImport(db: FakeDb, chatJid = GROUP_A, monitored = true): string {
  db.groups.set(chatJid, {
    id: randomUUID(),
    name: "Group",
    monitored,
    timezone: "UTC",
    summaryTime: null,
  });
  // On-demand history needs a real anchor message to page back from.
  // A far-future timestamp keeps every scripted response "older".
  db.historyAnchors.set(chatJid, {
    messageId: "ANCHOR",
    fromMe: false,
    timestampSec: 2_000_000_000,
  });
  db.requestHistoryImport(chatJid);
  return db.groups.get(chatJid)?.id ?? "";
}

/**
 * Scripted responses for requestHistory(): each call shifts one batch
 * to emit (empty array = WhatsApp answers with nothing). The service
 * collects asynchronously, so the emission is scheduled inside the
 * round's settle window.
 */
function scriptResponses(
  adapter: FakeAdapter,
  script: Array<() => void>,
): void {
  adapter.onRequestHistory = () => {
    const respond = script.shift();
    if (respond === undefined) return; // no more batches
    setTimeout(respond, 1);
  };
}

describe("history import: claim → request → ingest → done", () => {
  it("imports the fetched messages once and reports done with the inserted count", async () => {
    const h = harness();
    const groupId = seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1", text: "one", timestampSec: 300 }),
          rawMessage({ messageId: "H2", text: "two", timestampSec: 200 }),
          rawMessage({ messageId: "H3", text: "three", timestampSec: 100 }),
        ]),
    ]);

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyImportedCount).toBe(3);
    expect(group?.historyError).toBeNull();
    expect(group?.historyFinishedAt).toBeInstanceOf(Date);
    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual([
      "H1",
      "H2",
      "H3",
    ]);

    // Round 1 pages back from the oldest captured message; round 2 pages
    // backwards from the OLDEST message received.
    expect(h.adapter.historyRequests).toHaveLength(2);
    expect(h.adapter.historyRequests[0]?.cursor).toEqual({
      messageId: "ANCHOR",
      fromMe: false,
      timestampSec: 2_000_000_000,
    });
    expect(h.adapter.historyRequests[1]?.cursor).toEqual({
      messageId: "H3",
      fromMe: false,
      timestampSec: 100,
    });

    // Historical imports never masquerade as live traffic (ADR 0007).
    expect(h.db.lastMessageTouches).toBe(0);
    // Stale history events after completion are ignored (adapter release).
    expect(h.adapter.releasedHistoryChats).toContain(GROUP_A);
    // Reaching the claim is logged with safe identifiers only.
    expect(findEvents(h.logs, "history_import_started")).toHaveLength(1);
    expect(findEvents(h.logs, "history_import_completed")[0]?.fields).toMatchObject({
      groupId,
      status: "done",
      importedCount: 3,
      // Diagnostics: the payload arrived; the phone sent no PDO answer.
      sawHistoryNotification: true,
      sawPdoResponse: false,
    });
  });

  it("logs history_request_sent at info with a hashed chat ref (diagnostics)", async () => {
    const h = harness({ roundSettleMs: 20, roundTimeoutMs: 80 });
    const groupId = seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1", timestampSec: 300 }),
        ]),
    ]);

    await h.service.runOnce();

    const sent = findEvents(h.logs, "history_request_sent");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]?.level).toBe("info");
    expect(sent[0]?.fields).toMatchObject({
      groupId,
      chatRef: safeChatRef(GROUP_A),
      round: 1,
      count: 50,
      cursorFromMe: false,
    });
    // The anchor's age is numeric; the seeded anchor is in the future,
    // which yields a negative age (itself a useful diagnostic).
    expect(typeof sent[0]?.fields["cursorAgeMs"]).toBe("number");
    // Privacy: the raw chat JID never reaches the logs.
    expect(logsContain(h.logs, GROUP_A)).toBe(false);
  });

  it("counts duplicate deliveries once (idempotent ingestion)", async () => {
    const h = harness();
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1", timestampSec: 300 }),
          rawMessage({ messageId: "H2", timestampSec: 200 }),
        ]),
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H2", timestampSec: 200 }), // duplicate
          rawMessage({ messageId: "H3", timestampSec: 100 }),
        ]),
      () => h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H3" })]),
    ]);

    await h.service.runOnce();

    expect(h.db.messages).toHaveLength(3);
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyImportedCount).toBe(3); // inserted, not received
  });

  it("ignores history batches for other chats (privacy)", async () => {
    const h = harness();
    seedImport(h.db);
    h.db.groups.set(GROUP_B, {
      id: randomUUID(),
      name: "B",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    scriptResponses(h.adapter, [
      () => {
        h.adapter.emitHistory(GROUP_B, [
          rawMessage({ chatJid: GROUP_B, messageId: "OTHER" }),
        ]);
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ chatJid: GROUP_A, messageId: "H1" }),
        ]);
      },
    ]);

    await h.service.runOnce();

    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual(["H1"]);
  });

  it("collects a SLOW first response instead of mis-reporting it (CR-M1)", async () => {
    // The response arrives after the settle window (20ms) but well
    // within the round timeout (300ms). The old settle-only logic ended
    // the round before the response and failed the import with
    // history_timeout; the fixed logic waits for the FIRST batch.
    const h = harness({ roundSettleMs: 20, roundTimeoutMs: 300 });
    seedImport(h.db);
    const script: Array<() => void> = [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "SLOW1", timestampSec: 200 }),
          rawMessage({ messageId: "SLOW2", timestampSec: 100 }),
        ]),
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "SLOW3", timestampSec: 50 }),
        ]),
    ];
    h.adapter.onRequestHistory = () => {
      const respond = script.shift();
      if (respond !== undefined) setTimeout(respond, 80); // > settle, < timeout
    };

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyError).toBeNull();
    expect(group?.historyImportedCount).toBe(3);
    expect(h.db.messages).toHaveLength(3);
    // Both slow rounds were collected; a third round finds no answer
    // and concludes the import as done.
    expect(h.adapter.historyRequests).toHaveLength(3);
  });

  it("still times out when a round never answers (CR-M1)", async () => {
    const h = harness({ roundSettleMs: 20, roundTimeoutMs: 80 });
    seedImport(h.db);
    scriptResponses(h.adapter, []); // silence

    await h.service.runOnce();

    // The FIRST-batch wait is the true round timeout (80ms), not the
    // settle window: no answer within it => history_timeout.
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("history_timeout");
  });

  it("publishes incremental progress after every round (CR-M2)", async () => {
    const h = harness();
    const groupId = seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1", timestampSec: 300 }),
          rawMessage({ messageId: "H2", timestampSec: 200 }),
        ]),
      () => h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H3", timestampSec: 100 })]),
    ]);

    await h.service.runOnce();

    // After round 1 the running count is 2; after round 2 it is 3 — the
    // dashboard can render "N imported so far" before the terminal
    // state. The final terminal count is exact.
    expect(h.db.historyProgressUpdates).toEqual([
      { groupId, importedCount: 2 },
      { groupId, importedCount: 3 },
    ]);
    expect(h.db.groups.get(GROUP_A)?.historyImportedCount).toBe(3);
    expect(h.db.groups.get(GROUP_A)?.historyStatus).toBe("done");
  });

  it("caps the per-round buffer and counts overflow (SA-L4)", async () => {
    const h = harness({ maxMessages: 2 }); // buffer cap = 4
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1" }),
          rawMessage({ messageId: "H2" }),
          rawMessage({ messageId: "H3" }),
          rawMessage({ messageId: "H4" }),
          rawMessage({ messageId: "H5" }),
          rawMessage({ messageId: "H6" }),
        ]),
    ]);

    await h.service.runOnce();

    const overflow = findEvents(h.logs, "history_buffer_overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.level).toBe("warn");
    expect(overflow[0]?.fields).toMatchObject({ count: 2 }); // H5/H6 dropped
    // The message budget stays exact on top of the buffer cap.
    expect(h.db.groups.get(GROUP_A)?.historyImportedCount).toBe(2);
  });

  it("persists sender names on the history path too (ADR 0008)", async () => {
    const h = harness();
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1", senderName: "Alice" }),
          rawMessage({ messageId: "H2", senderName: null }),
        ]),
    ]);

    await h.service.runOnce();

    // The shared normalize path carries push names into both capture
    // routes; names are PII and never appear in the logs.
    expect(h.db.messages.map((row) => row.senderName)).toEqual(["Alice", null]);
  });
});

describe("history import: bounded budget (partial by design)", () => {
  it("stops after maxRounds even while WhatsApp keeps returning messages", async () => {
    const h = harness({ maxRounds: 2 });
    seedImport(h.db);
    const emit = (id: string) => () =>
      h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: id })]);
    scriptResponses(h.adapter, [
      emit("H1"),
      emit("H2"),
      emit("H3"),
      emit("H4"),
    ]);

    await h.service.runOnce();

    expect(h.adapter.historyRequests).toHaveLength(2);
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done"); // budget end ≠ failure
    expect(group?.historyImportedCount).toBe(2);
  });

  it("stops after maxMessages", async () => {
    const h = harness({ maxMessages: 3 });
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H1" }),
          rawMessage({ messageId: "H2" }),
        ]),
      () =>
        h.adapter.emitHistory(GROUP_A, [
          rawMessage({ messageId: "H3" }),
          rawMessage({ messageId: "H4" }),
          rawMessage({ messageId: "H5" }),
        ]),
    ]);

    await h.service.runOnce();

    // The budget is exact: the second batch is truncated to the room
    // left under maxMessages (partial by design).
    expect(h.adapter.historyRequests).toHaveLength(2);
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyImportedCount).toBe(3);
    expect(h.db.messages).toHaveLength(3);
  });

  it("stops when the time budget is exhausted", async () => {
    let nowMs = 0;
    const h = harness({ timeBudgetMs: 100, maxRounds: 10 }, () => nowMs);
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () => {
        h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H1" })]);
        nowMs = 500; // the budget (100ms) is now exhausted
      },
      () => h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H2" })]),
    ]);

    await h.service.runOnce();

    // The budget expired before the second round could start.
    expect(h.adapter.historyRequests).toHaveLength(1);
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyImportedCount).toBe(1);
  });
});

describe("history import: privacy boundary", () => {
  it("never claims an unmonitored group's pending request", async () => {
    const h = harness();
    seedImport(h.db, GROUP_A, false); // requested, but NOT monitored

    await h.service.runOnce();

    expect(h.adapter.historyRequests).toHaveLength(0);
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("pending"); // untouched, claimable later
  });

  it("stops and fails with group_unmonitored when the group is unmonitored mid-import", async () => {
    const h = harness();
    seedImport(h.db);
    scriptResponses(h.adapter, [
      () => {
        h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H1" })]);
        // The admin unmonitors the group while the batch is in flight:
        // the monitored-only INSERT refuses the row and the next round
        // must not ask WhatsApp for anything more.
        h.db.adminConfigure(GROUP_A, { monitored: false });
      },
    ]);

    await h.service.runOnce();

    expect(h.adapter.historyRequests).toHaveLength(1);
    expect(h.db.messages).toHaveLength(0); // nothing ingested
    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("group_unmonitored");
    expect(group?.historyImportedCount).toBe(0);
  });
});

describe("history import: failures and recovery", () => {
  it("marks the import failed with history_unavailable when the request throws", async () => {
    const h = harness();
    seedImport(h.db);
    h.adapter.requestHistoryError = new Error("not linked");

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("history_unavailable");
    // The log carries the safe reason; the column only the code.
    expect(findEvents(h.logs, "history_request_failed")[0]?.fields).toMatchObject({
      reason: "not linked",
    });
  });

  it("marks the import failed with history_timeout when WhatsApp never answers", async () => {
    const h = harness();
    seedImport(h.db);
    scriptResponses(h.adapter, []); // request accepted, silence

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("history_timeout");
  });

  it("warns history_round_timeout when a round ends with no answer (diagnostics)", async () => {
    const h = harness({ roundTimeoutMs: 80 });
    const groupId = seedImport(h.db);
    scriptResponses(h.adapter, []); // request relayed, then silence

    await h.service.runOnce();

    const timeouts = findEvents(h.logs, "history_round_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.level).toBe("warn");
    expect(timeouts[0]?.fields).toMatchObject({
      groupId,
      chatRef: safeChatRef(GROUP_A),
      round: 1,
      gotAnyBatch: false,
      importSuccess: false,
      importFailure: null,
    });
    // The completion log says neither a PDO answer nor a notification
    // ever arrived — the signature of a silent phone.
    expect(
      findEvents(h.logs, "history_import_completed")[0]?.fields,
    ).toMatchObject({
      status: "failed",
      error: "history_timeout",
      sawPdoResponse: false,
      sawHistoryNotification: false,
    });
    expect(logsContain(h.logs, GROUP_A)).toBe(false);
  });

  it("finishes as done with 0 when the phone reports success but no history", async () => {
    const h = harness({
      roundTimeoutMs: 100,
      roundSettleMs: 10,
      successGraceMs: 10,
    });
    seedImport(h.db);
    h.adapter.onRequestHistory = () => {
      setTimeout(
        () => h.adapter.emit({ type: "history-success", chatJid: GROUP_A }),
        1,
      );
    };

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("done");
    expect(group?.historyImportedCount).toBe(0);
    expect(group?.historyError).toBeNull();
    // Diagnostics: the PDO answer arrived, the payload did not.
    expect(
      findEvents(h.logs, "history_import_completed")[0]?.fields,
    ).toMatchObject({
      sawPdoResponse: true,
      sawHistoryNotification: false,
    });
    // A REQUEST_SUCCESS is not a silent round: no timeout warning.
    expect(findEvents(h.logs, "history_round_timeout")).toHaveLength(0);
  });

  it("stops immediately when the phone reports a failure code", async () => {
    const h = harness();
    seedImport(h.db);
    h.adapter.onRequestHistory = () => {
      setTimeout(
        () =>
          h.adapter.emit({
            type: "history-error",
            chatJid: GROUP_A,
            reason: "history_phone_offline",
          }),
        1,
      );
    };

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("history_phone_offline");
    expect(h.adapter.historyRequests).toHaveLength(1);
    // Diagnostics: the failure came from a PDO answer, not from silence.
    expect(
      findEvents(h.logs, "history_import_completed")[0]?.fields,
    ).toMatchObject({
      sawPdoResponse: true,
      sawHistoryNotification: false,
    });
    expect(findEvents(h.logs, "history_round_timeout")).toHaveLength(0);
  });

  it("fails fast with history_no_anchor when the chat has no captured messages", async () => {    const h = harness();
    h.db.groups.set(GROUP_A, {
      id: randomUUID(),
      name: "Empty",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    h.db.requestHistoryImport(GROUP_A);

    await h.service.runOnce();

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("failed");
    expect(group?.historyError).toBe("history_no_anchor");
    expect(h.adapter.historyRequests).toHaveLength(0);
    expect(findEvents(h.logs, "history_no_anchor")).toHaveLength(1);
  });

  it("recovers stale running claims (crashed worker) and re-runs them", async () => {
    const h = harness();
    const groupId = seedImport(h.db);
    const group = h.db.groups.get(GROUP_A);
    if (group === undefined) throw new Error("seed failed");
    // A crashed worker left the claim 'running' 20 minutes ago.
    group.historyStatus = "running";
    group.historyStartedAt = new Date(Date.now() - 20 * 60_000);
    scriptResponses(h.adapter, [
      () => h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H1" })]),
    ]);

    await h.service.runOnce();

    expect(findEvents(h.logs, "history_claims_requeued")[0]?.fields).toMatchObject({
      count: 1,
    });
    expect(group.historyStatus).toBe("done");
    expect(group.historyImportedCount).toBe(1);
    expect(h.adapter.historyRequests).toHaveLength(2);
    expect(
      findEvents(h.logs, "history_import_completed")[0]?.fields["groupId"],
    ).toBe(groupId);
  });

  it("does not requeue recent running claims", async () => {
    const h = harness();
    seedImport(h.db);
    const group = h.db.groups.get(GROUP_A);
    if (group === undefined) throw new Error("seed failed");
    group.historyStatus = "running";
    group.historyStartedAt = new Date(Date.now() - 30_000); // within 10 min

    await h.service.runOnce();

    expect(findEvents(h.logs, "history_claims_requeued")).toHaveLength(0);
    expect(h.adapter.historyRequests).toHaveLength(0);
    expect(group.historyStatus).toBe("running");
  });
});

describe("history import: budget validation (SA-L1)", () => {
  it("rejects budgets that violate the staleness invariant", () => {
    // timeBudget + roundTimeout must stay below staleMs (600000 here):
    // a slow-but-active import must never look stale to the recovery.
    // (The harness uses roundTimeoutMs 120.)
    expect(() => harness({ timeBudgetMs: 599_900 })).toThrow(/staleness invariant/);
    expect(() => harness({ roundTimeoutMs: 500_000 })).toThrow(/staleness invariant/);
  });

  it("accepts budgets within the invariant", () => {
    expect(() => harness({ timeBudgetMs: 500_000 })).not.toThrow();
  });

  it("rejects out-of-bound effort knobs", () => {
    expect(() => harness({ batchCount: 501 })).toThrow(/batchCount/);
    expect(() => harness({ maxRounds: 101 })).toThrow(/maxRounds/);
    expect(() => harness({ maxMessages: 20_001 })).toThrow(/maxMessages/);
    expect(() => harness({ batchCount: 0 })).toThrow(/batchCount/);
  });
});

describe("history import: lifecycle", () => {
  it("graceful stop releases the claim back to pending", async () => {
    const h = harness();
    seedImport(h.db);
    scriptResponses(h.adapter, []); // first round will block in its wait

    h.service.start();
    await waitFor("the import to start", () =>
      h.adapter.historyRequests.length > 0 ? true : undefined,
    );
    await h.service.stop();
    await sleep(20);

    const group = h.db.groups.get(GROUP_A);
    expect(group?.historyStatus).toBe("pending"); // immediately re-claimable
    expect(findEvents(h.logs, "history_import_released")).toHaveLength(1);
    expect(h.adapter.releasedHistoryChats).toContain(GROUP_A);
    // The poll loop is stopped: nothing else runs.
    const requests = h.adapter.historyRequests.length;
    await sleep(30);
    expect(h.adapter.historyRequests.length).toBe(requests);
  });

  it("polls for new pending requests until stopped", async () => {
    const h = harness();
    scriptResponses(h.adapter, [
      () => h.adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H1" })]),
    ]);
    h.service.start();
    // A request recorded later must still be picked up by the poller.
    await sleep(15);
    seedImport(h.db);
    await waitFor("the polled import to finish", async () =>
      h.db.groups.get(GROUP_A)?.historyStatus === "done" ? true : undefined,
    );
    await h.service.stop();
    expect(h.db.messages).toHaveLength(1);
  });
});
