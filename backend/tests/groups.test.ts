import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError, Group, type GroupHistoryImport } from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/lib/store.js";
import {
  GROUP_ID,
  login,
  makeApp,
  noopEnqueuer,
  seedGroup,
  setupAdmin,
} from "./helpers.js";

async function authedApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  await seedGroup(ctx.store);
  const session = await login(ctx.app);
  return { ...ctx, session };
}

function requestImport(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  session: string,
  id: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/groups/${id}/history-import`,
    headers: { cookie: session },
  });
}

describe("groups", () => {
  it("lists seeded groups", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const groups = res.json() as unknown[];
    expect(groups).toHaveLength(1);
    expect(Group.parse(groups[0]).id).toBe(GROUP_ID);
  });

  it("updates monitoring and time zone preferences", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: false, timezone: "America/Bogota", summaryTime: "06:30" },
    });
    expect(res.statusCode).toBe(200);
    const group = Group.parse(res.json());
    expect(group.monitored).toBe(false);
    expect(group.timezone).toBe("America/Bogota");
    expect(group.summaryTime).toBe("06:30");
  });

  it("clears summaryTime with an explicit null", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { summaryTime: null },
    });
    expect(Group.parse(res.json()).summaryTime).toBeNull();
  });

  it("rejects invalid time zones and cutoff times", async () => {
    const { app, session } = await authedApp();
    const badZone = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { timezone: "Not/AZone" },
    });
    expect(badZone.statusCode).toBe(400);
    expect(ApiError.parse(badZone.json()).error.code).toBe("validation_error");

    const badTime = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { summaryTime: "25:99" },
    });
    expect(badTime.statusCode).toBe(400);
  });

  it("404s for an unknown group id", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/groups/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
      payload: { monitored: true },
    });
    expect(res.statusCode).toBe(404);
  });
});


describe("history import (POST /api/groups/:id/history-import, ADR 0007)", () => {
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
  const DONE_IMPORT: GroupHistoryImport = {
    status: "done",
    requestedAt: "2026-11-01T10:00:00.000Z",
    startedAt: "2026-11-01T10:00:05.000Z",
    finishedAt: "2026-11-01T10:03:00.000Z",
    importedCount: 42,
    error: null,
  };

  it("404s for an unknown group id", async () => {
    const { app, session } = await authedApp();
    const res = await requestImport(app, session, UNKNOWN_ID);
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe("not_found");
  });

  it("409s when the group is not monitored (privacy boundary)", async () => {
    const { app, store, session } = await authedApp();
    await store.updateGroup({
      ...(await store.getGroup(GROUP_ID))!,
      monitored: false,
    });
    const res = await requestImport(app, session, GROUP_ID);
    expect(res.statusCode).toBe(409);
    const error = ApiError.parse(res.json()).error;
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("Group must be monitored before importing history.");
  });

  it("202 accepts a request and resets ALL progress fields", async () => {
    for (const status of ["done", "failed"] as const) {
      const { app, store, session } = await authedApp();
      // A FRESH group id: only inserts can carry an initial system state
      // (existing rows always preserve it — see the discovery test).
      const groupId = randomUUID();
      const previous =
        status === "failed"
          ? { ...DONE_IMPORT, status, error: "history_sync_failed" }
          : DONE_IMPORT;
      await store.upsertGroup({
        id: groupId,
        chatId: null,
        name: "Fresh Group",
        monitored: true,
        timezone: "Europe/Madrid",
        summaryTime: null,
        historyImport: previous,
      });

      const res = await requestImport(app, session, groupId);
      expect(res.statusCode, status).toBe(202);
      const group = Group.parse(res.json());
      expect(group.historyImport?.status).toBe("pending");
      expect(group.historyImport?.startedAt).toBeNull();
      expect(group.historyImport?.finishedAt).toBeNull();
      expect(group.historyImport?.importedCount).toBe(0);
      expect(group.historyImport?.error).toBeNull();
      expect(group.historyImport?.requestedAt).toEqual(expect.any(String));
      expect(Date.parse(group.historyImport?.requestedAt ?? "")).toBeGreaterThan(
        Date.parse("2026-11-01T10:00:00.000Z"),
      );
    }
  });

  it("200 and unchanged while an import is pending or running (idempotent)", async () => {
    for (const status of ["pending", "running"] as const) {
      const { app, store, session } = await authedApp();
      // Fresh id again: seeded states ride on the INSERT path.
      const groupId = randomUUID();
      const inFlight = {
        ...DONE_IMPORT,
        status,
        requestedAt: "2026-11-01T10:00:00.000Z",
        startedAt: status === "running" ? "2026-11-01T10:00:05.000Z" : null,
        finishedAt: null,
        importedCount: 7,
        error: null,
      };
      await store.upsertGroup({
        id: groupId,
        chatId: null,
        name: "Fresh Group",
        monitored: true,
        timezone: "Europe/Madrid",
        summaryTime: null,
        historyImport: inFlight,
      });

      const res = await requestImport(app, session, groupId);
      expect(res.statusCode, status).toBe(200);
      // Completely unchanged: the request is a no-op, not a restart.
      expect(Group.parse(res.json()).historyImport).toEqual(inFlight);
    }
  });

  it("PATCH admin preferences never touches historyImport", async () => {
    const { app, session } = await authedApp();
    const accepted = await requestImport(app, session, GROUP_ID);
    expect(accepted.statusCode).toBe(202);
    const requested = Group.parse(accepted.json()).historyImport;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: {
        monitored: true,
        timezone: "America/Bogota",
        summaryTime: "06:30",
        // A tampering client also cannot SET the system-managed state:
        // the field is stripped from UpdateGroupRequest.
        historyImport: { ...DONE_IMPORT, status: "failed" },
      },
    });
    expect(patched.statusCode).toBe(200);
    const group = Group.parse(patched.json());
    expect(group.timezone).toBe("America/Bogota");
    expect(group.summaryTime).toBe("06:30");
    expect(group.historyImport).toEqual(requested);
  });

  it("discovery re-registration never resets an import", async () => {
    const { app, store, session } = await authedApp();
    const chatId = `${Math.random().toString(16).slice(2)}@g.us`;
    await store.upsertGroup({
      id: GROUP_ID,
      chatId,
      name: "Test Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    const accepted = await requestImport(app, session, GROUP_ID);
    const requested = Group.parse(accepted.json()).historyImport;
    expect(requested?.status).toBe("pending");

    // Chat-keyed rediscovery (subject rename) updates ONLY the name.
    const renamed = await store.upsertGroup({
      id: UNKNOWN_ID,
      chatId,
      name: "Renamed by discovery",
      monitored: false,
      timezone: "UTC",
      summaryTime: null,
      historyImport: null,
    });
    expect(renamed.id).toBe(GROUP_ID);
    expect(renamed.historyImport).toEqual(requested);

    // The id-keyed path replaces the mutable fields only.
    const replaced = await store.upsertGroup({
      id: GROUP_ID,
      chatId,
      name: "Replaced",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    expect(replaced.historyImport).toEqual(requested);
  });
});

describe("history import: consent + response semantics (audit SA-M1, review CR-m1)", () => {
  it("un-monitoring cancels a PENDING import (consent is revoked)", async () => {
    const { app, store, session } = await authedApp();
    const accepted = await requestImport(app, session, GROUP_ID);
    expect(accepted.statusCode).toBe(202);
    expect(Group.parse(accepted.json()).historyImport?.status).toBe("pending");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: false },
    });
    expect(patched.statusCode).toBe(200);
    // The response itself shows the pending import is gone.
    expect(Group.parse(patched.json()).historyImport).toBeNull();

    // Re-monitoring later ("Monitor only") can never revive the old
    // request: it no longer exists.
    await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: true },
    });
    const group = await store.getGroup(GROUP_ID);
    expect(group?.historyImport).toBeNull();
  });

  it("un-monitoring NEVER clears a running import (the worker aborts it)", async () => {
    const { app, store, session } = await authedApp();
    const groupId = randomUUID();
    const running = {
      status: "running",
      requestedAt: "2026-11-01T10:00:00.000Z",
      startedAt: "2026-11-01T10:00:05.000Z",
      finishedAt: null,
      importedCount: 3,
      error: null,
    } as const;
    await store.upsertGroup({
      id: groupId,
      chatId: null,
      name: "Fresh Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: running,
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/groups/${groupId}`,
      headers: { cookie: session },
      payload: { monitored: false },
    });
    expect(patched.statusCode).toBe(200);
    // Untouched: only PENDING requests are cancellable (SA-M1).
    expect(Group.parse(patched.json()).historyImport).toEqual(running);
    expect(
      await store.cancelPendingHistoryImport(groupId),
    ).toBe(false);
  });

  it("leaves done/failed history untouched when un-monitoring", async () => {
    const { app, store, session } = await authedApp();
    const groupId = randomUUID();
    const finished = {
      status: "done",
      requestedAt: "2026-11-01T10:00:00.000Z",
      startedAt: "2026-11-01T10:00:05.000Z",
      finishedAt: "2026-11-01T10:03:00.000Z",
      importedCount: 42,
      error: null,
    } as const;
    await store.upsertGroup({
      id: groupId,
      chatId: null,
      name: "Fresh Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: finished,
    });
    await app.inject({
      method: "PATCH",
      url: `/api/groups/${groupId}`,
      headers: { cookie: session },
      payload: { monitored: false },
    });
    expect((await store.getGroup(groupId))?.historyImport).toEqual(finished);
    expect(await store.cancelPendingHistoryImport(groupId)).toBe(false);
  });

  it("cancelPendingHistoryImport is idempotent and unknown-safe", async () => {
    const { store } = await authedApp();
    // Unknown group: nothing to cancel.
    expect(await store.cancelPendingHistoryImport(randomUUID())).toBe(false);
    // Fresh group with no request at all: still false.
    const groupId = randomUUID();
    await store.upsertGroup({
      id: groupId,
      chatId: null,
      name: "Fresh Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    expect(await store.cancelPendingHistoryImport(groupId)).toBe(false);
  });

  it("the response code comes from the WRITE, not a pre-read (CR-m1)", async () => {
    const { store } = await authedApp();
    const groupId = randomUUID();
    await store.upsertGroup({
      id: groupId,
      chatId: null,
      name: "Fresh Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });

    // First request performs the transition -> 202 territory.
    const first = await store.requestHistoryImport(groupId);
    expect(first?.changed).toBe(true);
    // Concurrent follow-ups while it is in flight -> 200 territory.
    const second = await store.requestHistoryImport(groupId);
    expect(second?.changed).toBe(false);
    expect(second?.group.historyImport).toEqual(first?.group.historyImport);
    // After an import finished, a repeat is a NEW transition -> 202
    // (fresh group id here: existing rows never accept re-seeded state,
    // which is itself the never-clobber guarantee).
    const finishedId = randomUUID();
    await store.upsertGroup({
      id: finishedId,
      chatId: null,
      name: "Finished Group",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: {
        status: "done",
        requestedAt: "2026-11-01T10:00:00.000Z",
        startedAt: null,
        finishedAt: "2026-11-01T10:03:00.000Z",
        importedCount: 0,
        error: null,
      },
    });
    expect((await store.requestHistoryImport(finishedId))?.changed).toBe(true);
  });
});

describe("roster sync request (POST /api/groups/:id/roster-sync, migration 0016)", () => {
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

  function requestRosterSync(
    app: Awaited<ReturnType<typeof makeApp>>["app"],
    session: string,
    id: string,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/groups/${id}/roster-sync`,
      headers: { cookie: session },
    });
  }

  it("404s for an unknown group id", async () => {
    const { app, session } = await authedApp();
    const res = await requestRosterSync(app, session, UNKNOWN_ID);
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe("not_found");
  });

  it("409s when the group is not monitored (privacy boundary)", async () => {
    const { app, store, session } = await authedApp();
    await store.updateGroup({
      ...(await store.getGroup(GROUP_ID))!,
      monitored: false,
    });
    const res = await requestRosterSync(app, session, GROUP_ID);
    expect(res.statusCode).toBe(409);
    const error = ApiError.parse(res.json()).error;
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(
      "Group must be monitored before syncing its roster.",
    );
    expect(store.pendingRosterSyncGroupIds).toEqual([]);
  });

  it("202 accepts the request and records it (no flag on the contract)", async () => {
    const { app, store, session } = await authedApp();
    const res = await requestRosterSync(app, session, GROUP_ID);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(store.pendingRosterSyncGroupIds).toEqual([GROUP_ID]);

    // The control flag is internal: it is not part of the Group shape.
    const group = await app.inject({
      method: "GET",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
    });
    const parsed = Group.parse(group.json());
    expect(Object.keys(parsed)).not.toContain("rosterSyncRequestedAt");
  });

  it("is idempotent: repeated requests keep ONE pending flag", async () => {
    const { app, store, session } = await authedApp();
    expect((await requestRosterSync(app, session, GROUP_ID)).statusCode).toBe(202);
    expect((await requestRosterSync(app, session, GROUP_ID)).statusCode).toBe(202);
    expect(store.pendingRosterSyncGroupIds).toEqual([GROUP_ID]);
  });
});

describe("roster sync on monitoring enable (PATCH /api/groups/:id)", () => {
  it("requests a sync when the group transitions to monitored", async () => {
    const { app, store, session } = await authedApp();
    await store.updateGroup({
      ...(await store.getGroup(GROUP_ID))!,
      monitored: false,
    });
    expect(store.pendingRosterSyncGroupIds).toEqual([]);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: true },
    });
    expect(res.statusCode).toBe(200);
    expect(Group.parse(res.json()).monitored).toBe(true);
    expect(store.pendingRosterSyncGroupIds).toEqual([GROUP_ID]);
  });

  it("does not request one when the group was already monitored", async () => {
    const { app, store, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { timezone: "America/Bogota" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.pendingRosterSyncGroupIds).toEqual([]);
  });

  it("does not request one when monitoring is disabled", async () => {
    const { app, store, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: false },
    });
    expect(res.statusCode).toBe(200);
    expect(store.pendingRosterSyncGroupIds).toEqual([]);
  });

  it("still returns the updated group when the request write fails", async () => {
    // The group update already committed: a failed roster-sync request
    // must never turn a successful PATCH into a 500 (best-effort).
    class FailingRosterSyncStore extends InMemoryStore {
      override async requestGroupRosterSync(): Promise<void> {
        throw new Error("database unavailable");
      }
    }
    const store = new FailingRosterSyncStore();
    await store.upsertGroup({
      id: GROUP_ID,
      chatId: null,
      name: "Test Group",
      monitored: false,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    const app = await buildApp({
      store,
      enqueue: noopEnqueuer,
      cookieSecure: false,
      logger: false,
    });
    await setupAdmin(app);
    const session = await login(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: true },
    });
    expect(res.statusCode).toBe(200);
    expect(Group.parse(res.json()).monitored).toBe(true);
    expect((await store.getGroup(GROUP_ID))?.monitored).toBe(true);
  });
});

describe("Store.requestGroupRosterSync", () => {
  it("records a request only for monitored groups", async () => {
    const { store } = await authedApp();
    // Unknown group: silent no-op (the route answers 404 before this).
    await store.requestGroupRosterSync(randomUUID());
    expect(store.pendingRosterSyncGroupIds).toEqual([]);

    // Unmonitored group: the SQL WHERE clause refuses it.
    await store.updateGroup({
      ...(await store.getGroup(GROUP_ID))!,
      monitored: false,
    });
    await store.requestGroupRosterSync(GROUP_ID);
    expect(store.pendingRosterSyncGroupIds).toEqual([]);

    // Monitored group: recorded.
    await store.updateGroup({
      ...(await store.getGroup(GROUP_ID))!,
      monitored: true,
    });
    await store.requestGroupRosterSync(GROUP_ID);
    expect(store.pendingRosterSyncGroupIds).toEqual([GROUP_ID]);
  });
});
