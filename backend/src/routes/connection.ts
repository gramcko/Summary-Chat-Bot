import type { FastifyInstance } from "fastify";
import { ConnectionStatus } from "@summarly/contracts";
import type { Store } from "../lib/store.js";

export function registerConnectionRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/connection", async () =>
    ConnectionStatus.parse(await store.getConnectionStatus()),
  );

  /**
   * End / unlink the WhatsApp session (ADR 0008): records the admin
   * request (`logout_requested_at`) for the bot-worker to consume —
   * the API never reaches into the session itself. Idempotent: a
   * request that is already pending keeps its original timestamp and
   * the answer stays 202.
   */
  app.post("/api/connection/logout", async (_request, reply) => {
    await store.requestLogout();
    return reply.status(202).send({ ok: true });
  });

  /**
   * Deletes the LOCAL WhatsApp connection data (migration 0014). Unlike
   * logout, this skips the remote revoke entirely: the bot-worker purges
   * the Baileys session directory, finalizes the row, and re-arms
   * linking so a fresh QR appears — the recovery path for a partial or
   * invalid session. Captured data and settings are untouched.
   * Idempotent: 202 also while a request is pending.
   */
  app.post("/api/connection/reset", async (_request, reply) => {
    await store.requestSessionReset();
    return reply.status(202).send({ ok: true });
  });

  /**
   * Requests a live session health check. The backend only records the
   * request; the bot-worker performs the bounded probe and writes the
   * result, which `GET /api/connection` exposes as `check`.
   */
  app.post("/api/connection/test", async (_request, reply) => {
    await store.requestSessionCheck();
    return reply.status(202).send({ ok: true });
  });
}
