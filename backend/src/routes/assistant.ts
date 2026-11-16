import type { FastifyInstance } from "fastify";
import { AssistantChatRequest, AssistantChatResponse } from "@summarly/contracts";
import type { SummaryEnqueuer } from "../lib/enqueue.js";
import type { AssistantAnswerComposer } from "../lib/assistant/answer-composer.js";
import { createGeminiAnswerComposer } from "../lib/assistant/gemini-answer-composer.js";
import { createGeminiPlanner } from "../lib/assistant/gemini-planner.js";
import type { AssistantPlanner } from "../lib/assistant/planner.js";
import { AssistantRateLimiter } from "../lib/assistant/rate-limit.js";
import { AssistantService, type AssistantLogger } from "../lib/assistant/service.js";
import type { Store } from "../lib/store.js";

export interface AssistantRouteOptions {
  /** Requests allowed per IP per window (default 20). */
  limit?: number;
  /** Window length in milliseconds (default 60 000). */
  windowMs?: number;
  /** Clock seam for the rate limiter (tests). */
  now?: () => number;
  /**
   * Test seam: replace the planner (defaults to the Gemini classifier).
   * The default planner falls back to the deterministic parser whenever
   * Gemini is not configured, so tests need no network either way.
   */
  planner?: AssistantPlanner;
  /**
   * Test seam: replace the answer composer (defaults to the Gemini
   * rewriter). The default composer returns null whenever Gemini is not
   * configured, so tests need no network either way.
   */
  answerComposer?: AssistantAnswerComposer;
}

/**
 * Dashboard assistant endpoint (authenticated admin API).
 *
 * Registered inside the authenticated route group (app.ts), so the
 * session hook runs before the body is even parsed. The service resolves
 * intents deterministically and reads only monitored data; this route
 * owns the request validation and the per-IP operational rate limit.
 *
 * The optional Gemini planner only CLASSIFIES the question (intent +
 * candidate names); the optional Gemini composer only REWRITES the
 * deterministic reply text. Citations, runs, and the fallback stay with
 * the deterministic service. Both are constructed once per registration.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  store: Store,
  enqueue: SummaryEnqueuer,
  options: AssistantRouteOptions = {},
): void {
  const limiter = new AssistantRateLimiter({
    limit: options.limit,
    windowMs: options.windowMs,
    now: options.now,
  });
  // Safe operational metadata only (intent, planner/answer source,
  // counts, durations) — the service never logs message bodies, names,
  // JIDs, or reply text.
  const log: AssistantLogger = (event, fields) => {
    app.log.info(fields, event);
  };
  const planner = options.planner ?? createGeminiPlanner({ store, log });
  const answerComposer =
    options.answerComposer ?? createGeminiAnswerComposer({ store, log });
  const service = new AssistantService({
    store,
    enqueue,
    log,
    planner,
    answerComposer,
  });

  app.post("/api/assistant/chat", async (request) => {
    // Rate limit BEFORE validation so a client cannot bypass the limit
    // with a stream of malformed requests.
    limiter.check(request.ip);
    const body = AssistantChatRequest.parse(request.body);
    return AssistantChatResponse.parse(await service.chat(body));
  });
}
