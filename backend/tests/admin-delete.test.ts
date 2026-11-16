import { describe, expect, it } from "vitest";
import {
  ApiError,
  DeleteAllDataResponse,
  type SummaryResult,
} from "@summarly/contracts";
import { InMemoryStore } from "../src/lib/store.js";
import { login, makeApp, setupAdmin, GROUP_ID } from "./helpers.js";

/**
 * Guarded "delete all captured data" action (danger zone).
 *
 * Scope: captured data only. Settings, AI provider configuration,
 * admin credentials/sessions, the WhatsApp connection row/state, and
 * the Baileys session directory are KEPT.
 */

const INTERVAL = {
  start: "2026-11-01T00:00:00Z",
  end: "2026-11-02T00:00:00Z",
  timezone: "Europe/Madrid",
};

const RESULT: SummaryResult = {
  overview: "Deletion test summary.",
  keyDiscussions: [],
  confirmedDecisions: [],
  proposals: [],
  unresolvedQuestions: [],
  tasks: [],
  links: [],
  aiGenerated: true,
};

const CHAT_ID = "111111111111-22222222@g.us";

/**
 * Seeds every deletable kind of captured data plus the administrative
 * state that must survive the deletion. Returns the run id for the
 * summary lookup after deletion.
 */
async function seed(store: InMemoryStore): Promise<string> {
  await store.upsertGroup({
    id: GROUP_ID,
    chatId: CHAT_ID,
    name: "Deletion Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: "09:00",
    historyImport: null,
  });
  await store.upsertGroup({
    id: "5a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    chatId: null,
    name: "Unmonitored Group",
    monitored: false,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  await store.upsertGroupMembers(CHAT_ID, [
    {
      userId: "111@s.whatsapp.net",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
    {
      userId: "222@lid",
      name: "Beto",
      phone: null,
      isAdmin: true,
      active: true,
    },
  ]);
  await store.renameContact("111@s.whatsapp.net", "Ana Override");
  store.seedMessages([
    {
      id: "9b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
      chatId: CHAT_ID,
      sentAt: "2026-11-01T10:00:00Z",
      senderId: "111@s.whatsapp.net",
      senderName: "Ana",
      body: "first",
      messageType: "text",
    },
    {
      id: "9b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4e",
      chatId: CHAT_ID,
      sentAt: "2026-11-01T11:00:00Z",
      senderId: "222@lid",
      senderName: "Beto",
      body: "second",
      messageType: "text",
    },
  ]);
  const { run } = await store.createOrFindRun({
    groupId: GROUP_ID,
    interval: INTERVAL,
    kind: "manual",
  });
  await store.saveSummary({
    id: "7c1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    runId: run.id,
    provider: "mock",
    model: "mock-1",
    result: RESULT,
    createdAt: "2026-11-02T00:00:00Z",
  });

  // Administrative state that must survive.
  await store.setProviderConfig({
    provider: "mock",
    model: "mock-1",
    baseUrl: null,
    apiKey: null,
  });
  await store.setDefaultTimezone("America/Caracas");
  await store.setDefaultDateFormat("YYYY-MM-DD");
  await store.setConnectionStatus({
    state: "connected",
    since: "2026-11-01T00:00:00Z",
    lastMessageAt: "2026-11-01T11:00:00Z",
    linking: null,
    check: null,
  });
  return run.id;
}

describe("POST /api/admin/delete-all-data", () => {
  it("rejects anything but the exact DELETE ALL confirmation", async () => {
    const { app, store, enqueue } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    await seed(store);

    for (const payload of [
      {},
      { confirmation: "DELETE" },
      { confirmation: "delete all" },
      { confirmation: " DELETE ALL" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/delete-all-data",
        headers: { cookie: session },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
    }

    // Nothing was deleted and the queue was never purged.
    expect(await store.listGroups()).toHaveLength(2);
    expect(await store.listGroupMessages(CHAT_ID, { limit: 50 })).toHaveLength(
      2,
    );
    expect(enqueue.purged).toBe(0);
  });

  it("deletes captured data, returns exact counts, and purges the queue", async () => {
    const { app, store, enqueue } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    const runId = await seed(store);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delete-all-data",
      headers: { cookie: session },
      payload: { confirmation: "DELETE ALL" },
    });
    expect(res.statusCode).toBe(200);
    const body = DeleteAllDataResponse.parse(res.json());
    expect(body).toEqual({
      ok: true,
      deleted: {
        groups: 2,
        messages: 2,
        summaryRuns: 1,
        summaries: 1,
        groupMembers: 2,
        contactOverrides: 1,
      },
    });

    // Captured data is gone.
    expect(await store.listGroups()).toEqual([]);
    expect(await store.listGroupMembers(CHAT_ID)).toEqual([]);
    expect(await store.listGroupMessages(CHAT_ID, { limit: 50 })).toEqual([]);
    expect(await store.listRuns()).toEqual([]);
    expect(await store.getSummaryByRunId(runId)).toBeUndefined();
    expect(await store.listContacts()).toEqual([]);

    // Administrative state is kept.
    expect(await store.getAdmin()).not.toBeNull();
    expect(await store.getProviderConfig()).not.toBeNull();
    expect(await store.getDefaultTimezone()).toBe("America/Caracas");
    expect(await store.getDefaultDateFormat()).toBe("YYYY-MM-DD");
    const connection = await store.getConnectionStatus();
    expect(connection.state).toBe("connected");
    expect(connection.lastMessageAt).toBeNull();

    // The session survives: the same cookie still authorizes requests.
    const groups = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(groups.statusCode).toBe(200);
    expect(groups.json()).toEqual([]);

    expect(enqueue.purged).toBe(1);
  });

  it("still answers 200 when the queue purge fails", async () => {
    const { app, store, enqueue } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    await seed(store);
    enqueue.failPurgeWith = new Error("redis is down");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delete-all-data",
      headers: { cookie: session },
      payload: { confirmation: "DELETE ALL" },
    });
    expect(res.statusCode).toBe(200);
    expect(DeleteAllDataResponse.parse(res.json()).deleted.groups).toBe(2);
    // The database deletion already committed; only cleanup failed.
    expect(await store.listGroups()).toEqual([]);
    expect(enqueue.purged).toBe(0);
  });

  it("requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delete-all-data",
      payload: { confirmation: "DELETE ALL" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("InMemoryStore.deleteAllData", () => {
  it("is idempotent and reports zero counts once empty", async () => {
    const store = new InMemoryStore();
    await seed(store);

    const first = await store.deleteAllData();
    expect(first.messages).toBe(2);

    const second = await store.deleteAllData();
    expect(second).toEqual({
      groups: 0,
      messages: 0,
      summaryRuns: 0,
      summaries: 0,
      groupMembers: 0,
      contactOverrides: 0,
    });
  });
});
