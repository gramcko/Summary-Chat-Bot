import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaptureService,
  type LinkingInfo,
} from "../src/service.js";
import { SessionControlService } from "../src/session-control.js";
import {
  FakeAdapter,
  FakeDb,
  findEvents,
  rawMessage,
  recordingLogger,
  sleep,
  waitFor,
  type LogEntry,
} from "./fakes.js";

/**
 * Admin logout control (ADR 0008) with fake adapter and fake database:
 * no WhatsApp account, no network. Covers the consume → bounded logout →
 * purge → finalize → re-arm flow (fixes M-1, M-3, CR-M1, CR#7).
 */

const GROUP_A = "111111111111-22222222@g.us";

interface Harness {
  adapter: FakeAdapter;
  db: FakeDb;
  logs: LogEntry[];
  /** Real temp dir holding fake auth state (the flow purges it). */
  sessionDir: string;
  capture: {
    beginLogoutCalls: number;
    rearmCalls: number;
    beginLogout(): void;
    rearm(): Promise<void>;
  };
  control: SessionControlService;
}

function harness(
  options: { rearmThrows?: boolean; logoutTimeoutMs?: number } = {},
): Harness {
  const adapter = new FakeAdapter();
  const db = new FakeDb();
  const logs: LogEntry[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "summarly-logout-"));
  writeFileSync(join(sessionDir, "creds.json"), "{}");
  writeFileSync(join(sessionDir, "app-state-sync-key-0.json"), "{}");
  const capture = {
    beginLogoutCalls: 0,
    rearmCalls: 0,
    beginLogout() {
      this.beginLogoutCalls += 1;
    },
    async rearm(): Promise<void> {
      this.rearmCalls += 1;
      if (options.rearmThrows === true) throw new Error("rearm failed");
    },
  };
  const control = new SessionControlService({
    adapter,
    db,
    log: recordingLogger(logs),
    capture,
    sessionDir,
    pollMs: 5,
    logoutTimeoutMs: options.logoutTimeoutMs ?? 500,
  });
  return { adapter, db, logs, sessionDir, capture, control };
}

describe("SessionControlService (admin logout, ADR 0008)", () => {
  it("consumes the request: logout, session purge, state/QR/flags cleared", async () => {
    const h = harness();
    h.db.logoutRequestedAt = new Date();
    h.db.linking = {
      qr: "OLD-QR",
      expiresAt: new Date(Date.now() + 60_000),
      kind: "qr",
    };

    expect(await h.control.runOnce()).toBe(true);

    // Remote logout + local auth-state purge (the flow owns the purge).
    expect(h.adapter.logoutCalls).toBe(1);
    expect(existsSync(join(h.sessionDir, "creds.json"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "app-state-sync-key-0.json"))).toBe(
      false,
    );
    expect(existsSync(h.sessionDir)).toBe(true); // dir may stay
    // Capture side frozen BEFORE the teardown and re-armed after it.
    expect(h.capture.beginLogoutCalls).toBe(1);
    expect(h.capture.rearmCalls).toBe(1);
    // Terminal DB state: unavailable, linking payload gone, request
    // consumed (last_message_at kept — the fake mirrors that).
    expect(h.db.logoutRequestedAt).toBeNull();
    expect(h.db.finalizeLogoutCalls).toBe(1);
    expect(h.db.linking).toBeNull();
    expect(h.db.stateHistory.at(-1)).toBe("unavailable");
    // Safe logs only: no QR material.
    expect(findEvents(h.logs, "logout_started")).toHaveLength(1);
    expect(findEvents(h.logs, "logout_completed")[0]?.fields).toMatchObject({
      ok: true,
    });
    expect(JSON.stringify(h.logs)).not.toContain("OLD-QR");
  });

  it("bounds a stalled logout and still purges + finalizes (M-1)", async () => {
    const h = harness({ logoutTimeoutMs: 30 });
    h.adapter.logoutBehavior = "hang"; // never resolves
    h.db.logoutRequestedAt = new Date();

    // Resolves in bounded time despite the hung network call.
    expect(await h.control.runOnce()).toBe(true);

    // Credentials are gone and the row is finalized even though the
    // remote logout never settled.
    expect(existsSync(join(h.sessionDir, "creds.json"))).toBe(false);
    expect(h.db.finalizeLogoutCalls).toBe(1);
    expect(h.db.stateHistory.at(-1)).toBe("unavailable");
    expect(findEvents(h.logs, "logout_completed")[0]?.fields).toMatchObject({
      ok: false,
    });
    expect(h.capture.rearmCalls).toBe(1); // linking re-armed regardless
  });

  it("purge removes only known artefacts and warns about the rest (M-3)", async () => {
    const h = harness();
    // Unknown entries the purge must NOT touch.
    writeFileSync(join(h.sessionDir, "notes.txt"), "operator notes");
    writeFileSync(join(h.sessionDir, "backup.tar"), "junk");
    h.db.logoutRequestedAt = new Date();

    await h.control.runOnce();

    expect(existsSync(join(h.sessionDir, "creds.json"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "app-state-sync-key-0.json"))).toBe(
      false,
    );
    expect(existsSync(join(h.sessionDir, "notes.txt"))).toBe(true);
    expect(existsSync(join(h.sessionDir, "backup.tar"))).toBe(true);
    const kept = findEvents(h.logs, "session_purge_kept_unknown_files");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.fields).toMatchObject({ count: 2 });
  });

  it("a second request while still logged out (re-arm failed) only clears the flag", async () => {
    const h = harness({ rearmThrows: true });
    h.db.logoutRequestedAt = new Date();
    await h.control.runOnce(); // teardown + failed re-arm → latch stays

    h.db.logoutRequestedAt = new Date();
    expect(await h.control.runOnce()).toBe(true);

    expect(h.db.logoutRequestedAt).toBeNull(); // flag consumed
    expect(h.adapter.logoutCalls).toBe(1); // no second teardown
    expect(h.db.finalizeLogoutCalls).toBe(1);
    expect(findEvents(h.logs, "logout_request_cleared")).toHaveLength(1);
    expect(findEvents(h.logs, "session_rearm_failed")).toHaveLength(1);
  });

  it("a second request AFTER a successful re-arm runs a fresh teardown", async () => {
    const h = harness();
    h.db.logoutRequestedAt = new Date();
    await h.control.runOnce(); // teardown + re-arm (linking again)

    h.db.logoutRequestedAt = new Date();
    expect(await h.control.runOnce()).toBe(true);

    expect(h.adapter.logoutCalls).toBe(2); // a NEW logout request
    expect(h.db.finalizeLogoutCalls).toBe(2);
    expect(h.capture.rearmCalls).toBe(2);
  });

  it("does nothing without a pending request", async () => {
    const h = harness();
    expect(await h.control.runOnce()).toBe(false);
    expect(h.adapter.logoutCalls).toBe(0);
    expect(h.db.finalizeLogoutCalls).toBe(0);
  });

  it("still finalizes when the remote logout fails", async () => {
    const h = harness();
    h.db.logoutRequestedAt = new Date();
    h.adapter.logoutBehavior = "throw";

    expect(await h.control.runOnce()).toBe(true);

    expect(h.db.finalizeLogoutCalls).toBe(1); // local cleanup still ran
    expect(h.db.logoutRequestedAt).toBeNull();
    expect(existsSync(join(h.sessionDir, "creds.json"))).toBe(false);
    expect(findEvents(h.logs, "logout_failed")).toHaveLength(1);
    expect(findEvents(h.logs, "logout_completed")[0]?.fields).toMatchObject({
      ok: false,
    });
  });

  it("clears EXPIRED linking payloads on the tick (CR#7)", async () => {
    const h = harness();
    h.db.linking = {
      qr: "STALE-QR",
      expiresAt: new Date(Date.now() - 1),
      kind: "pairing-code",
    };
    expect(await h.control.runOnce()).toBe(false); // no logout request
    expect(h.db.linking).toBeNull(); // but the stale ticket is gone
    expect(findEvents(h.logs, "linking_expired_cleared")).toHaveLength(1);
  });

  it("polls the flag until stopped", async () => {
    const h = harness();
    h.control.start();
    await sleep(15);
    h.db.logoutRequestedAt = new Date(); // the admin clicks mid-run
    await waitFor("the logout to complete", async () =>
      h.db.finalizeLogoutCalls === 1 ? true : undefined,
    );
    await h.control.stop();
    expect(h.adapter.logoutCalls).toBe(1);
    expect(findEvents(h.logs, "session_control_stopped")).toHaveLength(1);

    // The loop is dead: a new request stays pending after stop.
    h.db.logoutRequestedAt = new Date();
    await sleep(20);
    expect(h.db.logoutRequestedAt).not.toBeNull();
  });
});

describe("SessionControlService (delete connection data reset, migration 0014)", () => {
  it("consumes the flag, skips the remote logout, purges, finalizes and re-arms", async () => {
    const h = harness();
    h.db.sessionResetRequestedAt = new Date();
    h.db.linking = {
      qr: "STALE-QR",
      expiresAt: new Date(Date.now() + 60_000),
      kind: "qr",
    };

    expect(await h.control.runOnce()).toBe(true);

    // LOCAL-ONLY: no remote revoke is attempted.
    expect(h.adapter.logoutCalls).toBe(0);
    // Known Baileys artefacts are purged (the directory may stay).
    expect(existsSync(join(h.sessionDir, "creds.json"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "app-state-sync-key-0.json"))).toBe(
      false,
    );
    expect(existsSync(h.sessionDir)).toBe(true);
    // Capture frozen first, then re-armed so a fresh QR can appear.
    expect(h.capture.beginLogoutCalls).toBe(1);
    expect(h.capture.rearmCalls).toBe(1);
    // Terminal state written and the request flag consumed.
    expect(h.db.sessionResetRequestedAt).toBeNull();
    expect(h.db.finalizeLogoutCalls).toBe(1);
    expect(h.db.linking).toBeNull();
    expect(h.db.stateHistory.at(-1)).toBe("unavailable");
    // Safe logs only: timestamps/flags, never QR material.
    expect(findEvents(h.logs, "session_reset_started")).toHaveLength(1);
    expect(
      findEvents(h.logs, "session_reset_completed")[0]?.fields,
    ).toMatchObject({ rearmed: true });
    expect(JSON.stringify(h.logs)).not.toContain("STALE-QR");
  });

  it("clears a pending logout flag: the reset wins over the remote logout", async () => {
    const h = harness();
    h.db.logoutRequestedAt = new Date();
    h.db.sessionResetRequestedAt = new Date();

    expect(await h.control.runOnce()).toBe(true);

    expect(h.adapter.logoutCalls).toBe(0);
    expect(h.db.logoutRequestedAt).toBeNull();
    expect(findEvents(h.logs, "logout_started")).toHaveLength(0);
    expect(findEvents(h.logs, "session_reset_completed")).toHaveLength(1);
    // The logout flow did not run a second time on the next tick.
    expect(await h.control.runOnce()).toBe(false);
    expect(h.adapter.logoutCalls).toBe(0);
  });

  it("is idempotent: a second reset while already logged out is harmless", async () => {
    const h = harness({ rearmThrows: true });
    h.db.sessionResetRequestedAt = new Date();
    await h.control.runOnce(); // purge + finalize, re-arm fails → latch set

    h.db.sessionResetRequestedAt = new Date();
    expect(await h.control.runOnce()).toBe(true);

    expect(h.adapter.logoutCalls).toBe(0); // never a remote revoke
    expect(h.db.finalizeLogoutCalls).toBe(2);
    expect(h.capture.rearmCalls).toBe(2);
    expect(findEvents(h.logs, "session_reset_completed")).toHaveLength(2);
    expect(findEvents(h.logs, "session_rearm_failed")).toHaveLength(2);
  });
});

describe("re-link after logout (CR-M1)", () => {
  it("publishes a fresh QR after the logout flow re-armed the capture", async () => {
    // Full stack: the real CaptureService + FakeAdapter + FakeDb, so the
    // promise "link a device again afterwards" is proven end to end.
    const adapter = new FakeAdapter();
    const db = new FakeDb();
    const logs: LogEntry[] = [];
    const linking: LinkingInfo[] = [];
    const service = new CaptureService({
      adapter,
      db,
      log: recordingLogger(logs),
      defaultTimezone: "UTC",
      backoff: { baseMs: 5, capMs: 20 },
      onLinking: (info) => linking.push(info),
    });
    const sessionDir = mkdtempSync(join(tmpdir(), "summarly-rearm-"));
    writeFileSync(join(sessionDir, "creds.json"), "{}");
    const control = new SessionControlService({
      adapter,
      db,
      log: recordingLogger(logs),
      capture: service,
      sessionDir,
      pollMs: 5,
    });

    await service.start();
    adapter.emit({ type: "open" });
    await service.idle();
    // The admin logs out; the flow tears down and re-arms.
    db.logoutRequestedAt = new Date();
    expect(await control.runOnce()).toBe(true);
    // finalizeLogout wrote `unavailable` … then the re-arm already
    // brought the state machine back to `connecting` — no restart.
    expect(db.stateHistory).toContain("unavailable");
    expect(db.stateHistory.at(-1)).toBe("connecting");
    expect(existsSync(join(sessionDir, "creds.json"))).toBe(false);

    // The re-armed adapter connects again and the NORMAL flow publishes
    // a fresh QR within one poll — no worker restart needed.
    expect(adapter.connectCalls).toBeGreaterThanOrEqual(2);
    adapter.emit({ type: "qr", qr: "FRESH-QR-AFTER-LOGOUT" });
    await service.idle();
    expect(db.linking?.qr).toBe("FRESH-QR-AFTER-LOGOUT");
    expect(db.linking?.kind).toBe("qr");
    // And capture works again for the fresh session.
    db.groups.set(GROUP_A, {
      id: "g-a",
      name: "A",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
    });
    adapter.emitMessages(rawMessage({ messageId: "M1", chatJid: GROUP_A }));
    await service.idle();
    expect(db.messages).toHaveLength(1);
    await service.stop();
    await control.stop();
  });

  it("performs a requested session check and records the result", async () => {
    const h = harness();
    h.db.requestSessionCheck();
    h.adapter.sessionCheckResult = {
      ok: true,
      latencyMs: 23,
      error: null,
    };

    const consumed = await h.control.runOnce();

    expect(consumed).toBe(false);
    expect(h.db.sessionCheckCheckedAt).not.toBeNull();
    expect(h.db.sessionCheckOk).toBe(true);
    expect(h.db.sessionCheckLatencyMs).toBe(23);
    expect(h.db.sessionCheckError).toBeNull();
    expect(findEvents(h.logs, "session_check_completed")).toHaveLength(1);
    await h.control.stop();
  });

  it("records a failed session check", async () => {
    const h = harness();
    h.db.requestSessionCheck();
    h.adapter.sessionCheckResult = {
      ok: false,
      latencyMs: 5,
      error: "not_connected",
    };

    await h.control.runOnce();

    expect(h.db.sessionCheckOk).toBe(false);
    expect(h.db.sessionCheckError).toBe("not_connected");
    await h.control.stop();
  });
});

describe("SessionControlService (on-demand roster sync, migration 0016)", () => {
  /** Discovers a chat and opts it in (FakeDb mirrors the never-clobber rule). */
  async function monitoredGroup(db: FakeDb, chatJid: string): Promise<string> {
    await db.upsertDiscoveredChats(
      [{ chatJid, name: "Group A", members: [] }],
      { timezone: "UTC" },
    );
    db.adminConfigure(chatJid, { monitored: true });
    return db.groups.get(chatJid)!.id;
  }

  it("claims one pending request, fetches the roster and syncs the members", async () => {
    const h = harness();
    const groupId = await monitoredGroup(h.db, GROUP_A);
    h.adapter.rosterResults.set(GROUP_A, [
      {
        userId: "111@s.whatsapp.net",
        name: "Alice",
        phone: "111@s.whatsapp.net",
        isAdmin: true,
      },
      { userId: "222@lid", name: null, phone: null, isAdmin: false },
    ]);
    h.db.requestRosterSync(GROUP_A);

    expect(await h.control.runOnce()).toBe(false);

    expect(h.adapter.rosterRequests).toEqual([GROUP_A]);
    // The flag was consumed atomically by the claim.
    expect(h.db.rosterSyncRequested.size).toBe(0);
    const roster = h.db.membersByChat.get(GROUP_A);
    expect(roster?.size).toBe(2);
    expect([...roster!.values()].every((member) => member.active)).toBe(true);
    expect(findEvents(h.logs, "roster_sync_started")[0]?.fields).toMatchObject({
      groupId,
    });
    expect(findEvents(h.logs, "roster_sync_completed")[0]?.fields).toMatchObject({
      groupId,
      members: 2,
      upserted: 2,
      deactivated: 0,
    });
    // Safe logs only: the raw chat JID (PII carrier) never appears.
    expect(JSON.stringify(h.logs)).not.toContain(GROUP_A);

    // The request is gone: the next tick does not fetch again.
    expect(await h.control.runOnce()).toBe(false);
    expect(h.adapter.rosterRequests).toEqual([GROUP_A]);
  });

  it("consumes at most ONE request per tick", async () => {
    const h = harness();
    await monitoredGroup(h.db, GROUP_A);
    const groupB = "333333333333-44444444@g.us";
    await monitoredGroup(h.db, groupB);
    h.adapter.rosterResults.set(GROUP_A, [
      { userId: "111@s.whatsapp.net", name: null, phone: null, isAdmin: false },
    ]);
    h.adapter.rosterResults.set(groupB, [
      { userId: "222@s.whatsapp.net", name: null, phone: null, isAdmin: false },
    ]);
    h.db.requestRosterSync(GROUP_A);
    h.db.requestRosterSync(groupB);

    expect(await h.control.runOnce()).toBe(false);
    expect(h.adapter.rosterRequests).toHaveLength(1);
    expect(h.db.rosterSyncRequested.size).toBe(1);

    expect(await h.control.runOnce()).toBe(false);
    expect(h.adapter.rosterRequests).toHaveLength(2);
    expect(h.db.rosterSyncRequested.size).toBe(0);
  });

  it("treats an EMPTY roster as no data, not a failure", async () => {
    const h = harness();
    await monitoredGroup(h.db, GROUP_A);
    h.db.requestRosterSync(GROUP_A);

    expect(await h.control.runOnce()).toBe(false);

    expect(h.adapter.rosterRequests).toEqual([GROUP_A]);
    expect(findEvents(h.logs, "roster_sync_empty")).toHaveLength(1);
    expect(findEvents(h.logs, "roster_sync_failed")).toHaveLength(0);
    expect(findEvents(h.logs, "roster_sync_completed")).toHaveLength(0);
    // Nothing was written (an empty roster must never deactivate anyone).
    expect(h.db.membersByChat.has(GROUP_A)).toBe(false);
  });

  it("logs a safe failure when the roster fetch throws", async () => {
    const h = harness();
    await monitoredGroup(h.db, GROUP_A);
    h.adapter.rosterError = new Error("metadata unavailable");
    h.db.requestRosterSync(GROUP_A);

    expect(await h.control.runOnce()).toBe(false);

    const failed = findEvents(h.logs, "roster_sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toMatchObject({ reason: "metadata unavailable" });
    expect(findEvents(h.logs, "roster_sync_completed")).toHaveLength(0);
    expect(JSON.stringify(h.logs)).not.toContain(GROUP_A);
  });

  it("does nothing when no request is pending", async () => {
    const h = harness();
    await monitoredGroup(h.db, GROUP_A);

    expect(await h.control.runOnce()).toBe(false);

    expect(h.adapter.rosterRequests).toEqual([]);
    expect(findEvents(h.logs, "roster_sync_started")).toHaveLength(0);
  });

  it("never claims a request for an unmonitored group (privacy boundary)", async () => {
    const h = harness();
    await monitoredGroup(h.db, GROUP_A);
    h.db.requestRosterSync(GROUP_A);
    // The admin un-monitors BEFORE the worker polls: the claim skips it.
    h.db.adminConfigure(GROUP_A, { monitored: false });

    expect(await h.control.runOnce()).toBe(false);

    expect(h.adapter.rosterRequests).toEqual([]);
    expect(findEvents(h.logs, "roster_sync_started")).toHaveLength(0);
  });
});
