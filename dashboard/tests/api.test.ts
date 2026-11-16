import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ApiError,
  api,
  isNetworkError,
  setBrowserLocationForTests,
  toApiError,
} from "../src/lib/api.ts";

/**
 * Unit tests for the API layer's contract handling:
 * error-envelope parsing, network/timeout mapping, the 401 redirect rule,
 * `createRun`'s 201-vs-200 `created` mapping, and the `404 → null` lookups.
 *
 * `fetch` is stubbed via `globalThis` and the redirect target is injected, so
 * no DOM or running backend is needed.
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let assignedPaths: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

function firstCall(): FetchCall {
  const [call] = calls;
  assert.ok(call !== undefined, "expected fetch to have been called");
  return call;
}

function lastCall(): FetchCall {
  const call = calls[calls.length - 1];
  assert.ok(call !== undefined, "expected fetch to have been called");
  return call;
}

async function rejectionOf<T>(promise: Promise<T>): Promise<ApiError> {
  try {
    await promise;
  } catch (cause) {
    assert.ok(cause instanceof ApiError, "expected an ApiError instance");
    return cause;
  }
  assert.fail("expected the request to reject");
}

beforeEach(() => {
  calls = [];
  assignedPaths = [];
  setBrowserLocationForTests({
    pathname: "/runs",
    assign: (path: string) => {
      assignedPaths.push(path);
    },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setBrowserLocationForTests(null);
});

test("parses the error envelope, including details[].path", async () => {
  stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: "validation_error",
          message: "Request validation failed.",
          details: [
            { path: "interval.start", message: "Invalid start." },
            { path: "timezone", message: "must be a valid IANA time zone name" },
          ],
        },
      },
      400,
    ),
  );

  const error = await rejectionOf(api.groups());

  assert.equal(error.status, 400);
  assert.equal(error.code, "validation_error");
  assert.equal(error.message, "Request validation failed.");
  assert.deepEqual(error.details, [
    { path: "interval.start", message: "Invalid start." },
    { path: "timezone", message: "must be a valid IANA time zone name" },
  ]);
});

test("keeps server codes and messages without details", async () => {
  stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: "conflict",
          message: "Completed runs cannot be retried.",
        },
      },
      409,
    ),
  );

  const error = await rejectionOf(api.retryRun("run-1"));

  assert.equal(error.status, 409);
  assert.equal(error.code, "conflict");
  assert.equal(error.message, "Completed runs cannot be retried.");
  assert.deepEqual(error.details, []);
});

test("keeps the rate_limited code for 429 responses", async () => {
  stubFetch(() =>
    jsonResponse(
      { error: { code: "rate_limited", message: "Too many failed attempts." } },
      429,
    ),
  );

  const error = await rejectionOf(api.login({ password: "wrong" }));

  assert.equal(error.code, "rate_limited");
  assert.equal(error.status, 429);
});

test("falls back to a status-derived code and message for foreign codes", async () => {
  stubFetch(() =>
    jsonResponse({ error: { code: "teapot", message: "   " } }, 400),
  );

  const error = await rejectionOf(api.groups());

  assert.equal(error.code, "validation_error");
  assert.equal(error.message, "The request was rejected. Check the highlighted fields.");
});

test("ignores malformed detail entries", async () => {
  stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: "validation_error",
          message: "Request validation failed.",
          details: [
            { path: "password", message: "Too short." },
            null,
            "nope",
            { path: 42, message: "bad path" },
            { message: "missing path" },
          ],
        },
      },
      400,
    ),
  );

  const error = await rejectionOf(api.groups());

  assert.deepEqual(error.details, [
    { path: "password", message: "Too short." },
  ]);
});

test("maps a non-envelope HTML error response", async () => {
  stubFetch(
    () =>
      new Response("<html><body>Internal Server Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
  );

  const error = await rejectionOf(api.connection());

  assert.equal(error.status, 500);
  assert.equal(error.code, "internal");
  assert.match(error.message, /did not return a valid API response/i);
});

test("maps an empty error body to the status-derived fallback", async () => {
  stubFetch(() => new Response("", { status: 404 }));

  const error = await rejectionOf(api.run("missing"));

  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
  assert.equal(error.message, "The requested resource was not found.");
});

test("maps a rejected fetch to a network error", async () => {
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("fetch failed"))) as typeof fetch;

  const error = await rejectionOf(api.groups());

  assert.equal(error.code, "network");
  assert.equal(error.status, null);
  assert.match(error.message, /Cannot reach the Summarly backend/);
  assert.equal(isNetworkError(error), true);
});

test("maps timeout and abort rejections to a network error", async () => {
  globalThis.fetch = (() =>
    Promise.reject(
      new DOMException("The operation timed out.", "TimeoutError"),
    )) as typeof fetch;

  const timeoutError = await rejectionOf(api.groups());
  assert.equal(timeoutError.code, "network");
  assert.match(timeoutError.message, /did not respond in time/);

  globalThis.fetch = (() =>
    Promise.reject(new DOMException("Aborted", "AbortError"))) as typeof fetch;

  const abortError = await rejectionOf(api.groups());
  assert.equal(abortError.code, "network");
  assert.match(abortError.message, /did not respond in time/);
});

test("requests same-origin /api paths with credentials and JSON headers", async () => {
  stubFetch(() => jsonResponse([]));

  await api.groups();

  const call = firstCall();
  assert.equal(call.url, "/api/groups");
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.credentials, "include");
  assert.equal(call.init?.cache, "no-store");
  assert.deepEqual(call.init?.headers, { accept: "application/json" });
  assert.equal(call.init?.body, undefined);
  assert.ok(call.init?.signal instanceof AbortSignal);
});

test("serializes request bodies as JSON", async () => {
  stubFetch(() => jsonResponse({ id: "run-1", status: "pending" }, 201));

  const interval = {
    start: "2026-10-20T00:00:00.000Z",
    end: "2026-10-21T00:00:00.000Z",
    timezone: "Europe/Madrid",
  };
  await api.createRun({ groupId: "group-1", interval });

  const call = firstCall();
  assert.equal(call.url, "/api/summary-runs");
  assert.equal(call.init?.method, "POST");
  assert.deepEqual(call.init?.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    groupId: "group-1",
    interval,
  });
});

test("createRun reports created=true only for 201", async () => {
  const run = { id: "run-1", status: "pending" };

  stubFetch(() => jsonResponse(run, 201));
  const created = await api.createRun({
    groupId: "group-1",
    interval: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-10-21T00:00:00.000Z",
      timezone: "UTC",
    },
  });
  assert.equal(created.created, true);
  assert.equal(created.run.id, "run-1");

  stubFetch(() => jsonResponse(run, 200));
  const found = await api.createRun({
    groupId: "group-1",
    interval: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-10-21T00:00:00.000Z",
      timezone: "UTC",
    },
  });
  assert.equal(found.created, false);
  assert.equal(found.run.id, "run-1");
});

test("redirects to /login for a 401 outside the auth screens", async () => {
  stubFetch(() =>
    jsonResponse(
      { error: { code: "unauthorized", message: "Authentication required." } },
      401,
    ),
  );

  await rejectionOf(api.groups());

  assert.deepEqual(assignedPaths, ["/login"]);
});

test("does not redirect for a 401 on the auth screens", async () => {
  stubFetch(() =>
    jsonResponse(
      { error: { code: "unauthorized", message: "Authentication required." } },
      401,
    ),
  );

  for (const pathname of ["/login", "/recover", "/setup", "/setup/finish"]) {
    setBrowserLocationForTests({
      pathname,
      assign: (path: string) => {
        assignedPaths.push(path);
      },
    });
    await rejectionOf(api.groups());
  }

  assert.deepEqual(assignedPaths, []);
});

test("does not redirect for non-401 failures", async () => {
  for (const status of [400, 403, 404, 409, 429, 500]) {
    stubFetch(() =>
      jsonResponse(
        { error: { code: status === 403 ? "forbidden" : "internal", message: "nope" } },
        status,
      ),
    );
    await rejectionOf(api.groups());
  }

  assert.deepEqual(assignedPaths, []);
});

test("tolerates a missing browser location", async () => {
  setBrowserLocationForTests(null);
  stubFetch(() =>
    jsonResponse(
      { error: { code: "unauthorized", message: "Authentication required." } },
      401,
    ),
  );

  const error = await rejectionOf(api.groups());

  assert.equal(error.code, "unauthorized");
  assert.deepEqual(assignedPaths, []);
});

test("maps a 404 to null for the run summary lookup", async () => {
  stubFetch(() =>
    jsonResponse({ error: { code: "not_found", message: "Summary not found." } }, 404),
  );

  const summary = await api.runSummary("run-1");

  assert.equal(summary, null);
  assert.equal(firstCall().url, "/api/summary-runs/run-1/summary");
});

test("returns the summary when the run-scoped lookup succeeds", async () => {
  stubFetch(() => jsonResponse({ id: "summary-1", runId: "run-1" }));

  const summary = await api.runSummary("run-1");

  assert.equal(summary?.id, "summary-1");
});

test("maps a 404 to null for the provider config lookup", async () => {
  stubFetch(() =>
    jsonResponse(
      { error: { code: "not_found", message: "AI provider is not configured." } },
      404,
    ),
  );

  const config = await api.providerConfig();

  assert.equal(config, null);
  assert.equal(firstCall().url, "/api/settings/ai-provider");
});

test("returns the provider config when it exists", async () => {
  stubFetch(() =>
    jsonResponse({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: null,
      hasApiKey: true,
    }),
  );

  const config = await api.providerConfig();

  assert.deepEqual(config, {
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: null,
    hasApiKey: true,
  });
});

test("rethrows non-404 failures from the optional lookups", async () => {
  stubFetch(() => new Response("<html>boom</html>", { status: 500 }));

  const error = await rejectionOf(api.runSummary("run-1"));
  assert.equal(error.code, "internal");

  stubFetch(() =>
    jsonResponse(
      { error: { code: "unauthorized", message: "Authentication required." } },
      401,
    ),
  );
  const unauthorized = await rejectionOf(api.providerConfig());
  assert.equal(unauthorized.code, "unauthorized");
  assert.deepEqual(assignedPaths, ["/login"]);
});

test("encodes identifiers in request paths", async () => {
  stubFetch(() => jsonResponse({}));

  await api.run("run/../admin");
  assert.equal(firstCall().url, "/api/summary-runs/run%2F..%2Fadmin");

  await api.updateGroup("group 1", { monitored: true });
  assert.equal(lastCall().url, "/api/groups/group%201");
});

test("requestRosterSync posts to the group roster-sync route", async () => {
  stubFetch(() => jsonResponse({ ok: true }, 202));

  const result = await api.requestRosterSync("group 1");
  assert.deepEqual(result, { ok: true });

  const call = firstCall();
  assert.equal(call.url, "/api/groups/group%201/roster-sync");
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.body, undefined);
  assert.equal(call.init?.credentials, "include");
});

test("toApiError normalizes unknown failures and passes ApiError through", () => {
  const original = new ApiError({
    status: 400,
    code: "validation_error",
    message: "bad",
  });
  assert.equal(toApiError(original), original);

  const generic = toApiError(new Error("boom"));
  assert.equal(generic.code, "internal");
  assert.equal(generic.message, "boom");

  const unknown = toApiError("just a string");
  assert.equal(unknown.code, "internal");
  assert.equal(unknown.message, "Unexpected error. Please try again.");

  assert.equal(isNetworkError(original), false);
  assert.equal(isNetworkError(new Error("nope")), false);
});
