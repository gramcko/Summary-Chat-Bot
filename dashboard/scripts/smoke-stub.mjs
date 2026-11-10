/**
 * Contract test double for the dashboard smoke check.
 *
 * NOT a backend: it implements only the endpoints the dashboard calls, with
 * the shapes and status codes from `docs/api.md` / `@summarly/contracts`, so
 * the dashboard's proxy, cookie handling, and error mapping can be exercised
 * without PostgreSQL, Redis, WhatsApp, or an AI provider.
 *
 * Never import this from application code.
 */
import { createServer } from "node:http";

export const SESSION_COOKIE = "summarly_session";
/** Value placed in the session cookie; the smoke check asserts it never leaks. */
export const SESSION_VALUE = "smoke-session-token-do-not-render";

const ADMIN_PASSWORD = "correct-horse-battery-123";

const GROUP_FAMILY_ID = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";
const GROUP_PROJECT_ID = "11111111-2222-4333-8444-555555555555";

const RUN_COMPLETED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUN_PENDING_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const RUN_FAILED_ID = "cccccccc-dddd-4eee-8fff-000000000000";

function createState() {
  return {
    needsSetup: true,
    provider: null,
    authed: false,
    /** Raw request log, used by the smoke check to inspect forwarded headers. */
    requests: [],
    connection: {
      state: "connected",
      since: "2026-10-29T06:00:00.000Z",
      lastMessageAt: "2026-10-29T11:58:00.000Z",
      linking: null,
      check: null,
    },
    groups: [
      {
        id: GROUP_FAMILY_ID,
        name: "Family Chat",
        monitored: true,
        timezone: "Europe/Madrid",
        summaryTime: "08:30",
        // Read-only field added to Group by the parallel contract change; the
        // dashboard ignores it, and the check confirms extra fields are safe.
        chatId: "120363000000000001@g.us",
        // System-managed history-import state (ADR 0007); null = never asked.
        historyImport: null,
      },
      {
        id: GROUP_PROJECT_ID,
        name: "Project Team",
        monitored: false,
        timezone: "America/Bogota",
        summaryTime: null,
        chatId: null,
        historyImport: null,
      },
    ],
    runs: [
      {
        id: RUN_COMPLETED_ID,
        groupId: GROUP_FAMILY_ID,
        kind: "manual",
        status: "completed",
        interval: {
          start: "2026-10-28T07:00:00.000Z",
          end: "2026-10-29T07:00:00.000Z",
          timezone: "Europe/Madrid",
        },
        attempts: 1,
        createdAt: "2026-10-29T07:05:00.000Z",
        updatedAt: "2026-10-29T07:06:00.000Z",
        instructions: "Focus on decisions and deadlines; ignore small talk.",
        error: null,
      },
      {
        id: RUN_PENDING_ID,
        groupId: GROUP_PROJECT_ID,
        kind: "manual",
        status: "pending",
        interval: {
          start: "2026-10-29T05:00:00.000Z",
          end: "2026-10-29T12:00:00.000Z",
          timezone: "America/Bogota",
        },
        attempts: 0,
        createdAt: "2026-10-29T12:01:00.000Z",
        updatedAt: "2026-10-29T12:01:00.000Z",
        instructions: null,
        error: null,
      },
      {
        id: RUN_FAILED_ID,
        groupId: GROUP_FAMILY_ID,
        kind: "scheduled",
        status: "failed",
        interval: {
          start: "2026-10-27T22:00:00.000Z",
          end: "2026-10-28T22:00:00.000Z",
          timezone: "Europe/Madrid",
        },
        attempts: 3,
        createdAt: "2026-10-28T22:00:30.000Z",
        updatedAt: "2026-10-28T22:03:00.000Z",
        instructions: null,
        error: {
          code: "provider_timeout",
          message: "The AI provider did not respond.",
        },
      },
    ],
  };
}

const SUMMARY = {
  id: "dddddddd-eeee-4fff-8000-111111111111",
  runId: RUN_COMPLETED_ID,
  provider: "openai",
  model: "gpt-4o-mini",
  result: {
    overview: "The group planned the weekend trip and agreed on a meeting time.",
    keyDiscussions: ["Trip logistics", "Budget for the rental car"],
    confirmedDecisions: [
      {
        text: "Meet at the station at 09:00 on Saturday.",
        sourceRefs: [
          {
            messageId: "eeeeeeee-ffff-4000-8111-222222222222",
            sentAt: "2026-10-28T18:12:00.000Z",
          },
        ],
      },
    ],
    proposals: [{ text: "Rent a car instead of taking the train.", sourceRefs: [] }],
    unresolvedQuestions: [{ text: "Who is bringing the tickets?", sourceRefs: [] }],
    tasks: [
      {
        text: "Book the rental car",
        owner: "Ana",
        dueDate: "2026-10-30",
        sourceRefs: [],
      },
      {
        text: "Confirm the meeting point",
        owner: null,
        dueDate: null,
        sourceRefs: [],
      },
    ],
    links: [{ url: "https://example.com/trip", description: "Trip notes" }],
    aiGenerated: true,
  },
  createdAt: "2026-10-29T07:06:00.000Z",
};

const FAMILY_CHAT_ID = "120363000000000001@g.us";

/** Best-effort roster snapshot (ADR 0008). */
const GROUP_MEMBERS = [
  {
    userId: "34600000001@s.whatsapp.net",
    name: "Ana",
    isAdmin: true,
    active: true,
    updatedAt: "2026-11-03T09:00:00.000Z",
  },
  {
    userId: "34600000002@s.whatsapp.net",
    name: "Luis",
    isAdmin: false,
    active: true,
    updatedAt: "2026-11-03T09:00:00.000Z",
  },
  {
    userId: "34600000003@s.whatsapp.net",
    name: null,
    isAdmin: false,
    active: false,
    updatedAt: "2026-10-30T18:00:00.000Z",
  },
];

/** Captured messages, newest first (the order the API serves). */
const GROUP_MESSAGES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    chatId: FAMILY_CHAT_ID,
    sentAt: "2026-11-04T17:30:00.000Z",
    senderId: "34600000002@s.whatsapp.net",
    senderName: "Luis",
    body: "I'll bring the tickets on Saturday.",
    messageType: "text",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    chatId: FAMILY_CHAT_ID,
    sentAt: "2026-11-04T17:25:00.000Z",
    senderId: "34600000001@s.whatsapp.net",
    senderName: "Ana",
    body: "The meeting point is the main station entrance.",
    messageType: "text",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    chatId: FAMILY_CHAT_ID,
    sentAt: "2026-11-03T10:00:00.000Z",
    senderId: "34600000002@s.whatsapp.net",
    senderName: "Luis",
    body: "https://example.com/trip",
    messageType: "link",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    chatId: FAMILY_CHAT_ID,
    sentAt: "2026-11-02T08:00:00.000Z",
    senderId: "34600000001@s.whatsapp.net",
    senderName: "Ana",
    body: "",
    messageType: "other",
  },
];

/** Past summaries of the group: `Summary` plus the run interval. */
const GROUP_SUMMARIES = [
  {
    ...SUMMARY,
    id: "55555555-5555-4555-8555-555555555555",
    interval: {
      start: "2026-10-28T07:00:00.000Z",
      end: "2026-10-29T07:00:00.000Z",
      timezone: "Europe/Madrid",
    },
  },
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimeZone(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  sendJson(
    res,
    status,
    details === undefined
      ? { error: { code, message } }
      : { error: { code, message, details } },
  );
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (data.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

function hasSession(req, state) {
  return (
    state.authed &&
    String(req.headers.cookie ?? "").includes(`${SESSION_COOKIE}=${SESSION_VALUE}`)
  );
}

async function handle(req, res, state) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Recorded before any validation so the smoke check can assert exactly which
  // headers reached the backend (never logged or returned by the stub).
  state.requests.push({
    method,
    path: path + url.search,
    headers: { ...req.headers },
  });

  const body = method === "GET" ? undefined : await readJson(req);

  // --- Public -----------------------------------------------------------
  if (path === "/api/setup/status" && method === "GET") {
    return sendJson(res, 200, { needsSetup: state.needsSetup });
  }

  if (path === "/api/setup" && method === "POST") {
    if (!state.needsSetup) {
      return sendError(res, 409, "conflict", "Setup has already been completed.");
    }
    if (!isRecord(body) || typeof body.password !== "string") {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        { path: "password", message: "Required" },
      ]);
    }
    if (body.password.length < 12) {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        {
          path: "password",
          message: "Too small: expected string to have >=12 characters",
        },
      ]);
    }
    state.needsSetup = false;
    return sendJson(res, 201, {
      recoveryCodes: Array.from(
        { length: 10 },
        (_unused, index) => `smoke-${index}-code-a1b2-c3d4`,
      ),
    });
  }

  if (path === "/api/auth/login" && method === "POST") {
    if (!isRecord(body) || body.password !== ADMIN_PASSWORD) {
      return sendError(res, 401, "unauthorized", "Invalid password.");
    }
    state.authed = true;
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Strict`,
    });
  }

  if (path === "/api/auth/recover" && method === "POST") {
    return sendJson(res, 200, { ok: true });
  }

  // --- Session required -------------------------------------------------
  if (!hasSession(req, state)) {
    return sendError(res, 401, "unauthorized", "Authentication required.");
  }

  if (path === "/api/auth/logout" && method === "POST") {
    state.authed = false;
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
    });
  }

  if (path === "/api/connection" && method === "GET") {
    return sendJson(res, 200, state.connection);
  }

  /**
   * Idempotent unlink request (ADR 0008): the first call moves the session to
   * "connecting" and publishes a pairing ticket; repeats keep it.
   */
  if (path === "/api/connection/logout" && method === "POST") {
    if (state.connection.state !== "connecting") {
      state.connection = {
        state: "connecting",
        since: new Date().toISOString(),
        lastMessageAt: state.connection.lastMessageAt,
        linking: {
          kind: "qr",
          qr: "2@smoke-pairing-ticket-not-a-real-code,smoke",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        check: null,
      };
    }
    return sendJson(res, 202, { ok: true });
  }

  if (path === "/api/connection/test" && method === "POST") {
    state.connection = {
      ...state.connection,
      check: {
        status: "pending",
        requestedAt: new Date().toISOString(),
        checkedAt: null,
        latencyMs: null,
        error: null,
      },
    };
    return sendJson(res, 202, { ok: true });
  }

  if (path === "/api/groups" && method === "GET") {
    return sendJson(res, 200, state.groups);
  }

  const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(path);
  if (groupMatch && method === "GET") {
    const group = state.groups.find((candidate) => candidate.id === groupMatch[1]);
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }
    return sendJson(res, 200, group);
  }

  const membersMatch = /^\/api\/groups\/([^/]+)\/members$/.exec(path);
  if (membersMatch && method === "GET") {
    const group = state.groups.find(
      (candidate) => candidate.id === membersMatch[1],
    );
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }
    // Member rosters are only served for monitored groups (privacy boundary).
    if (!group.monitored) {
      return sendError(
        res,
        409,
        "conflict",
        "Group must be monitored before viewing members.",
      );
    }
    // No discovered chat yet: an empty roster, not an error.
    return sendJson(res, 200, group.chatId === null ? [] : GROUP_MEMBERS);
  }

  const messagesMatch = /^\/api\/groups\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch && method === "GET") {
    const group = state.groups.find(
      (candidate) => candidate.id === messagesMatch[1],
    );
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }

    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const fromMs = from === undefined ? undefined : Date.parse(from);
    const toMs = to === undefined ? undefined : Date.parse(to);
    if (
      (fromMs !== undefined && !Number.isFinite(fromMs)) ||
      (toMs !== undefined && !Number.isFinite(toMs)) ||
      (fromMs !== undefined && toMs !== undefined && fromMs >= toMs)
    ) {
      return sendError(
        res,
        400,
        "validation_error",
        "Invalid range: `from` must be an instant before `to`.",
      );
    }

    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.trunc(rawLimit)))
      : 50;

    const filtered =
      group.chatId === null
        ? []
        : GROUP_MESSAGES.filter((message) => {
            const sentAt = Date.parse(message.sentAt);
            if (fromMs !== undefined && sentAt < fromMs) return false;
            if (toMs !== undefined && sentAt >= toMs) return false;
            return true;
          });

    let start = 0;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      const match = /^cursor-(\d+)$/.exec(cursor);
      if (match === null) {
        return sendError(res, 400, "validation_error", "Invalid cursor.");
      }
      start = Number(match[1]);
    }

    const items = filtered.slice(start, start + limit);
    const next = start + limit < filtered.length ? `cursor-${start + limit}` : null;
    return sendJson(res, 200, { items, nextCursor: next });
  }

  const summariesMatch = /^\/api\/groups\/([^/]+)\/summaries$/.exec(path);
  if (summariesMatch && method === "GET") {
    const group = state.groups.find(
      (candidate) => candidate.id === summariesMatch[1],
    );
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }
    return sendJson(res, 200, group.id === GROUP_FAMILY_ID ? GROUP_SUMMARIES : []);
  }

  if (groupMatch && method === "PATCH") {
    const group = state.groups.find((candidate) => candidate.id === groupMatch[1]);
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }
    if (!isRecord(body)) {
      return sendError(res, 400, "validation_error", "Request validation failed.");
    }
    if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        { path: "timezone", message: "must be a valid IANA time zone name" },
      ]);
    }
    if (body.summaryTime !== undefined && body.summaryTime !== null) {
      if (
        typeof body.summaryTime !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.summaryTime)
      ) {
        return sendError(res, 400, "validation_error", "Request validation failed.", [
          { path: "summaryTime", message: "must be HH:mm in 24-hour format" },
        ]);
      }
    }
    if (typeof body.monitored === "boolean") group.monitored = body.monitored;
    if (typeof body.timezone === "string") group.timezone = body.timezone;
    if (body.summaryTime === null || typeof body.summaryTime === "string") {
      group.summaryTime = body.summaryTime;
    }
    // `historyImport` is system-managed: PATCH never alters it (ADR 0007).
    return sendJson(res, 200, group);
  }

  const historyImportMatch = /^\/api\/groups\/([^/]+)\/history-import$/.exec(path);
  if (historyImportMatch && method === "POST") {
    const group = state.groups.find(
      (candidate) => candidate.id === historyImportMatch[1],
    );
    if (group === undefined) {
      return sendError(res, 404, "not_found", "Group not found.");
    }
    if (!group.monitored) {
      return sendError(
        res,
        409,
        "conflict",
        "Group must be monitored before importing history.",
      );
    }
    const current = group.historyImport?.status;
    const accepted = current !== "pending" && current !== "running";
    if (accepted) {
      // A new request resets the progress fields (ADR 0007).
      group.historyImport = {
        status: "pending",
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        importedCount: 0,
        error: null,
      };
    }
    return sendJson(res, accepted ? 202 : 200, group);
  }

  if (path === "/api/summary-runs" && method === "GET") {
    return sendJson(res, 200, { items: state.runs, nextCursor: null });
  }

  if (path === "/api/summary-runs" && method === "POST") {
    if (!isRecord(body) || !isRecord(body.interval)) {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        { path: "interval", message: "Required" },
      ]);
    }
    if (!isValidTimeZone(body.interval.timezone)) {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        {
          path: "interval.timezone",
          message: "must be a valid IANA time zone name",
        },
      ]);
    }
    if (
      !(Date.parse(String(body.interval.end)) > Date.parse(String(body.interval.start)))
    ) {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        {
          path: "interval.end",
          message:
            "end must be after start (half-open interval: start inclusive, end exclusive)",
        },
      ]);
    }
    if (body.instructions !== undefined) {
      if (
        typeof body.instructions !== "string" ||
        body.instructions.trim().length === 0 ||
        body.instructions.trim().length > 2000
      ) {
        return sendError(res, 400, "validation_error", "Request validation failed.", [
          {
            path: "instructions",
            message: "String must contain at most 2000 character(s)",
          },
        ]);
      }
    }
    const existing = state.runs.find(
      (run) =>
        run.groupId === body.groupId &&
        run.interval.start === body.interval.start &&
        run.interval.end === body.interval.end,
    );
    if (existing !== undefined) return sendJson(res, 200, existing);

    const created = {
      id: "99999999-8888-4777-8666-555555555555",
      groupId: body.groupId,
      kind: "manual",
      status: "pending",
      interval: body.interval,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      instructions:
        typeof body.instructions === "string" ? body.instructions.trim() : null,
      error: null,
    };
    state.runs.unshift(created);
    return sendJson(res, 201, created);
  }

  const runMatch = /^\/api\/summary-runs\/([^/]+)$/.exec(path);
  if (runMatch && method === "GET") {
    const run = state.runs.find((candidate) => candidate.id === runMatch[1]);
    if (run === undefined) {
      return sendError(res, 404, "not_found", "Summary run not found.");
    }
    return sendJson(res, 200, run);
  }

  const retryMatch = /^\/api\/summary-runs\/([^/]+)\/retry$/.exec(path);
  if (retryMatch && method === "POST") {
    const run = state.runs.find((candidate) => candidate.id === retryMatch[1]);
    if (run === undefined) {
      return sendError(res, 404, "not_found", "Summary run not found.");
    }
    if (run.status === "completed") {
      return sendError(
        res,
        409,
        "conflict",
        "Completed runs cannot be retried; regeneration is not supported yet.",
      );
    }
    if (run.status === "pending" || run.status === "processing") {
      return sendJson(res, 200, run);
    }
    run.status = "pending";
    run.error = null;
    run.updatedAt = new Date().toISOString();
    return sendJson(res, 200, run);
  }

  const summaryMatch = /^\/api\/summary-runs\/([^/]+)\/summary$/.exec(path);
  if (summaryMatch && method === "GET") {
    if (summaryMatch[1] !== RUN_COMPLETED_ID) {
      return sendError(res, 404, "not_found", "Summary not found.");
    }
    return sendJson(res, 200, SUMMARY);
  }

  if (path === "/api/settings/ai-provider" && method === "GET") {
    if (state.provider === null) {
      return sendError(res, 404, "not_found", "AI provider is not configured.");
    }
    return sendJson(res, 200, state.provider);
  }

  if (path === "/api/settings/ai-provider" && method === "PUT") {
    if (!isRecord(body) || typeof body.provider !== "string" || typeof body.model !== "string") {
      return sendError(res, 400, "validation_error", "Request validation failed.", [
        { path: "provider", message: "Required" },
      ]);
    }
    const hadKey = state.provider?.hasApiKey ?? false;
    const hasApiKey =
      body.apiKey === null ? false : body.apiKey === undefined ? hadKey : true;
    // The key itself is write-only: it is never echoed in the response.
    state.provider = {
      provider: body.provider,
      model: body.model,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
      hasApiKey,
    };
    return sendJson(res, 200, state.provider);
  }

  return sendError(res, 404, "not_found", "Route not found.");
}

/**
 * Starts the test double on 127.0.0.1 and resolves with its base URL.
 */
export function startStubBackend({ port = 3999 } = {}) {
  const state = createState();
  const server = createServer((req, res) => {
    handle(req, res, state).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, "internal", "Stub failure.");
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        baseUrl: `http://127.0.0.1:${boundPort}`,
        /** Request log (method, path, raw headers) for header-assertion checks. */
        getRequests: () =>
          state.requests.map((entry) => ({
            method: entry.method,
            path: entry.path,
            headers: { ...entry.headers },
          })),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
