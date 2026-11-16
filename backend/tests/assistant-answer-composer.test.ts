import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ApiMessage,
  AssistantChatResponse,
} from "@summarly/contracts";
import {
  ANSWER_API_BASE_URL,
  ANSWER_MAX_OUTPUT_TOKENS,
  ANSWER_SYSTEM_INSTRUCTION,
  ANSWER_TEMPERATURE,
  MAX_COMPOSED_ANSWER_CHARS,
  createGeminiAnswerComposer,
  parseAnswerResponse,
  type AnswerComposerStore,
} from "../src/lib/assistant/gemini-answer-composer.js";
import type {
  AssistantAnswerComposer,
  AssistantAnswerComposerInput,
} from "../src/lib/assistant/answer-composer.js";
import {
  AssistantService,
  type AssistantLogger,
} from "../src/lib/assistant/service.js";
import { InMemoryStore, type ProviderRecord } from "../src/lib/store.js";
import { RecordingEnqueuer } from "./helpers.js";

/**
 * Optional Gemini answer composition (ADR 0009, round 3).
 *
 * Invariants under test:
 * 1. The composer may only REWRITE the deterministic draft. Citations,
 *    the pending run id, and the fallback are owned by the service.
 * 2. What leaves the process is the question, the draft text, and
 *    citation METADATA (kind/group name/timestamp) — never message ids,
 *    JIDs, phone numbers, or the key in the prompt.
 * 3. Every failure keeps the template reply.
 *
 * All provider calls are stubbed fetch fixtures: no network, no cost.
 */

const API_KEY = "AIza-FAKE-KEY-for-tests";
const CHAT_A = "120363000000000001@g.us";
const CHAT_B = "120363000000000002@g.us";
const NOW = new Date("2026-11-16T12:00:00Z");

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
): AnswerComposerStore {
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

function draft(overrides: Partial<AssistantChatResponse> = {}): AssistantChatResponse {
  return {
    reply: 'Queued a summary for “Equipo Ventas” covering today. Follow it at /runs/run-1.',
    citations: [
      {
        kind: "run",
        groupId: randomUUID(),
        groupName: "Equipo Ventas",
        messageId: null,
        runId: "run-1",
        sentAt: null,
      },
    ],
    pendingRunId: "run-1",
    ...overrides,
  };
}

const QUESTION = "do a summary on Equipo Ventas today";

// ---- response parsing ----------------------------------------------------

describe("parseAnswerResponse", () => {
  it("joins the candidate text parts and trims", () => {
    const body = {
      candidates: [
        { content: { parts: [{ text: "Hello " }, { text: " world  " }] } },
      ],
    };
    expect(parseAnswerResponse(body)).toBe("Hello  world");
  });

  it("returns null for an empty, missing, or malformed body", () => {
    expect(parseAnswerResponse(undefined)).toBeNull();
    expect(parseAnswerResponse({})).toBeNull();
    expect(parseAnswerResponse({ candidates: [] })).toBeNull();
    expect(
      parseAnswerResponse({ candidates: [{ content: { parts: [{ text: "   " }] } }] }),
    ).toBeNull();
  });

  it("returns null for text past the published reply cap", () => {
    const exact = "x".repeat(MAX_COMPOSED_ANSWER_CHARS);
    expect(parseAnswerResponse({ candidates: [{ content: { parts: [{ text: exact }] } }] })).toBe(
      exact,
    );
    const overlong = "x".repeat(MAX_COMPOSED_ANSWER_CHARS + 1);
    expect(
      parseAnswerResponse({ candidates: [{ content: { parts: [{ text: overlong }] } }] }),
    ).toBeNull();
  });
});

// ---- provider gating -----------------------------------------------------

describe("createGeminiAnswerComposer: provider gating", () => {
  const input: AssistantAnswerComposerInput = { question: QUESTION, draft: draft() };

  it("returns null without a call for the mock provider", async () => {
    const { fetchImpl, captured } = stubFetch([
      { status: 200, body: successBody("rewritten") },
    ]);
    const composer = createGeminiAnswerComposer({
      store: storeWith(geminiConfig({ provider: "mock" })),
      fetchImpl,
    });
    expect(await composer.compose(input)).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("returns null without a call when unconfigured", async () => {
    const { fetchImpl, captured } = stubFetch([]);
    const composer = createGeminiAnswerComposer({ store: storeWith(null), fetchImpl });
    expect(await composer.compose(input)).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("returns null without a call when the key is missing or blank", async () => {
    for (const apiKey of [null, "", "   "]) {
      const { fetchImpl, captured } = stubFetch([]);
      const composer = createGeminiAnswerComposer({
        store: storeWith(geminiConfig({ apiKey })),
        fetchImpl,
      });
      expect(await composer.compose(input)).toBeNull();
      expect(captured).toHaveLength(0);
    }
  });

  it("returns null and logs a safe reason when the key is unreadable", async () => {
    const { fetchImpl, captured } = stubFetch([]);
    const { log, events } = recordingLog();
    const composer = createGeminiAnswerComposer({
      store: storeWith(async () => {
        throw new Error("decrypt failed: AIza-SECRET");
      }),
      fetchImpl,
      log,
    });
    expect(await composer.compose(input)).toBeNull();
    expect(captured).toHaveLength(0);
    expect(events).toEqual([
      { event: "assistant_answer_failed", fields: { reason: "config" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("AIza-SECRET");
  });
});

// ---- request shape and data boundary ------------------------------------

describe("createGeminiAnswerComposer: request shape", () => {
  const citationDraft = draft({
    reply: "Ana said “El lanzamiento queda confirmado”.",
    citations: [
      {
        kind: "message",
        groupId: randomUUID(),
        groupName: "Equipo Ventas",
        messageId: randomUUID(),
        runId: null,
        sentAt: "2026-11-16T09:00:00Z",
      },
    ],
    pendingRunId: null,
  });

  async function capture(overrides: Partial<ProviderRecord> = {}) {
    const { fetchImpl, captured } = stubFetch([
      { status: 200, body: successBody("Rewritten answer.") },
    ]);
    const composer = createGeminiAnswerComposer({
      store: storeWith(geminiConfig(overrides)),
      fetchImpl,
    });
    await composer.compose({ question: QUESTION, draft: citationDraft });
    const request = captured[0];
    if (request === undefined) throw new Error("no request captured");
    return request;
  }

  it("posts to the official endpoint with the saved model and key header", async () => {
    const request = await capture({ model: "models/gemini-3.5-flash-lite" });
    expect(request.url).toBe(
      `${ANSWER_API_BASE_URL}/models/gemini-3.5-flash-lite:generateContent`,
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
    expect(request.url.startsWith(ANSWER_API_BASE_URL)).toBe(true);
    expect(request.url).not.toContain("evil.example");
  });

  it("sends the fixed instruction plus a question-and-draft JSON block", async () => {
    const request = await capture();
    const body = JSON.parse(String(request.init.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: Record<string, unknown>;
      store: unknown;
    };

    expect(body.systemInstruction.parts[0]?.text).toBe(ANSWER_SYSTEM_INSTRUCTION);
    // The instruction is a constant: no user text or draft inside it.
    expect(ANSWER_SYSTEM_INSTRUCTION).not.toContain(QUESTION);
    expect(ANSWER_SYSTEM_INSTRUCTION).not.toContain("El lanzamiento");

    const userText = body.contents[0]?.parts[0]?.text ?? "";
    const json = userText
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .join("");
    expect(JSON.parse(json)).toEqual({
      question: QUESTION,
      draftReply: citationDraft.reply,
      citations: [
        {
          kind: "message",
          groupName: "Equipo Ventas",
          sentAt: "2026-11-16T09:00:00Z",
        },
      ],
    });

    expect(body.generationConfig).toMatchObject({
      temperature: ANSWER_TEMPERATURE,
      maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
    });
    expect(body.store).toBe(false);
  });

  it("never sends message ids, JIDs, phones, run ids, or the key in the prompt", async () => {
    const request = await capture();
    const serialized = `${request.url}\n${JSON.stringify(request.init.body)}`;
    const messageCitation = citationDraft.citations[0];
    expect(serialized).not.toContain(messageCitation?.messageId ?? "missing-id");
    expect(serialized).not.toContain(messageCitation?.groupId ?? "missing-group");
    expect(serialized).not.toContain(CHAT_A);
    expect(serialized).not.toContain(CHAT_B);
    expect(serialized).not.toContain("111@s.whatsapp.net");
    expect(serialized).not.toContain("run-1");
    expect(JSON.stringify(request.init.body)).not.toContain(API_KEY);
  });
});

// ---- failure handling ----------------------------------------------------

describe("createGeminiAnswerComposer: failures return null", () => {
  const input: AssistantAnswerComposerInput = { question: QUESTION, draft: draft() };

  async function run(
    fetchImpl: typeof fetch,
    log?: AssistantLogger,
    timeoutMs?: number,
  ): Promise<string | null> {
    const composer = createGeminiAnswerComposer({
      store: storeWith(geminiConfig()),
      fetchImpl,
      ...(log === undefined ? {} : { log }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return composer.compose(input);
  }

  it("returns null on a non-2xx response and logs status only", async () => {
    const { fetchImpl } = stubFetch([
      { status: 429, body: '{"error":{"message":"quota for AIza-SECRET"}}' },
    ]);
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events).toEqual([
      {
        event: "assistant_answer_failed",
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

  it("returns null on an empty candidate text", async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: successBody("   ") }]);
    const { log, events } = recordingLog();
    expect(await run(fetchImpl, log)).toBeNull();
    expect(events[0]?.fields.reason).toBe("malformed_response");
  });

  it("returns null on an over-long answer", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: successBody("x".repeat(MAX_COMPOSED_ANSWER_CHARS + 1)) },
    ]);
    expect(await run(fetchImpl)).toBeNull();
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

  it("never logs the question, draft, or key", async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: "{}" }]);
    const { log, events } = recordingLog();
    await run(fetchImpl, log);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Equipo Ventas");
    expect(serialized).not.toContain("summary");
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
  service: AssistantService;
  store: InMemoryStore;
  enqueue: RecordingEnqueuer;
  events: LoggedEvent[];
  groupA: string;
  groupB: string;
  messages: { launchA: ApiMessage; launchB: ApiMessage };
}

async function serviceFixture(
  answerComposer?: AssistantAnswerComposer,
): Promise<ServiceFixture> {
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
    // Two contacts sharing the word "Beto" make the parser ask which one
    // was meant (clarify), which must never reach the composer.
    {
      userId: "333@lid",
      name: "Beto",
      phone: "333@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
    {
      userId: "444@lid",
      name: "Beto Ruiz",
      phone: "444@s.whatsapp.net",
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
    ...(answerComposer === undefined ? {} : { answerComposer }),
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

function recordingComposer(
  handler: (input: AssistantAnswerComposerInput) => Promise<string | null>,
): { composer: AssistantAnswerComposer; calls: AssistantAnswerComposerInput[] } {
  const calls: AssistantAnswerComposerInput[] = [];
  return {
    calls,
    composer: {
      compose: async (input) => {
        calls.push(input);
        return handler(input);
      },
    },
  };
}

function chat(content: string) {
  return { messages: [{ role: "user" as const, content }] };
}

function answerLog(events: LoggedEvent[]): LoggedEvent | undefined {
  return events.find((entry) => entry.event === "assistant_answer");
}

describe("AssistantService: answer composition", () => {
  it("uses the composed text for a summary and keeps citations and the run", async () => {
    const { composer, calls } = recordingComposer(async () => "Summary queued.");
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("do a summary on Equipo Ventas today"));

    const runId = res.pendingRunId;
    expect(runId).toBeTypeOf("string");
    // The deterministic link is appended because the model dropped it.
    expect(res.reply).toBe(`Summary queued.\n\nOpen the run: /runs/${runId}`);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]).toMatchObject({ kind: "run", runId });
    expect(fixture.enqueue.enqueued).toEqual([runId]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toBe("do a summary on Equipo Ventas today");
    expect(calls[0]?.draft.citations).toHaveLength(1);
    expect(answerLog(fixture.events)?.fields).toMatchObject({
      source: "gemini",
      fallbackReason: null,
    });
    expect(answerLog(fixture.events)?.fields.durationMs).toBeTypeOf("number");
    expect(JSON.stringify(fixture.events)).not.toContain("Summary queued.");
    expect(JSON.stringify(fixture.events)).not.toContain("Equipo Ventas");
  });

  it("keeps a run link the model already preserved", async () => {
    const { composer } = recordingComposer(
      async (input) => `All set: /runs/${input.draft.pendingRunId}.`,
    );
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.reply).toBe(`All set: /runs/${res.pendingRunId}.`);
    expect(res.reply.match(/\/runs\//g)).toHaveLength(1);
  });

  it("uses the composed text for contact_groups and keeps the citations", async () => {
    const { composer, calls } = recordingComposer(
      async () => "Ana is in two monitored groups.",
    );
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(
      chat("which groups does Ana participate in?"),
    );
    expect(res.reply).toBe("Ana is in two monitored groups.");
    expect(res.citations.map((citation) => citation.groupId).sort()).toEqual(
      [fixture.groupA, fixture.groupB].sort(),
    );
    expect(res.pendingRunId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(answerLog(fixture.events)?.fields.source).toBe("gemini");
  });

  it("uses the composed text for search_messages and keeps the citations", async () => {
    const { composer, calls } = recordingComposer(
      async () => "Ana mentioned the launch twice.",
    );
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(
      chat("when did Ana say something about lanzamiento"),
    );
    expect(res.reply).toBe("Ana mentioned the launch twice.");
    expect(res.citations).toHaveLength(2);
    expect(res.citations.map((citation) => citation.messageId)).toEqual(
      expect.arrayContaining([
        fixture.messages.launchA.id,
        fixture.messages.launchB.id,
      ]),
    );
    expect(calls).toHaveLength(1);
  });

  it("never composes help replies", async () => {
    const { composer, calls } = recordingComposer(async () => "rewritten help");
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("hola"));
    expect(res.reply).toContain("I can help with three things");
    expect(calls).toHaveLength(0);
    expect(answerLog(fixture.events)).toBeUndefined();
  });

  it("never composes clarifications and keeps the candidate names", async () => {
    const { composer, calls } = recordingComposer(async () => "rewritten clarify");
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(
      chat("which groups does Beto participate in?"),
    );
    expect(res.reply).toContain("More than one contact matches your message");
    expect(res.reply).toContain("- Beto");
    expect(res.reply).toContain("- Beto Ruiz");
    expect(calls).toHaveLength(0);
    expect(answerLog(fixture.events)).toBeUndefined();
  });

  it("keeps the deterministic reply when the composer returns null", async () => {
    const { composer, calls } = recordingComposer(async () => null);
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.reply).toContain('Queued a summary for “Soporte”');
    expect(res.reply).toContain(`/runs/${res.pendingRunId}`);
    expect(calls).toHaveLength(1);
    expect(answerLog(fixture.events)?.fields).toMatchObject({
      source: "template",
      fallbackReason: "unavailable",
    });
  });

  it("keeps the deterministic reply when the composer returns blank text", async () => {
    const { composer } = recordingComposer(async () => "   ");
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("which groups does Ana participate in?"));
    expect(res.reply).toContain("Ana participates in 2 monitored groups");
    expect(answerLog(fixture.events)?.fields.fallbackReason).toBe("empty");
  });

  it("keeps the deterministic reply when the composer throws, logging only the type", async () => {
    const { composer } = recordingComposer(async () => {
      throw new TypeError("boom AIza-SECRET");
    });
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.reply).toContain("Queued a summary for");
    expect(answerLog(fixture.events)?.fields).toMatchObject({
      source: "template",
      fallbackReason: "TypeError",
    });
    expect(JSON.stringify(fixture.events)).not.toContain("AIza-SECRET");
  });

  it("keeps the deterministic reply when the composed text is over-long", async () => {
    const { composer } = recordingComposer(async () => "x".repeat(8001));
    const fixture = await serviceFixture(composer);
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.reply).toContain("Queued a summary for");
    expect(answerLog(fixture.events)?.fields.fallbackReason).toBe("invalid");
  });

  it("does not compose when no composer is configured", async () => {
    const fixture = await serviceFixture();
    const res = await fixture.service.chat(chat("do a summary on Soporte"));
    expect(res.reply).toContain("Queued a summary for");
    expect(answerLog(fixture.events)).toBeUndefined();
  });
});
