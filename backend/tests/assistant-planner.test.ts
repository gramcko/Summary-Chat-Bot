import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiMessage, ContactSummary, Group } from "@summarly/contracts";
import {
  PLANNER_API_BASE_URL,
  PLANNER_MAX_OUTPUT_TOKENS,
  PLANNER_SYSTEM_INSTRUCTION,
  createGeminiPlanner,
  parsePlannerResponse,
  type PlannerStore,
} from "../src/lib/assistant/gemini-planner.js";
import type {
  AssistantPlan,
  AssistantPlanner,
} from "../src/lib/assistant/planner.js";
import {
  AssistantService,
  type AssistantLogger,
} from "../src/lib/assistant/service.js";
import { InMemoryStore, type ProviderRecord } from "../src/lib/store.js";
import { buildApp } from "../src/app.js";
import { RecordingEnqueuer, login, setupAdmin } from "./helpers.js";

/**
 * Planner-only Gemini integration (ADR 0009).
 *
 * Two invariants under test:
 * 1. The model only CLASSIFIES: its plan is validated against monitored
 *    data, and every failure falls back to the deterministic parser.
 * 2. What leaves the process is the question plus monitored group/contact
 *    NAMES — never message bodies, JIDs, phones, or the key in the prompt.
 *
 * All provider calls are stubbed fetch fixtures: no network, no cost.
 */

const API_KEY = "AIza-FAKE-KEY-for-tests";
const CHAT_A = "120363000000000001@g.us";
const CHAT_B = "120363000000000002@g.us";
const CHAT_PRIVATE = "120363000000000003@g.us";
const NOW = new Date("2026-11-16T12:00:00Z");

function makeGroup(name: string, monitored = true): Group {
  return {
    id: randomUUID(),
    chatId: CHAT_A,
    name,
    monitored,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  };
}

function makeContact(name: string | null, phone: string | null): ContactSummary {
  return {
    id: phone ?? "333@lid",
    name,
    phone,
    groups: [],
    messageCount: 1,
    lastMessageAt: null,
  };
}

function plan(overrides: Partial<AssistantPlan> = {}): AssistantPlan {
  return {
    intent: "summary",
    groupName: null,
    contactName: null,
    query: null,
    period: null,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responses: Array<{ status: number; body: string }>,
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const fixture = responses[Math.min(index, responses.length - 1)] ?? {
      status: 500,
      body: "{}",
    };
    index += 1;
    return new Response(fixture.body, {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, captured };
}

function successBody(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  });
}

function geminiConfig(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    provider: "google-gemini",
    model: "gemini-3.8-flash",
    baseUrl: null,
    apiKey: API_KEY,
    ...overrides,
  };
}

function storeWith(
  config: ProviderRecord | null | (() => Promise<ProviderRecord | null>),
): PlannerStore {
  if (typeof config === "function") {
    return { getProviderConfig: config };
  }
  return { getProviderConfig: async () => config };
}

type LoggedEvent = {
  event: string;
  fields: Record<string, string | number | boolean | null>;
};

function recordingLog(): { log: AssistantLogger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return {
    events,
    log: (event, fields) => {
      events.push({ event, fields });
    },
  };
}

// ---- response parsing ----------------------------------------------------

describe("parsePlannerResponse", () => {
  it("accepts a valid plan", () => {
    const value = plan({
      intent: "search_messages",
      contactName: "Ana",
      groupName: "Equipo Ventas",
      query: "lanzamiento",
      period: "last_7d",
    });
    expect(parsePlannerResponse(JSON.stringify(value))).toEqual(value);
  });

  it("accepts JSON wrapped in a code fence", () => {
    const value = plan({ intent: "help" });
    const fenced = "```json\n" + JSON.stringify(value) + "\n```";
    expect(parsePlannerResponse(fenced)).toEqual(value);
  });

  it("rejects invalid JSON", () => {
    expect(parsePlannerResponse("{not json")).toBeNull();
    expect(parsePlannerResponse("")).toBeNull();
  });

  it("rejects a wrong schema", () => {
    // Unknown intent.
    expect(
      parsePlannerResponse(JSON.stringify(plan({ intent: "drop_tables" as never }))),
    ).toBeNull();
    // Unknown period.
    expect(
      parsePlannerResponse(
        JSON.stringify(plan({ period: "last_year" as never })),
      ),
    ).toBeNull();
    // Over-long name.
    expect(
      parsePlannerResponse(
        JSON.stringify(plan({ groupName: "x".repeat(301) })),
      ),
    ).toBeNull();
    // Missing required keys.
    expect(parsePlannerResponse(JSON.stringify({ intent: "help" }))).toBeNull();
    // A non-object payload.
    expect(parsePlannerResponse(JSON.stringify(["help"]))).toBeNull();
  });
});

// ---- provider gating -----------------------------------------------------

describe("createGeminiPlanner: provider gating", () => {
  const input = {
    text: "do a summary on Equipo Ventas",
    groups: [makeGroup("Equipo Ventas")],
    contacts: [makeContact("Ana", "111@s.whatsapp.net")],
  };

  it("returns null without a call for the mock provider", async () => {
    const { fetchImpl, captured } = stubFetch([
      { status: 200, body: successBody(JSON.stringify(plan())) },
    ]);
    const planner = createGeminiPlanner({
      store: storeWith(geminiConfig({ provider: "mock" })),
      fetchImpl,
    });
    expect(await planner.plan(input)).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("returns null without a call when unconfigured", async () => {
    const { fetchImpl, captured } = stubFetch([]);
    const planner = createGeminiPlanner({ store: storeWith(null), fetchImpl });
    expect(await planner.plan(input)).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("returns null without a call when the key is missing or blank", async () => {
    for (const apiKey of [null, "", "   "]) {
      const { fetchImpl, captured } = stubFetch([]);
      const planner = createGeminiPlanner({
        store: storeWith(geminiConfig({ apiKey })),
        fetchImpl,
      });
      expect(await planner.plan(input)).toBeNull();
      expect(captured).toHaveLength(0);
    }
  });

  it("returns null and logs a safe reason when the key is unreadable", async () => {
    const { fetchImpl, captured } = stubFetch([]);
    const { log, events } = recordingLog();
    const planner = createGeminiPlanner({
      store: storeWith(async () => {
        throw new Error("decrypt failed: AIza-SECRET");
      }),
      fetchImpl,
      log,
    });
    expect(await planner.plan(input)).toBeNull();
    expect(captured).toHaveLength(0);
    expect(events).toEqual([
      { event: "assistant_planner_failed", fields: { reason: "config" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("AIza-SECRET");
  });
});

// ---- request shape and data boundary ------------------------------------

describe("createGeminiPlanner: request shape", () => {
  const groups = [makeGroup("Equipo Ventas"), makeGroup("Privado", false)];
  const contacts = [
    makeContact("Ana", "111@s.whatsapp.net"),
    makeContact(null, "222@s.whatsapp.net"),
  ];
  const question = "when did Ana say something about the launch?";

  async function capture(overrides: Partial<ProviderRecord> = {}) {
    const { fetchImpl, captured } = stubFetch([
      { status: 200, body: successBody(JSON.stringify(plan({ intent: "help" }))) },
    ]);
    const planner = createGeminiPlanner({
      store: storeWith(geminiConfig(overrides)),
      fetchImpl,
    });
    await planner.plan({ text: question, groups, contacts });
    const request = captured[0];
    if (request === undefined) throw new Error("no request captured");
    return request;
  }

  it("posts to the official endpoint with the saved model and key header", async () => {
    const request = await capture({ model: "models/gemini-3.5-flash-lite" });
    expect(request.url).toBe(
      `${PLANNER_API_BASE_URL}/models/gemini-3.5-flash-lite:generateContent`,
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("falls back to the default model when the saved one is blank", async () => {
    const request = await capture({ model: "  " });
    expect(request.url).toContain("/models/gemini-3.8-flash:generateContent");
  });

  it("ignores a custom baseUrl (the key only goes to Google)", async () => {
    const request = await capture({ baseUrl: "https://evil.example/v1beta" });
    expect(request.url.startsWith(PLANNER_API_BASE_URL)).toBe(true);
    expect(request.url).not.toContain("evil.example");
  });

  it("sends the fixed instruction plus a question-and-names JSON block", async () => {
    const request = await capture();
    const body = JSON.parse(String(request.init.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: Record<string, unknown>;
      store: unknown;
    };

    expect(body.systemInstruction.parts[0]?.text).toBe(
      PLANNER_SYSTEM_INSTRUCTION,
    );
    // The instruction is a constant: no user text or names inside it.
    expect(PLANNER_SYSTEM_INSTRUCTION).not.toContain(question);
    expect(PLANNER_SYSTEM_INSTRUCTION).not.toContain("Equipo Ventas");

    const userText = body.contents[0]?.parts[0]?.text ?? "";
    const json = userText
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .join("");
    expect(JSON.parse(json)).toEqual({
      question,
      groups: ["Equipo Ventas"],
      contacts: ["Ana"],
    });

    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
    });
    expect(body.generationConfig.responseSchema).toBeTypeOf("object");
    expect(body.store).toBe(false);
  });

  it("never sends message bodies, JIDs, phones, or nameless contacts", async () => {
    const request = await capture();
    const serialized = `${request.url}\n${JSON.stringify(request.init.body)}`;
    // Unmonitored group name is absent too (the service filters before).
    expect(serialized).not.toContain("Privado");
    // JIDs / chat ids / phone numbers.
    expect(serialized).not.toContain(CHAT_A);
    expect(serialized).not.toContain("111@s.whatsapp.net");
    expect(serialized).not.toContain("222@s.whatsapp.net");
    // A nameless contact cannot be addressed and is not offered.
    expect(serialized).not.toContain("333@lid");
    // The key is a header, never prompt content.
    expect(JSON.stringify(request.init.body)).not.toContain(API_KEY);
  });
});

// ---- failure handling ----------------------------------------------------

describe("createGeminiPlanner: failures return null", () => {
  const input = {
    text: "hello",
    groups: [makeGroup("Equipo Ventas")],
    contacts: [],
  };

  async function run(
    fetchImpl: typeof fetch,
    log?: AssistantLogger,
    timeoutMs?: number,
  ): Promise<AssistantPlan | null> {
    const planner = createGeminiPlanner({
      store: storeWith(geminiConfig()),
      fetchImpl,
      ...(log === undefined ? {} : { log }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return planner.plan(input);
  }

  it("returns null on a non-2xx response and logs status only", async () => {
    const { fetchImpl } = stubFetch([
      { status: 429, body: '{"error":{"message":"quota for AIza-SECRET"}}' },
    ]);
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events).toEqual([
      {
        event: "assistant_planner_failed",
        fields: { reason: "http_error", status: 429 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("AIza-SECRET");
  });

  it("returns null on an unparseable response body", async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: "not json" }]);
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events[0]?.fields.reason).toBe("malformed_response");
  });

  it("returns null when the model output is not a valid plan", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: successBody(JSON.stringify({ intent: "nope" })) },
    ]);
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events[0]?.fields.reason).toBe("invalid_plan");
  });

  it("returns null on network failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events[0]?.fields.reason).toBe("unavailable");
  });

  it("aborts after the timeout and returns null", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log, 5)).toBeNull();
    expect(events[0]?.fields.reason).toBe("timeout");
  });

  it("never logs the question or the candidate names", async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: "{}" }]);
    const { log, events } = recordingLog();
    await run(fetchImpl, log);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("hello");
    expect(serialized).not.toContain("Equipo Ventas");
    expect(serialized).not.toContain(API_KEY);
  });
});

// ---- service integration -------------------------------------------------

const CHAT_A_MSG = (overrides: Partial<ApiMessage> = {}): ApiMessage => ({
  id: randomUUID(),
  chatId: CHAT_A,
  sentAt: "2026-11-16T09:00:00Z",
  senderId: "111@lid",
  senderName: null,
  body: "hello",
  messageType: "text",
  ...overrides,
});

interface ServiceFixture {
  store: InMemoryStore;
  enqueue: RecordingEnqueuer;
  events: LoggedEvent[];
  groupA: string;
  groupB: string;
  messages: { launchA: ApiMessage; launchB: ApiMessage };
}

async function serviceFixture(
  planner?: AssistantPlanner,
): Promise<{ service: AssistantService } & ServiceFixture> {
  const store = new InMemoryStore();
  const groupA = randomUUID();
  const groupB = randomUUID();
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
    id: randomUUID(),
    chatId: CHAT_PRIVATE,
    name: "Privado",
    monitored: false,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  await store.upsertGroupMembers(CHAT_A, [
    {
      userId: "111@lid",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
    { userId: "222@lid", name: null, phone: null, isAdmin: false, active: true },
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

  const launchA = CHAT_A_MSG({ body: "El lanzamiento queda confirmado" });
  const launchB = CHAT_A_MSG({
    chatId: CHAT_B,
    sentAt: "2026-11-16T11:00:00Z",
    body: "Revisé el informe de lanzamiento",
  });
  store.seedMessages([launchA, launchB]);

  const enqueue = new RecordingEnqueuer();
  const { log, events } = recordingLog();
  const service = new AssistantService({
    store,
    enqueue,
    now: () => NOW,
    log,
    ...(planner === undefined ? {} : { planner }),
  });
  return {
    service,
    store,
    enqueue,
    events,
    groupA,
    groupB,
    messages: { launchA, launchB },
  };
}

function plannerReturning(value: AssistantPlan | null): AssistantPlanner {
  return { plan: async () => value };
}

function chat(content: string) {
  return { messages: [{ role: "user" as const, content }] };
}

function chatLog(events: LoggedEvent[]): LoggedEvent | undefined {
  return events.find((entry) => entry.event === "assistant_chat");
}

describe("AssistantService: planner integration", () => {
  it("uses a valid plan instead of keyword matching", async () => {
    const fixture = await serviceFixture(
      plannerReturning(
        plan({ intent: "summary", groupName: "equipo ventas", period: "yesterday" }),
      ),
    );
    // "hola" has no keyword: only the planner can route this.
    const res = await fixture.service.chat(chat("hola"));

    expect(res.pendingRunId).toBeTypeOf("string");
    const run = await fixture.store.getRun(res.pendingRunId as string);
    expect(run?.groupId).toBe(fixture.groupA);
    // Yesterday in Madrid (CET, UTC+1).
    expect(Date.parse(run?.interval.start ?? "")).toBe(
      Date.parse("2026-11-14T23:00:00Z"),
    );
    expect(fixture.enqueue.enqueued).toEqual([res.pendingRunId]);

    expect(chatLog(fixture.events)?.fields).toMatchObject({
      intent: "summary",
      plannerSource: "gemini",
    });
    // No names or content in the operational log.
    expect(JSON.stringify(fixture.events)).not.toContain("Equipo Ventas");
    expect(JSON.stringify(fixture.events)).not.toContain("hola");
  });

  it("defaults the period to the last 24 hours when the plan omits it", async () => {
    const fixture = await serviceFixture(
      plannerReturning(plan({ intent: "summary", groupName: "Soporte" })),
    );
    const res = await fixture.service.chat(chat("whatever"));
    const run = await fixture.store.getRun(res.pendingRunId as string);
    expect(Date.parse(run?.interval.start ?? "")).toBe(
      NOW.getTime() - 24 * 60 * 60 * 1000,
    );
    expect(run?.interval.timezone).toBe("UTC");
  });

  it("falls back to the parser when the planned group is unknown", async () => {
    const fixture = await serviceFixture(
      plannerReturning(
        plan({ intent: "summary", groupName: "Desconocido", period: "today" }),
      ),
    );
    const res = await fixture.service.chat(
      chat("do a summary on Equipo Ventas today"),
    );
    expect(res.pendingRunId).toBeTypeOf("string");
    const run = await fixture.store.getRun(res.pendingRunId as string);
    expect(run?.groupId).toBe(fixture.groupA);
    expect(chatLog(fixture.events)?.fields).toMatchObject({
      intent: "summary",
      plannerSource: "heuristic",
    });
  });

  it("falls back when a plan is missing a required name", async () => {
    const fixture = await serviceFixture(
      plannerReturning(plan({ intent: "summary", groupName: null })),
    );
    const res = await fixture.service.chat(chat("summarize Soporte today"));
    expect(res.pendingRunId).toBeTypeOf("string");
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
  });

  it("resolves a contact plan case-insensitively", async () => {
    const fixture = await serviceFixture(
      plannerReturning(plan({ intent: "contact_groups", contactName: "ana" })),
    );
    const res = await fixture.service.chat(chat("hola"));
    expect(res.reply).toContain("Ana participates in 2 monitored groups");
    expect(res.citations.map((citation) => citation.groupId).sort()).toEqual(
      [fixture.groupA, fixture.groupB].sort(),
    );
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("gemini");
  });

  it("falls back when the planned contact is unknown", async () => {
    const fixture = await serviceFixture(
      plannerReturning(plan({ intent: "contact_groups", contactName: "Nadie" })),
    );
    const res = await fixture.service.chat(
      chat("which groups does Ana participate in?"),
    );
    expect(res.reply).toContain("Ana participates in 2 monitored groups");
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
  });

  it("executes a search plan with its optional group and query", async () => {
    const fixture = await serviceFixture(
      plannerReturning(
        plan({
          intent: "search_messages",
          contactName: "Ana",
          groupName: "Soporte",
          query: "lanzamiento",
        }),
      ),
    );
    const res = await fixture.service.chat(chat("hola"));
    expect(res.citations.map((citation) => citation.messageId)).toEqual([
      fixture.messages.launchB.id,
    ]);
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("gemini");
  });

  it("falls back when the search plan names an unknown group", async () => {
    const fixture = await serviceFixture(
      plannerReturning(
        plan({
          intent: "search_messages",
          contactName: "Ana",
          groupName: "Desconocido",
          query: "lanzamiento",
        }),
      ),
    );
    // The deterministic parser reads the text, so the whole monitored
    // scope is searched — the unknown scope is never silently widened
    // by the PLAN itself.
    const res = await fixture.service.chat(
      chat("when did Ana say something about lanzamiento"),
    );
    expect(res.citations).toHaveLength(2);
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
  });

  it("returns help for a help plan", async () => {
    const fixture = await serviceFixture(plannerReturning(plan({ intent: "help" })));
    const res = await fixture.service.chat(chat("hola"));
    expect(res.reply).toContain("I can help with three things");
    expect(res.citations).toEqual([]);
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("gemini");
  });

  it("falls back when the planner returns null", async () => {
    const fixture = await serviceFixture(plannerReturning(null));
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.pendingRunId).toBeTypeOf("string");
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
  });

  it("falls back when the planner throws, logging only the error type", async () => {
    const fixture = await serviceFixture({
      plan: async () => {
        throw new TypeError("boom AIza-SECRET");
      },
    });
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.pendingRunId).toBeTypeOf("string");
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
    const failure = fixture.events.find(
      (entry) => entry.event === "assistant_planner_failed",
    );
    expect(failure?.fields).toEqual({ reason: "TypeError" });
    expect(JSON.stringify(fixture.events)).not.toContain("AIza-SECRET");
  });

  it("offers the planner only monitored groups and named contacts", async () => {
    let seen:
      | {
          text: string;
          groups: readonly Group[];
          contacts: readonly ContactSummary[];
        }
      | undefined;
    const fixture = await serviceFixture({
      plan: async (input) => {
        seen = input;
        return null;
      },
    });
    await fixture.service.chat(chat("hello"));

    expect(seen?.text).toBe("hello");
    expect(seen?.groups.map((group) => group.name)).toEqual([
      "Equipo Ventas",
      "Soporte",
    ]);
    // Nameless contacts are passed through but the planner only ever
    // offers names it can match (see plannerCandidateNames).
    expect(
      seen?.contacts.filter((contact) => contact.name !== null).map((contact) => contact.name),
    ).toEqual(["Ana"]);
    expect(seen?.contacts.some((contact) => contact.name === null)).toBe(true);
  });

  it("does not call the planner when there is no user turn", async () => {
    let calls = 0;
    const fixture = await serviceFixture({
      plan: async () => {
        calls += 1;
        return plan({ intent: "help" });
      },
    });
    const res = await fixture.service.chat({
      messages: [{ role: "assistant", content: "Queued." }],
    });
    expect(res.reply).toContain("I can help with three things");
    expect(calls).toBe(0);
    expect(chatLog(fixture.events)?.fields.plannerSource).toBe("heuristic");
  });
});

// ---- route wiring --------------------------------------------------------

describe("POST /api/assistant/chat with an injected planner", () => {
  it("uses the planner and still returns a contract-valid reply", async () => {
    const store = new InMemoryStore();
    const enqueue = new RecordingEnqueuer();
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
    const app = await buildApp({
      store,
      enqueue,
      cookieSecure: false,
      logger: false,
      assistantPlanner: plannerReturning(
        plan({ intent: "summary", groupName: "Equipo Ventas", period: "today" }),
      ),
    });
    await setupAdmin(app);
    const session = await login(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/chat",
      headers: { cookie: session },
      // No summary keyword: the deterministic parser would answer help.
      payload: chat("hola"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pendingRunId: string | null; citations: unknown[] };
    expect(body.pendingRunId).toBeTypeOf("string");
    expect(body.citations).toHaveLength(1);
    expect(enqueue.enqueued).toEqual([body.pendingRunId]);
  });
});
