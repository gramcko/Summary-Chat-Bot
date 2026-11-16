import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AssistantChatResponse,
  ApiError,
  type ApiMessage,
  type ContactSummary,
  type Group,
} from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import { AssistantRateLimiter } from "../src/lib/assistant/rate-limit.js";
import { AssistantService } from "../src/lib/assistant/service.js";
import { parseAssistantMessage } from "../src/lib/assistant/parser.js";
import { periodToInterval } from "../src/lib/assistant/period.js";
import { HttpError } from "../src/lib/errors.js";
import { InMemoryStore } from "../src/lib/store.js";
import {
  RecordingEnqueuer,
  login,
  makeApp,
  setupAdmin,
} from "./helpers.js";

/**
 * Dashboard assistant (MVP): deterministic intents over monitored data.
 * No AI provider is involved, and unmonitored groups/rosters must never
 * be reachable through a reply.
 */

const CHAT_A = "120363000000000001@g.us";
const CHAT_B = "120363000000000002@g.us";
const CHAT_PRIVATE = "120363000000000003@g.us";

// 13:00 in Europe/Madrid (CET, UTC+1) — "today" starts at 23:00Z the day before.
const NOW = new Date("2026-11-16T12:00:00Z");

function message(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: randomUUID(),
    chatId: CHAT_A,
    sentAt: "2026-11-16T09:00:00Z",
    senderId: "111:4@s.whatsapp.net",
    senderName: null,
    body: "hello",
    messageType: "text",
    ...overrides,
  };
}

interface Fixture {
  store: InMemoryStore;
  enqueue: RecordingEnqueuer;
  service: AssistantService;
  groupA: string;
  groupB: string;
  groupPrivate: string;
  messages: { launchA: ApiMessage; launchB: ApiMessage; privateMessage: ApiMessage };
}

async function fixture(now: Date = NOW): Promise<Fixture> {
  const store = new InMemoryStore();
  const groupA = randomUUID();
  const groupB = randomUUID();
  const groupPrivate = randomUUID();
  await store.upsertGroup({
    id: groupA,
    chatId: CHAT_A,
    name: "Equipo Ventas",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
    historyImport: null,
  });
  await store.upsertGroup({
    id: groupB,
    chatId: CHAT_B,
    name: "Soporte",
    monitored: true,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  await store.upsertGroup({
    id: groupPrivate,
    chatId: CHAT_PRIVATE,
    name: "Privado",
    monitored: false,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  // Ana is active in both monitored groups; Bob only in A; Eve only in the
  // unmonitored group (so she is not a contact at all).
  await store.upsertGroupMembers(CHAT_A, [
    {
      userId: "111@lid",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
    { userId: "222@lid", name: "Bob", phone: null, isAdmin: false, active: true },
  ]);
  await store.upsertGroupMembers(CHAT_B, [
    {
      userId: "111@lid",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
  ]);
  await store.upsertGroupMembers(CHAT_PRIVATE, [
    { userId: "333@lid", name: "Eve", phone: null, isAdmin: false, active: true },
  ]);

  const launchA = message({
    sentAt: "2026-11-16T09:00:00Z",
    body: "El lanzamiento queda confirmado para el viernes",
  });
  const launchB = message({
    chatId: CHAT_B,
    senderId: "111@lid",
    sentAt: "2026-11-16T11:00:00Z",
    body: "Revisé el informe de lanzamiento",
  });
  const privateMessage = message({
    chatId: CHAT_PRIVATE,
    senderId: "333@lid",
    sentAt: "2026-11-16T11:30:00Z",
    body: "lanzamiento secreto",
  });
  const chatter = message({
    sentAt: "2026-11-16T10:00:00Z",
    senderId: "222@lid",
    body: "Gracias por avisar",
  });
  store.seedMessages([launchA, launchB, privateMessage, chatter]);

  const enqueue = new RecordingEnqueuer();
  const service = new AssistantService({
    store,
    enqueue,
    now: () => now,
  });
  return {
    store,
    enqueue,
    service,
    groupA,
    groupB,
    groupPrivate,
    messages: { launchA, launchB, privateMessage },
  };
}

function chat(content: string) {
  return { messages: [{ role: "user" as const, content }] };
}

describe("AssistantService: summary intent", () => {
  it("creates a manual run for the requested period and enqueues it", async () => {
    const { service, store, enqueue, groupA } = await fixture();
    const res = await service.chat(chat("do a summary on Equipo Ventas today"));

    expect(res.pendingRunId).toBeTypeOf("string");
    expect(res.citations).toEqual([
      {
        kind: "run",
        groupId: groupA,
        groupName: "Equipo Ventas",
        messageId: null,
        runId: res.pendingRunId,
        sentAt: null,
      },
    ]);
    expect(enqueue.enqueued).toEqual([res.pendingRunId]);
    expect(res.reply).toContain("Equipo Ventas");

    const run = await store.getRun(res.pendingRunId as string);
    expect(run?.kind).toBe("manual");
    expect(run?.status).toBe("pending");
    expect(run?.instructions).toBeNull();
    expect(run?.interval.timezone).toBe("Europe/Madrid");
    // Today in Madrid: [local midnight, now) = [23:00Z previous day, 12:00Z).
    expect(Date.parse(run?.interval.start ?? "")).toBe(
      Date.parse("2026-11-15T23:00:00Z"),
    );
    expect(Date.parse(run?.interval.end ?? "")).toBe(NOW.getTime());
  });

  it("reuses the existing run for the same group and period", async () => {
    const { service, store } = await fixture();
    const first = await service.chat(chat("summarize Equipo Ventas yesterday"));
    const second = await service.chat(chat("resumen de Equipo Ventas ayer"));

    expect(second.pendingRunId).toBe(first.pendingRunId);
    expect(await store.listRuns()).toHaveLength(1);
    const run = await store.getRun(first.pendingRunId as string);
    // Yesterday in Madrid is the full previous local day.
    expect(Date.parse(run?.interval.start ?? "")).toBe(
      Date.parse("2026-11-14T23:00:00Z"),
    );
    expect(Date.parse(run?.interval.end ?? "")).toBe(
      Date.parse("2026-11-15T23:00:00Z"),
    );
  });

  it("defaults to the last 24 hours when no period is named", async () => {
    const { service, store } = await fixture();
    const res = await service.chat(chat("do a summary on Soporte"));
    const run = await store.getRun(res.pendingRunId as string);
    expect(run?.interval.timezone).toBe("UTC");
    expect(Date.parse(run?.interval.start ?? "")).toBe(
      NOW.getTime() - 24 * 60 * 60 * 1000,
    );
    expect(Date.parse(run?.interval.end ?? "")).toBe(NOW.getTime());
  });

  it("tolerates a queue outage: the run stays durable and pending", async () => {
    const { service, enqueue, store } = await fixture();
    enqueue.failWith = new Error("redis down");

    const res = await service.chat(chat("do a summary on Equipo Ventas"));
    expect(res.pendingRunId).toBeTypeOf("string");
    expect(res.reply).toContain("pending");
    expect(res.reply).toContain("retried automatically");
    expect(await store.getRun(res.pendingRunId as string)).toBeDefined();
  });

  it("does not summarize an unmonitored group", async () => {
    const { service, store } = await fixture();
    const res = await service.chat(chat("summarize Privado today"));

    expect(res.pendingRunId).toBeNull();
    expect(res.reply).toContain("couldn't match a group");
    expect(res.reply).not.toContain("Privado");
    expect(res.reply).toContain("Equipo Ventas");
    expect(res.reply).toContain("Soporte");
    expect(await store.listRuns()).toHaveLength(0);
  });
});

describe("AssistantService: contact_groups intent", () => {
  it("lists the monitored groups a contact participates in", async () => {
    const { service, groupA, groupB } = await fixture();
    const res = await service.chat(
      chat("which groups does Ana participate in?"),
    );

    expect(res.reply).toContain("Ana participates in 2 monitored groups");
    expect(res.citations).toHaveLength(2);
    expect(res.citations.map((citation) => citation.kind)).toEqual([
      "group",
      "group",
    ]);
    expect(res.citations.map((citation) => citation.groupId).sort()).toEqual(
      [groupA, groupB].sort(),
    );
    expect(res.pendingRunId).toBeNull();
  });

  it("works in Spanish and asks for a contact when none matches", async () => {
    const { service } = await fixture();
    const ok = await service.chat(chat("en qué grupos participa Ana"));
    expect(ok.reply).toContain("Ana participates in 2 monitored groups");

    const clarify = await service.chat(chat("en qué grupos participa Zzz"));
    expect(clarify.reply).toContain("couldn't match a contact");
    expect(clarify.reply).toContain("Ana");
    expect(clarify.reply).not.toContain("Eve"); // unmonitored roster
  });
});

describe("AssistantService: search_messages intent", () => {
  it("returns cited hits across monitored groups with timestamps", async () => {
    const { service, messages } = await fixture();
    const res = await service.chat(
      chat("when did Ana say something about lanzamiento"),
    );

    expect(res.citations).toHaveLength(2);
    expect(res.citations.every((citation) => citation.kind === "message")).toBe(
      true,
    );
    expect(
      res.citations.map((citation) => citation.messageId).sort(),
    ).toEqual([messages.launchA.id, messages.launchB.id].sort());
    for (const citation of res.citations) {
      expect(citation.sentAt).toBeTypeOf("string");
      expect(citation.groupName).not.toBe("Privado");
    }
    // Newest first among equally relevant hits.
    expect(res.citations[0]?.messageId).toBe(messages.launchB.id);
    expect(res.reply).toContain("lanzamiento");
    expect(res.reply).toContain("Equipo Ventas");
    expect(res.reply).toContain("Soporte");
    // The excerpt quotes the message, and the unmonitored chat is absent.
    expect(res.reply).toContain("Revisé el informe de lanzamiento");
    expect(res.reply).not.toContain("lanzamiento secreto");
  });

  it("scopes the search to a named monitored group", async () => {
    const { service, messages } = await fixture();
    const res = await service.chat(
      chat("search messages from Ana in Equipo Ventas about lanzamiento"),
    );
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]?.messageId).toBe(messages.launchA.id);
  });

  it("searches all recent messages when no topic remains", async () => {
    const { service, messages } = await fixture();
    const res = await service.chat(chat("when did Ana last talk"));
    expect(res.citations.map((citation) => citation.messageId)).toEqual([
      messages.launchB.id,
      messages.launchA.id,
    ]);
    expect(res.reply).toContain("most recent");
  });

  it("never searches messages of an unmonitored group", async () => {
    const { service } = await fixture();
    // Eve is not a contact (unmonitored roster) and her message body must
    // not be reachable even though it contains the topic.
    const res = await service.chat(chat("when did Eve say something about lanzamiento"));
    expect(res.citations).toHaveLength(0);
    expect(res.reply).not.toContain("secreto");
    expect(res.reply).toContain("couldn't match a contact");
  });

  it("reports no hits without inventing one", async () => {
    const { service } = await fixture();
    const res = await service.chat(
      chat("when did Ana say something about presupuesto"),
    );
    expect(res.citations).toEqual([]);
    expect(res.reply).toBe("I found no messages from Ana about “presupuesto”.");
  });
});

describe("AssistantService: clarification and help", () => {
  it("asks which group when two groups match the same name", async () => {
    const { store } = await fixture();
    const duplicateA = randomUUID();
    const duplicateB = randomUUID();
    for (const id of [duplicateA, duplicateB]) {
      await store.upsertGroup({
        id,
        chatId: `${id}@g.us`,
        name: "Duplicado",
        monitored: true,
        timezone: "UTC",
        summaryTime: null,
        historyImport: null,
      });
    }
    const enqueue = new RecordingEnqueuer();
    const service = new AssistantService({ store, enqueue, now: () => NOW });

    const res = await service.chat(chat("summarize Duplicado today"));
    expect(res.pendingRunId).toBeNull();
    expect(res.reply).toContain("More than one group matches");
    expect(res.citations).toHaveLength(2);
    expect(enqueue.enqueued).toEqual([]);
    expect(await store.listRuns()).toHaveLength(0);
  });

  it("falls back to help when no intent is recognized", async () => {
    const { service } = await fixture();
    const res = await service.chat(chat("hello there"));
    expect(res.reply).toContain("I can help with three things");
    expect(res.citations).toEqual([]);
    expect(res.pendingRunId).toBeNull();

    // A bare name with no trigger is not an intent either.
    const named = await service.chat(chat("Equipo Ventas"));
    expect(named.reply).toContain("I can help with three things");
  });

  it("answers the most recent user turn, ignoring assistant turns", async () => {
    const { service } = await fixture();
    const res = await service.chat({
      messages: [
        { role: "user", content: "do a summary on Soporte today" },
        { role: "assistant", content: "Queued." },
      ],
    });
    expect(res.pendingRunId).toBeTypeOf("string");
  });
});

describe("parseAssistantMessage", () => {
  const groups: Group[] = [
    {
      id: randomUUID(),
      chatId: CHAT_A,
      name: "Equipo Ventas",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    },
    {
      id: randomUUID(),
      chatId: CHAT_B,
      name: "Ventas",
      monitored: true,
      timezone: "UTC",
      summaryTime: null,
      historyImport: null,
    },
  ];
  const contacts: ContactSummary[] = [
    {
      id: "111@s.whatsapp.net",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      groups: [{ id: groups[0]?.id ?? randomUUID(), name: "Equipo Ventas" }],
      messageCount: 1,
      lastMessageAt: null,
    },
  ];

  it("matches names case- and accent-insensitively", () => {
    const parsed = parseAssistantMessage({
      text: "haz un resumen de equipo ventas hoy",
      groups,
      contacts,
    });
    expect(parsed).toMatchObject({ intent: "summary", period: "today" });
  });

  it("prefers the longest matching name", () => {
    const parsed = parseAssistantMessage({
      text: "do a summary on Equipo Ventas",
      groups,
      contacts,
    });
    expect(parsed.intent).toBe("summary");
    if (parsed.intent !== "summary") throw new Error("expected summary");
    expect(parsed.group.name).toBe("Equipo Ventas");
  });

  it("strips names and stop words from the search query", () => {
    const parsed = parseAssistantMessage({
      text: "cuándo dijo Ana en Equipo Ventas sobre el lanzamiento",
      groups,
      contacts,
    });
    expect(parsed.intent).toBe("search_messages");
    if (parsed.intent !== "search_messages") throw new Error("expected search");
    expect(parsed.contact.name).toBe("Ana");
    expect(parsed.group?.name).toBe("Equipo Ventas");
    expect(parsed.query).toBe("lanzamiento");
  });

  it("does not treat a name containing a trigger word as an intent", () => {
    const parsed = parseAssistantMessage({
      text: "Search Team",
      groups: [
        {
          id: randomUUID(),
          chatId: null,
          name: "Search Team",
          monitored: true,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        },
      ],
      contacts: [],
    });
    expect(parsed.intent).toBe("help");
  });
});

describe("parseAssistantMessage: contact name aliases", () => {
  const groups: Group[] = [
    {
      id: randomUUID(),
      chatId: CHAT_A,
      name: "Equipo Ventas",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    },
  ];

  function contact(id: string, name: string): ContactSummary {
    return {
      id,
      name,
      phone: id,
      groups: [{ id: groups[0]?.id ?? randomUUID(), name: "Equipo Ventas" }],
      messageCount: 1,
      lastMessageAt: null,
    };
  }

  const gramcko = contact("111@s.whatsapp.net", "Carlos Luis Gramcko");

  it("resolves a contact from a single word of a full name", () => {
    // The dashboard suggests exactly this phrasing, while rosters store
    // the full name.
    const parsed = parseAssistantMessage({
      text: "which groups does Carlos participate in?",
      groups,
      contacts: [gramcko],
    });
    expect(parsed.intent).toBe("contact_groups");
    if (parsed.intent !== "contact_groups") throw new Error("expected contact");
    expect(parsed.contact.id).toBe(gramcko.id);
  });

  it("matches any word of the name, accent-insensitively", () => {
    const accented = contact("222@s.whatsapp.net", "Andrés Muñoz");
    for (const text of [
      "en qué grupos participa andres",
      "en qué grupos participa muñoz",
    ]) {
      const parsed = parseAssistantMessage({
        text,
        groups,
        contacts: [accented],
      });
      expect(parsed.intent).toBe("contact_groups");
      if (parsed.intent !== "contact_groups") throw new Error("expected contact");
      expect(parsed.contact.id).toBe(accented.id);
    }
  });

  it("asks for a clarification when two contacts share the first name", () => {
    const other = contact("333@s.whatsapp.net", "Carlos Ruiz");
    const parsed = parseAssistantMessage({
      text: "which groups does Carlos participate in?",
      groups,
      contacts: [gramcko, other],
    });
    expect(parsed.intent).toBe("clarify");
    if (parsed.intent !== "clarify") throw new Error("expected clarify");
    expect(parsed.subject).toBe("contact");
    expect(parsed.reason).toBe("ambiguous");
    expect(parsed.candidates.map((candidate) => candidate.name).sort()).toEqual([
      "Carlos Luis Gramcko",
      "Carlos Ruiz",
    ]);
  });

  it("still prefers the full name over a shared first name", () => {
    const other = contact("333@s.whatsapp.net", "Carlos Ruiz");
    const parsed = parseAssistantMessage({
      text: "which groups does Carlos Luis Gramcko participate in?",
      groups,
      contacts: [gramcko, other],
    });
    expect(parsed.intent).toBe("contact_groups");
    if (parsed.intent !== "contact_groups") throw new Error("expected contact");
    expect(parsed.contact.id).toBe(gramcko.id);
  });

  it("masks the alias before extracting the search query", () => {
    const parsed = parseAssistantMessage({
      text: "when did Carlos say something about lanzamiento",
      groups,
      contacts: [gramcko],
    });
    expect(parsed.intent).toBe("search_messages");
    if (parsed.intent !== "search_messages") throw new Error("expected search");
    expect(parsed.contact.id).toBe(gramcko.id);
    expect(parsed.query).toBe("lanzamiento");
  });

  it("keeps group names full-name-only so groups stay unambiguous", () => {
    const parsed = parseAssistantMessage({
      text: "do a summary on Ventas today",
      groups: [
        ...groups,
        {
          id: randomUUID(),
          chatId: CHAT_B,
          name: "Ventas Internacionales",
          monitored: true,
          timezone: "UTC",
          summaryTime: null,
          historyImport: null,
        },
      ],
      contacts: [],
    });
    // "Ventas" is not an alias of either group: no guessing, ask instead.
    expect(parsed.intent).toBe("clarify");
    if (parsed.intent !== "clarify") throw new Error("expected clarify");
    expect(parsed.subject).toBe("group");
    expect(parsed.reason).toBe("not_found");
  });
});

describe("periodToInterval", () => {
  it("uses the group time zone for day boundaries", () => {
    const today = periodToInterval("today", "Europe/Madrid", NOW);
    expect(today.start).toBe("2026-11-15T23:00:00.000Z");
    expect(today.end).toBe("2026-11-16T12:00:00.000Z");

    const yesterday = periodToInterval("yesterday", "Europe/Madrid", NOW);
    expect(yesterday.start).toBe("2026-11-14T23:00:00.000Z");
    expect(yesterday.end).toBe("2026-11-15T23:00:00.000Z");
  });

  it("treats last_24h and last_7d as rolling windows ending now", () => {
    const day = periodToInterval("last_24h", "UTC", NOW);
    expect(day.end).toBe(NOW.toISOString());
    expect(Date.parse(day.end) - Date.parse(day.start)).toBe(24 * 60 * 60 * 1000);

    const week = periodToInterval("last_7d", "UTC", NOW);
    expect(Date.parse(week.end) - Date.parse(week.start)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it("falls back to UTC for an invalid time zone", () => {
    const interval = periodToInterval("yesterday", "Not/AZone", NOW);
    expect(interval.timezone).toBe("UTC");
    expect(interval.start).toBe("2026-11-15T00:00:00.000Z");
    expect(interval.end).toBe("2026-11-16T00:00:00.000Z");
  });

  it("keeps a valid non-empty interval at exactly local midnight", () => {
    // 2026-11-16T00:00Z is exactly midnight in UTC.
    const interval = periodToInterval(
      "today",
      "UTC",
      new Date("2026-11-16T00:00:00Z"),
    );
    expect(Date.parse(interval.end)).toBeGreaterThan(
      Date.parse(interval.start),
    );
  });
});

describe("AssistantRateLimiter", () => {
  it("allows the limit, rejects the next request, and resets per window", () => {
    let clock = 1_000_000;
    const limiter = new AssistantRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => clock,
    });

    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    let caught: unknown;
    try {
      limiter.check("1.1.1.1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).statusCode).toBe(429);
    expect((caught as HttpError).code).toBe("rate_limited");
    expect((caught as HttpError).headers?.["Retry-After"]).toBe("60");

    // Another IP has its own bucket.
    limiter.check("2.2.2.2");

    clock += 60_000;
    limiter.check("1.1.1.1");
  });
});

describe("POST /api/assistant/chat", () => {
  async function assistantApp(options: { limit?: number } = {}) {
    const store = new InMemoryStore();
    const enqueue = new RecordingEnqueuer();
    const app = await buildApp({
      store,
      enqueue,
      cookieSecure: false,
      logger: false,
      assistantRateLimit:
        options.limit === undefined
          ? undefined
          : { limit: options.limit, windowMs: 60_000 },
    });
    await setupAdmin(app);
    const session = await login(app);
    const groupId = randomUUID();
    await store.upsertGroup({
      id: groupId,
      chatId: CHAT_A,
      name: "Equipo Ventas",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    return { app, store, enqueue, session, groupId };
  }

  it("requires authentication", async () => {
    const { app } = await assistantApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/chat",
      payload: chat("do a summary on Equipo Ventas"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates the request body", async () => {
    const { app, session } = await assistantApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/chat",
      headers: { cookie: session },
      payload: { messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
  });

  it("answers with a contract-valid response and enqueues the run", async () => {
    const { app, session, enqueue, groupId } = await assistantApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/chat",
      headers: { cookie: session },
      payload: chat("do a summary on Equipo Ventas today"),
    });
    expect(res.statusCode).toBe(200);
    const body = AssistantChatResponse.parse(res.json());
    expect(body.pendingRunId).toBeTypeOf("string");
    expect(body.citations[0]?.groupId).toBe(groupId);
    expect(enqueue.enqueued).toEqual([body.pendingRunId]);
  });

  it("rate limits per IP with a 429 envelope", async () => {
    const { app, session } = await assistantApp({ limit: 2 });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/assistant/chat",
        headers: { cookie: session },
        payload: chat("hello"),
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    const error = ApiError.parse(limited.json()).error;
    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("Too many assistant requests");
  });
});

describe("assistant route registration", () => {
  it("is reachable only inside the authenticated group (helpers parity)", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/chat",
      payload: chat("hello"),
    });
    // Without a session the auth hook wins before validation.
    expect(res.statusCode).toBe(401);
  });
});
