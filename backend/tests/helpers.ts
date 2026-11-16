import { CreateAdminResponse } from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import type { EnqueueOutcome, SummaryEnqueuer } from "../src/lib/enqueue.js";
import { InMemoryStore } from "../src/lib/store.js";
import { SESSION_COOKIE } from "../src/routes/auth.js";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

export const ADMIN_PASSWORD = "correct-horse-battery-123";
export const NEW_PASSWORD = "new-secret-password-456";
export const GROUP_ID = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";

/**
 * In-memory enqueuer: records every enqueue request so route tests can
 * assert queue wiring WITHOUT Redis. Set `failWith` to simulate a queue
 * outage (the routes must swallow it and leave the run recoverable).
 */
export class RecordingEnqueuer implements SummaryEnqueuer {
  readonly enqueued: string[] = [];
  /** How many times the queue purge was requested (danger-zone action). */
  purged = 0;
  failWith: Error | undefined;
  failPurgeWith: Error | undefined;

  async enqueueSummaryRun(runId: string): Promise<EnqueueOutcome> {
    if (this.failWith !== undefined) throw this.failWith;
    this.enqueued.push(runId);
    return "enqueued";
  }

  async purgeAll(): Promise<void> {
    if (this.failPurgeWith !== undefined) throw this.failPurgeWith;
    this.purged += 1;
  }
}

/** Enqueuer that discards everything (tests that do not care). */
export const noopEnqueuer: SummaryEnqueuer = {
  async enqueueSummaryRun(): Promise<EnqueueOutcome> {
    return "already-queued";
  },
  async purgeAll(): Promise<void> {},
};

export async function makeApp(): Promise<{
  app: TestApp;
  store: InMemoryStore;
  enqueue: RecordingEnqueuer;
}> {
  const store = new InMemoryStore();
  const enqueue = new RecordingEnqueuer();
  const app = await buildApp({
    store,
    enqueue,
    cookieSecure: false,
    logger: false,
  });
  return { app, store, enqueue };
}

export async function setupAdmin(app: TestApp): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { password: ADMIN_PASSWORD },
  });
  return CreateAdminResponse.parse(res.json()).recoveryCodes;
}

export async function login(app: TestApp): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: ADMIN_PASSWORD },
  });
  const session = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
  if (session === undefined) {
    throw new Error("login did not set a session cookie");
  }
  return `${SESSION_COOKIE}=${session.value}`;
}

export async function seedGroup(store: InMemoryStore): Promise<void> {
  await store.upsertGroup({
    id: GROUP_ID,
    chatId: null,
    name: "Test Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
    historyImport: null,
  });
}
