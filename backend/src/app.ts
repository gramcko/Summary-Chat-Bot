import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import type { ErrorCode } from "@summarly/contracts";
import { apiError, ERROR_STATUS, HttpError, zodDetails } from "./lib/errors.js";
import type { SummaryEnqueuer } from "./lib/enqueue.js";
import type { Store } from "./lib/store.js";
import {
  registerAuthRoutes,
  registerSessionRoutes,
  requireAuth,
} from "./routes/auth.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import type { AssistantPlanner } from "./lib/assistant/planner.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerConnectionRoutes } from "./routes/connection.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSummaryRoutes } from "./routes/summaries.js";

export interface BuildAppOptions {
  store: Store;
  /**
   * Queue producer for `generate-summary` jobs. Injected so routes stay
   * testable without Redis (tests pass an in-memory enqueuer); the real
   * implementation is createRedisSummaryEnqueuer (lib/enqueue.ts).
   */
  enqueue: SummaryEnqueuer;
  cookieSecure?: boolean;
  logger?: boolean;
  /**
   * Trusted reverse proxies (IPs/CIDRs) whose X-Forwarded-For header is
   * honored when deriving the client IP (rate limiting). Unset = direct
   * connections only; X-Forwarded-For is then ignored, so a client
   * cannot spoof its way out of (or into) a lockout bucket.
   */
  trustProxy?: string[];
  /**
   * Assistant chat rate limit (per IP). Defaults to 20 requests per
   * minute; tests lower it to exercise the 429 path without 21 calls.
   */
  assistantRateLimit?: { limit?: number; windowMs?: number };
  /**
   * Test seam: replace the assistant planner. The default is the Gemini
   * classifier, which no-ops (deterministic parser fallback) unless the
   * saved provider is Gemini with a readable key.
   */
  assistantPlanner?: AssistantPlanner;
}

function codeForStatus(status: number): ErrorCode {
  for (const code of Object.keys(ERROR_STATUS) as ErrorCode[]) {
    if (ERROR_STATUS[code] === status) return code;
  }
  // Unknown 4xx statuses (payload too large, unsupported media type, ...)
  // are request problems; reserve "internal" for the 5xx class.
  return status >= 400 && status < 500 ? "validation_error" : "internal";
}

function statusCodeOf(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy,
  });
  await app.register(cookie);

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      if (error.headers !== undefined) reply.headers(error.headers);
      return reply
        .status(error.statusCode)
        .send(apiError(error.code, error.message, error.details));
    }
    if (error instanceof z.ZodError) {
      return reply
        .status(400)
        .send(apiError("validation_error", "Request validation failed.", zodDetails(error)));
    }
    const status = statusCodeOf(error) ?? 500;
    const safeStatus = status >= 400 && status < 500 ? status : 500;
    if (safeStatus >= 500) {
      request.log.error({ err: error }, "unhandled error");
    }
    const message =
      safeStatus < 500 && error instanceof Error
        ? error.message
        : "Internal server error.";
    return reply.status(safeStatus).send(apiError(codeForStatus(safeStatus), message));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(apiError("not_found", "Route not found.")),
  );

  // Security (fix round A, audit M-4): API responses are user-specific
  // and may carry a live pairing ticket (ConnectionStatus.linking) —
  // never cache them anywhere along the chain, and make any cache vary
  // on the session cookie. Scoped to /api/* (the audit's minimum is
  // GET /api/connection; the whole API surface gets the same rule).
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url === "/api" || request.url.startsWith("/api/")) {
      void reply.header("Cache-Control", "no-store, private");
      void reply.header("Vary", "Cookie");
    }
    return payload;
  });

  // Public routes: health, first-run setup, login, and recovery.
  registerHealthRoutes(app);
  registerSetupRoutes(app, options.store);
  registerAuthRoutes(app, options.store, {
    cookieSecure: options.cookieSecure ?? false,
  });

  // Protected routes: everything that reads or changes application state.
  await app.register(async (api) => {
    api.addHook("onRequest", requireAuth(options.store));
    registerSessionRoutes(api, options.store);
    registerConnectionRoutes(api, options.store);
    registerContactRoutes(api, options.store);
    registerGroupRoutes(api, options.store);
    registerRunRoutes(api, options.store, options.enqueue);
    registerSummaryRoutes(api, options.store);
    registerSettingsRoutes(api, options.store);
    registerAdminRoutes(api, options.store, options.enqueue);
    registerAssistantRoutes(api, options.store, options.enqueue, {
      ...options.assistantRateLimit,
      ...(options.assistantPlanner === undefined
        ? {}
        : { planner: options.assistantPlanner }),
    });
  });

  return app;
}
