import { describe, expect, it } from "vitest";
import { safeChatRef } from "../src/lib/privacy.js";
import {
  CaptureService,
  LINKING_QR_TTL_MS,
  PAIRING_CODE_TTL_MS,
  STATUS_TO_DB,
  type CaptureLimits,
  type LinkingInfo,
} from "../src/service.js";
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

/**
 * CaptureService behavior with a fake adapter and fake database (ADR
 * 0004). No WhatsApp account, no network, no real sockets.
 */

const BACKOFF = { baseMs: 5, capMs: 20 };
const GROUP_A = "111111111111-22222222@g.us";
const GROUP_B = "333333333333-44444444@g.us";

interface Harness {
  adapter: FakeAdapter;
  db: FakeDb;
  logs: LogEntry[];
  linking: LinkingInfo[];
  service: CaptureService;
}

function harness(
  options: { defaultTimezone?: string; limits?: Partial<CaptureLimits> } = {},
): Harness {
  const adapter = new FakeAdapter();
  const db = new FakeDb();
  const logs: LogEntry[] = [];
  const linking: LinkingInfo[] = [];
  const service = new CaptureService({
    adapter,
    db,
    log: recordingLogger(logs),
    defaultTimezone: options.defaultTimezone ?? "UTC",
    backoff: BACKOFF,
    limits: options.limits,
    onLinking: (info) => linking.push(info),
  });
  return { adapter, db, logs, linking, service };
}

describe("connection status state machine", () => {
  it("maps every status to the documented DB state", () => {
    expect(STATUS_TO_DB).toEqual({
      connecting: "connecting",
      connected: "connected",
      disconnected: "disconnected",
      "lost-logged-out": "unavailable",
    });
  });

  it("follows connecting -> connected -> disconnected -> reconnecting", async () => {
    const h = harness();
    await h.service.start();
    expect(h.service.sessionStatus).toBe("connecting");
    expect(h.db.stateHistory).toEqual(["connecting"]);

    h.adapter.emit({ type: "open" });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("connected");
    expect(h.db.stateHistory).toEqual(["connecting", "connected"]);

    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("disconnected");
    expect(h.db.stateHistory).toEqual([
      "connecting",
      "connected",
      "disconnected",
    ]);

    await waitFor("reconnect attempt", () =>
      h.adapter.connectCalls >= 2 ? true : undefined,
    );
    expect(h.service.sessionStatus).toBe("connecting");

    h.adapter.emit({ type: "open" });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("connected");
    await h.service.stop();
  });

  it("stops retrying on a terminal close and persists 'unavailable'", async () => {
    const h = harness();
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    h.adapter.emit({ type: "close", retryable: false, reason: "logged_out" });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("lost-logged-out");
    expect(h.db.stateHistory.at(-1)).toBe("unavailable");
    expect(findEvents(h.logs, "session_lost_relink_required")).toHaveLength(1);

    // No reconnect, ever.
    await sleep(60);
    expect(h.adapter.connectCalls).toBe(1);

    // A late close event must not resurrect retries either.
    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    await sleep(30);
    expect(h.adapter.connectCalls).toBe(1);

    // Shutdown keeps the lost state instead of downgrading it.
    await h.service.stop();
    expect(h.db.stateHistory.at(-1)).toBe("unavailable");
  });

  it("retries with capped exponential backoff across repeated transient closes", async () => {
    const h = harness();
    await h.service.start();

    for (const expectedCalls of [2, 3, 4, 5]) {
      h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
      await h.service.idle();
      await waitFor(`connect call ${expectedCalls}`, () =>
        h.adapter.connectCalls >= expectedCalls ? true : undefined,
      );
    }

    const delays = findEvents(h.logs, "reconnect_scheduled").map(
      (entry) => entry.fields["delayMs"],
    );
    expect(delays).toEqual([5, 10, 20, 20]); // doubled, then capped
    await h.service.stop();
  });

  it("schedules a retry when connect() itself throws", async () => {
    const h = harness();
    h.adapter.connectError = new Error("network down");
    await h.service.start();
    expect(h.service.sessionStatus).toBe("disconnected");
    expect(findEvents(h.logs, "connect_failed")).toHaveLength(1);

    await waitFor("a retry after the failed connect", () =>
      h.adapter.connectCalls >= 2 ? true : undefined,
    );
    expect(findEvents(h.logs, "reconnect_scheduled").length).toBeGreaterThanOrEqual(1);
    await h.service.stop();
  });

  it("tolerates discovery failures without losing the connection", async () => {
    const h = harness();
    h.adapter.fetchChatsError = new Error("query failed");
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("connected");
    expect(findEvents(h.logs, "discovery_failed")).toHaveLength(1);
    await h.service.stop();
  });
});

describe("group discovery (privacy-first opt-in)", () => {
  it("registers discovered groups unmonitored with the default time zone", async () => {
    const h = harness({ defaultTimezone: "Europe/Berlin" });
    h.adapter.fetchChatsResults = [{ chatJid: GROUP_A, name: "Team", members: [] }];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    const group = h.db.groups.get(GROUP_A);
    expect(group).toBeDefined();
    expect(group?.monitored).toBe(false); // admin must opt in
    expect(group?.timezone).toBe("Europe/Berlin");
    expect(group?.summaryTime).toBeNull();
    expect(findEvents(h.logs, "discovery_complete")[0]?.fields).toMatchObject({
      chats: 1,
      inserted: 1,
      updated: 0,
    });
    await h.service.stop();
  });

  it("prefers the app_settings default time zone over the env fallback", async () => {
    const h = harness({ defaultTimezone: "Europe/Berlin" });
    h.db.defaultTimezone = "Asia/Tokyo";
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Team", members: [] },
    ];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    expect(h.db.groups.get(GROUP_A)?.timezone).toBe("Asia/Tokyo");
    await h.service.stop();
  });

  it("NEVER clobbers admin preferences on rename or re-discovery (regression)", async () => {    const h = harness();
    h.adapter.fetchChatsResults = [{ chatJid: GROUP_A, name: "Team", members: [] }];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    // The admin opts the group in and configures it.
    h.db.adminConfigure(GROUP_A, {
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: "09:00",
    });
    const configuredId = h.db.groups.get(GROUP_A)?.id;

    // A subject rename (live event) updates ONLY the name.
    h.adapter.emit({
      type: "chat-updated",
      chat: { chatJid: GROUP_A, name: "Team Renamed", members: [] },
    });
    await h.service.idle();
    let group = h.db.groups.get(GROUP_A);
    expect(group?.name).toBe("Team Renamed");
    expect(group?.monitored).toBe(true);
    expect(group?.timezone).toBe("Europe/Madrid");
    expect(group?.summaryTime).toBe("09:00");
    expect(group?.id).toBe(configuredId);

    // A full re-discovery (reconnect) must also keep the preferences.
    h.adapter.fetchChatsResults = [{ chatJid: GROUP_A, name: "Team v3", members: [] }];
    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    await waitFor("reconnect", () =>
      h.adapter.connectCalls >= 2 ? true : undefined,
    );
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    group = h.db.groups.get(GROUP_A);
    expect(group?.name).toBe("Team v3");
    expect(group?.monitored).toBe(true);
    expect(group?.timezone).toBe("Europe/Madrid");
    expect(group?.summaryTime).toBe("09:00");
    expect(group?.id).toBe(configuredId);
    await h.service.stop();
  });

  it("adds newly discovered groups next to existing ones", async () => {
    const h = harness();
    h.adapter.fetchChatsResults = [{ chatJid: GROUP_A, name: "A", members: [] }];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "A", members: [] },
      { chatJid: GROUP_B, name: "B", members: [] },
    ];
    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    await waitFor("reconnect", () =>
      h.adapter.connectCalls >= 2 ? true : undefined,
    );
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    expect([...h.db.groups.keys()].sort()).toEqual([GROUP_A, GROUP_B].sort());
    await h.service.stop();
  });
});

describe("message capture filters", () => {
  it("captures only monitored groups; unmonitored and unknown chats are dropped", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    // GROUP_B exists but is not monitored; GROUP_C does not exist.

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A, text: "one" }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A, text: "two" }),
      rawMessage({ messageId: "M3", chatJid: GROUP_B, text: "three" }),
      rawMessage({ messageId: "M4", chatJid: "unknown@g.us", text: "four" }),
    );
    await h.service.idle();

    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual([
      "M1",
      "M2",
    ]);
    const dropped = findEvents(h.logs, "messages_dropped_unmonitored");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.fields["count"]).toBe(2);
    await h.service.stop();
  });

  it("honors a live monitoring toggle", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: false,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(rawMessage({ messageId: "M1", chatJid: GROUP_A }));
    await h.service.idle();
    expect(h.db.messages).toHaveLength(0);

    h.db.adminConfigure(GROUP_A, { monitored: true });
    h.adapter.emitMessages(rawMessage({ messageId: "M2", chatJid: GROUP_A }));
    await h.service.idle();
    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual(["M2"]);
    await h.service.stop();
  });

  it("counts duplicate deliveries as already captured (one row)", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(rawMessage({ messageId: "M1", chatJid: GROUP_A }));
    await h.service.idle();
    h.adapter.emitMessages(rawMessage({ messageId: "M1", chatJid: GROUP_A }));
    await h.service.idle();

    expect(h.db.messages).toHaveLength(1);
    const persisted = findEvents(h.logs, "messages_persisted");
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.fields).toMatchObject({
      captured: 1,
      inserted: 0,
      duplicates: 1,
    });
    await h.service.stop();
  });

  it("counts and logs every skip reason without persisting anything", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(
      rawMessage({ messageId: "S2", chatJid: GROUP_A, kind: "reaction" }),
      rawMessage({ messageId: "S3", chatJid: GROUP_A, kind: "protocol" }),
      rawMessage({ messageId: "S4", chatJid: GROUP_A, kind: "system" }),
      rawMessage({ messageId: "S5", chatJid: GROUP_A, kind: "empty" }),
      rawMessage({ messageId: "S6", chatJid: "status@broadcast" }),
      rawMessage({ messageId: "S7", chatJid: "someone@s.whatsapp.net" }),
    );
    await h.service.idle();

    expect(h.db.messages).toHaveLength(0);
    expect(h.db.insertCalls).toHaveLength(0);
    const skipped = findEvents(h.logs, "messages_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.fields).toMatchObject({
      total: 6,
      reaction: 1,
      protocol: 1,
      system: 1,
      "unsupported-type": 1,
      "status-broadcast": 1,
      "not-group": 1,
    });
    await h.service.stop();
  });

  it("captures the linked account's own group messages", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(
      rawMessage({
        messageId: "OWN1",
        chatJid: GROUP_A,
        fromMe: true,
        text: "my own update",
      }),
    );
    await h.service.idle();

    expect(h.db.messages).toHaveLength(1);
    expect(h.db.messages[0]?.fromMe).toBe(true);
    expect(h.db.messages[0]?.body).toBe("my own update");
    await h.service.stop();
  });

  it("batches a synchronous burst into one insert", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A }),
    );
    h.adapter.emitMessages(rawMessage({ messageId: "M3", chatJid: GROUP_A }));
    await h.service.idle();

    expect(h.db.insertCalls).toHaveLength(1);
    expect(h.db.insertCalls[0]).toHaveLength(3);
    expect(h.db.messages).toHaveLength(3);
    await h.service.stop();
  });

  it("logs per-chat capture summaries at debug level with hashed chat refs", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A, text: "secret body" }),
    );
    await h.service.idle();

    const captured = findEvents(h.logs, "messages_captured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe("debug");
    // Audit L1: legacy group JIDs embed phone numbers — the log carries
    // a hashed reference, never the raw JID.
    expect(captured[0]?.fields).toEqual({
      chatRef: safeChatRef(GROUP_A),
      captured: 1,
    });
    expect(logsContain(h.logs, GROUP_A)).toBe(false);
    // The message body must never appear anywhere in the logs.
    expect(logsContain(h.logs, "secret body")).toBe(false);
    await h.service.stop();
  });

  it("retries a failed batch insert and lands the messages once (CR-M2)", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    h.db.insertFailures.push(new Error("transient write failure"));

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A }),
    );
    await h.service.idle();

    // First attempt failed, the retry succeeded: rows land exactly once.
    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual([
      "M1",
      "M2",
    ]);
    expect(h.db.insertCalls).toHaveLength(2);
    expect(findEvents(h.logs, "message_batch_retry")).toHaveLength(1);
    expect(findEvents(h.logs, "message_drain_failed")).toHaveLength(0);
    await h.service.stop();
  });

  it("drops a batch with counts when retries are exhausted (CR-M2)", async () => {
    const h = harness({ limits: { maxBatchAttempts: 3, batchRetryBaseMs: 1 } });
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    h.db.insertFailures.push(
      new Error("failure 1"),
      new Error("failure 2"),
      new Error("failure 3"),
    );

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A }),
      rawMessage({ messageId: "M3", chatJid: GROUP_A }),
    );
    await h.service.idle();

    expect(h.db.messages).toHaveLength(0);
    expect(h.db.insertCalls).toHaveLength(3);
    expect(findEvents(h.logs, "message_batch_retry")).toHaveLength(2);
    const failed = findEvents(h.logs, "message_drain_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toMatchObject({
      attempts: 3,
      captured: 0,
      lost: 3,
    });
    await h.service.stop();
  });

  it("drops the newest messages on queue overflow with a counted log (audit L4)", async () => {
    const h = harness({ limits: { queueCap: 3 } });
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });

    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A }),
      rawMessage({ messageId: "M3", chatJid: GROUP_A }),
      rawMessage({ messageId: "M4", chatJid: GROUP_A }),
      rawMessage({ messageId: "M5", chatJid: GROUP_A }),
    );
    await h.service.idle();

    // Overflow policy: the NEWEST messages are dropped, older queued
    // work is preserved. Every drop is counted at warn level.
    expect(h.db.messages.map((row) => row.whatsappMessageId)).toEqual([
      "M1",
      "M2",
      "M3",
    ]);
    const dropped = findEvents(h.logs, "messages_dropped_overflow");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe("warn");
    expect(dropped[0]?.fields).toMatchObject({ count: 2, queueCap: 3 });
    await h.service.stop();
  });
});

describe("linking UX and shutdown", () => {
  it("presents QR and pairing codes without ever logging them", async () => {
    const h = harness();
    await h.service.start();

    h.adapter.emit({ type: "qr", qr: "SECRET-QR-VALUE" });
    h.adapter.emit({ type: "pairing-code", code: "ABCD-EFGH" });
    await h.service.idle();

    expect(h.linking).toEqual([
      { kind: "qr", qr: "SECRET-QR-VALUE" },
      { kind: "pairing-code", code: "ABCD-EFGH" },
    ]);
    expect(logsContain(h.logs, "SECRET-QR-VALUE")).toBe(false);
    expect(logsContain(h.logs, "ABCD-EFGH")).toBe(false);
    expect(findEvents(h.logs, "linking_qr_pending")).toHaveLength(1);
    expect(findEvents(h.logs, "linking_pairing_code_pending")).toHaveLength(1);
    await h.service.stop();
  });

  it("graceful stop closes the socket, persists 'disconnected', and cancels retries", async () => {
    const h = harness();
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    await h.service.stop();
    expect(h.adapter.disconnectCalls).toBe(1);
    expect(h.db.stateHistory.at(-1)).toBe("disconnected");

    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    await sleep(30);
    expect(h.adapter.connectCalls).toBe(1);
    expect(findEvents(h.logs, "reconnect_scheduled")).toHaveLength(0);
  });

  it("closes a socket created during a concurrent stop (connect/stop race guard)", async () => {
    const h = harness();
    h.adapter.connectDelayMs = 30; // connect() still in flight when stop() runs
    const started = h.service.start();
    await sleep(5);
    const stopped = h.service.stop();
    await Promise.all([started, stopped]);

    // stop() disconnected once; the late connect() completion triggers
    // the race-guard disconnect so no orphan socket survives shutdown.
    expect(h.adapter.disconnectCalls).toBe(2);
    expect(h.service.sessionStatus).toBe("disconnected");
    await sleep(30);
    expect(h.adapter.connectCalls).toBe(1); // never reconnects after stop
  });
});

describe("linking state publication (ADR 0008)", () => {
  it("publishes the QR to the DB row with a TTL and never logs it", async () => {
    const h = harness();
    await h.service.start();
    const before = Date.now();

    h.adapter.emit({ type: "qr", qr: "SECRET-QR-VALUE" });
    await h.service.idle();

    // The row MAY hold the QR (auth-only API reads it) …
    expect(h.db.linking?.qr).toBe("SECRET-QR-VALUE");
    expect(h.db.linking?.kind).toBe("qr"); // kind published (CR#6)
    const ttl = h.db.linking!.expiresAt.getTime();
    expect(ttl).toBeGreaterThanOrEqual(before + LINKING_QR_TTL_MS - 100);
    expect(ttl).toBeLessThanOrEqual(Date.now() + LINKING_QR_TTL_MS + 100);
    // … but the logs must NEVER contain it (existing guarantee, now
    // covering the DB path too).
    expect(logsContain(h.logs, "SECRET-QR-VALUE")).toBe(false);
    expect(h.linking).toEqual([{ kind: "qr", qr: "SECRET-QR-VALUE" }]);
    await h.service.stop();
  });

  it("a new QR replaces the old one; connecting clears it", async () => {
    const h = harness();
    await h.service.start();
    h.adapter.emit({ type: "qr", qr: "QR-ONE" });
    await h.service.idle();
    h.adapter.emit({ type: "qr", qr: "QR-TWO" });
    await h.service.idle();
    expect(h.db.linking?.qr).toBe("QR-TWO"); // replaced, not appended

    h.adapter.emit({ type: "open" });
    await h.service.idle();
    expect(h.db.linking).toBeNull(); // linked: the ticket is gone
    await h.service.stop();
  });

  it("publishes pairing codes with the pairing TTL", async () => {
    const h = harness();
    await h.service.start();
    const before = Date.now();
    h.adapter.emit({ type: "pairing-code", code: "ABCD1234" });
    await h.service.idle();

    expect(h.db.linking?.qr).toBe("ABCD1234");
    expect(h.db.linking?.kind).toBe("pairing-code"); // kind published (CR#6)
    const ttl = h.db.linking!.expiresAt.getTime();
    expect(ttl).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MS - 100);
    expect(logsContain(h.logs, "ABCD1234")).toBe(false);
    await h.service.stop();
  });

  it("clears the ticket when the session is lost", async () => {
    const h = harness();
    await h.service.start();
    h.adapter.emit({ type: "qr", qr: "STALE-QR" });
    await h.service.idle();
    h.adapter.emit({ type: "close", retryable: false, reason: "logged_out" });
    await h.service.idle();
    expect(h.db.linking).toBeNull(); // no stale pairing ticket lingers
    await h.service.stop();
  });
});

describe("group members sync (ADR 0008)", () => {
  const ALICE = {
    userId: "111@s.whatsapp.net",
    name: "Alice",
    phone: "111@s.whatsapp.net",
    isAdmin: true,
  };
  const BOB = { userId: "222@lid", name: null, phone: null, isAdmin: false };

  /** Rosters sync ONLY for monitored groups (H-1 privacy boundary). */
  function seedMonitored(h: Harness, chatJid = GROUP_A): void {
    h.db.groups.set(chatJid, {
      id: "g-monitored",
      name: "Group",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
  }

  it("upserts the roster of monitored discovered groups at connect", async () => {
    const h = harness();
    seedMonitored(h);
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Team", members: [ALICE, BOB] },
    ];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    const roster = h.db.membersByChat.get(GROUP_A);
    expect(roster?.get(ALICE.userId)).toMatchObject({
      name: "Alice",
      isAdmin: true,
      active: true,
    });
    expect(roster?.get(BOB.userId)).toMatchObject({
      name: null,
      isAdmin: false,
      active: true,
    });
    await h.service.stop();
  });

  it("NEVER syncs rosters for unmonitored chats (H-1)", async () => {
    const h = harness();
    // GROUP_B is discovered but stays unmonitored (the opt-in default).
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Monitored", members: [ALICE] },
      { chatJid: GROUP_B, name: "Private", members: [BOB] },
    ];
    seedMonitored(h); // only GROUP_A is opted in
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    expect(h.db.membersByChat.get(GROUP_A)?.size).toBe(1); // synced
    expect(h.db.membersByChat.has(GROUP_B)).toBe(false); // never synced

    // A participant event for the unmonitored chat syncs nothing — and
    // never even fetches its roster.
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_B,
      action: "add",
      participants: [BOB.userId],
    });
    await h.service.idle();
    expect(h.adapter.rosterRequests).not.toContain(GROUP_B);
    expect(h.db.membersByChat.has(GROUP_B)).toBe(false);
    await h.service.stop();
  });

  it("mid-way unmonitor stops future syncs (H-1)", async () => {
    const h = harness();
    seedMonitored(h);
    h.adapter.rosterResults.set(GROUP_A, [ALICE]);
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_A,
      action: "add",
      participants: [ALICE.userId],
    });
    await h.service.idle();
    expect(h.db.membersByChat.get(GROUP_A)?.size).toBe(1);

    // The admin opts the group OUT between syncs.
    h.db.adminConfigure(GROUP_A, { monitored: false });
    h.adapter.rosterResults.set(GROUP_A, [ALICE, BOB]);
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_A,
      action: "add",
      participants: [BOB.userId],
    });
    await h.service.idle();

    // The second sync never happens: the roster stays as it was.
    expect(h.db.membersByChat.get(GROUP_A)?.size).toBe(1);
    expect(h.db.membersByChat.get(GROUP_A)?.has(BOB.userId)).toBe(false);
    await h.service.stop();
  });

  it("marks absent members inactive but keeps them as history", async () => {
    const h = harness();
    seedMonitored(h);
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Team", members: [ALICE, BOB] },
    ];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    // Bob left: the next roster snapshot only carries Alice.
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Team", members: [ALICE] },
    ];
    h.adapter.emit({ type: "close", retryable: true, reason: "connection_lost" });
    await h.service.idle();
    await waitFor("the reconnect", () =>
      h.adapter.connectCalls >= 2 ? true : undefined,
    );
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    const roster = h.db.membersByChat.get(GROUP_A);
    expect(roster?.get(BOB.userId)?.active).toBe(false); // kept, not deleted
    expect(roster?.get(ALICE.userId)?.active).toBe(true);
    expect(roster?.size).toBe(2);
    await h.service.stop();
  });

  it("keeps the stored name when a sync has none (names never fail a sync)", async () => {
    const h = harness();
    seedMonitored(h);
    h.db.membersByChat.set(
      GROUP_A,
      new Map([
        [ALICE.userId, { ...ALICE, active: true }],
      ]),
    );
    await h.service.start();
    // The participant event refreshes with a nameless snapshot.
    h.adapter.rosterResults.set(GROUP_A, [
      { userId: ALICE.userId, name: null, phone: null, isAdmin: false },
    ]);
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_A,
      action: "promote",
      participants: [ALICE.userId],
    });
    await h.service.idle();

    const row = h.db.membersByChat.get(GROUP_A)?.get(ALICE.userId);
    expect(row?.name).toBe("Alice"); // kept
    expect(row?.isAdmin).toBe(false); // refreshed
    expect(h.adapter.rosterRequests).toContain(GROUP_A);
    await h.service.stop();
  });

  it("treats an empty roster as no data — never deactivates everyone", async () => {
    const h = harness();
    seedMonitored(h);
    h.db.membersByChat.set(
      GROUP_A,
      new Map([[ALICE.userId, { ...ALICE, active: true }]]),
    );
    await h.service.start();
    h.adapter.rosterResults.set(GROUP_A, []); // metadata unavailable
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_A,
      action: "remove",
      participants: [BOB.userId],
    });
    await h.service.idle();

    expect(h.db.membersByChat.get(GROUP_A)?.get(ALICE.userId)?.active).toBe(true);
    await h.service.stop();
  });

  it("ignores a roster fetch failure without breaking the service", async () => {
    const h = harness();
    seedMonitored(h);
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();
    h.adapter.rosterError = new Error("metadata unavailable");
    h.adapter.emit({
      type: "participants",
      chatJid: GROUP_A,
      action: "add",
      participants: [ALICE.userId],
    });
    await h.service.idle();
    expect(h.service.sessionStatus).toBe("connected");
    expect(findEvents(h.logs, "roster_sync_failed")).toHaveLength(1);
    await h.service.stop();
  });

  it("persists contact names learned after discovery (monitored only)", async () => {
    const h = harness();
    seedMonitored(h, GROUP_A);
    h.adapter.fetchChatsResults = [
      { chatJid: GROUP_A, name: "Team", members: [BOB] },
    ];
    await h.service.start();
    h.adapter.emit({ type: "open" });
    await h.service.idle();

    h.adapter.emit({
      type: "contact-names",
      contacts: [{ jids: [BOB.userId], name: "Bob" }],
    });
    await h.service.idle();

    expect(h.db.membersByChat.get(GROUP_A)?.get(BOB.userId)?.name).toBe("Bob");
    // Names are PII: the logs must not carry them.
    expect(logsContain(h.logs, "Bob")).toBe(false);
    await h.service.stop();
  });
});

describe("sender names at ingestion (ADR 0008)", () => {
  it("persists the push name on the live capture path", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    // The same sender is already on the roster without a name; the
    // message push name must also land there (roster name resolution).
    h.db.membersByChat.set(
      GROUP_A,
      new Map([
        [
          "sender@s.whatsapp.net",
          {
            userId: "sender@s.whatsapp.net",
            name: null,
            phone: null,
            isAdmin: false,
            active: true,
          },
        ],
      ]),
    );
    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A, senderName: "Alice" }),
      rawMessage({ messageId: "M2", chatJid: GROUP_A, senderName: null }),
    );
    await h.service.idle();

    expect(h.db.messages.map((row) => row.senderName)).toEqual(["Alice", null]);
    expect(
      h.db.membersByChat.get(GROUP_A)?.get("sender@s.whatsapp.net")?.name,
    ).toBe("Alice");
    // Names are PII: the logs must not carry them.
    expect(logsContain(h.logs, "Alice")).toBe(false);
    await h.service.stop();
  });

  it("clamps sender names to the 300-char contract maximum (CR#5)", async () => {
    const h = harness();
    await h.service.start();
    h.db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    const longName = "N".repeat(400);
    h.adapter.emitMessages(
      rawMessage({ messageId: "M1", chatJid: GROUP_A, senderName: longName }),
    );
    await h.service.idle();

    expect(h.db.messages[0]?.senderName).toBe("N".repeat(300));
    await h.service.stop();
  });
});
