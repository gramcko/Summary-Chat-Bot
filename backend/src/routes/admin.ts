import type { FastifyInstance } from "fastify";
import {
  DeleteAllDataRequest,
  DeleteAllDataResponse,
} from "@summarly/contracts";
import type { SummaryEnqueuer } from "../lib/enqueue.js";
import type { Store } from "../lib/store.js";

/**
 * Guarded "delete all captured data" admin action (danger zone).
 *
 * Scope (see Store.deleteAllData): captured data only — groups,
 * messages, summary runs, summaries, the group roster, and contact
 * overrides. Settings, the AI provider configuration, admin credentials
 * and sessions, the WhatsApp connection row, and the Baileys session
 * directory are deliberately KEPT.
 *
 * The request must carry the exact `DELETE ALL` confirmation (schema
 * literal); anything else is a 400 validation error. The database
 * deletion is one transaction; the queue purge runs afterwards and a
 * purge failure is logged without failing the deletion (the captured
 * data is already gone — a stale queued job will fail to find its run).
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  store: Store,
  enqueue: SummaryEnqueuer,
): void {
  app.post("/api/admin/delete-all-data", async (request) => {
    // Exact typed confirmation; a wrong/missing value throws ZodError,
    // which the app error handler answers as 400 validation_error.
    DeleteAllDataRequest.parse(request.body);

    const deleted = await store.deleteAllData();

    // Best-effort queue cleanup: never fail the whole deletion because
    // Redis is unavailable. Safe metadata only (error name, counts).
    try {
      await enqueue.purgeAll?.();
    } catch (error) {
      request.log.error(
        {
          reason: error instanceof Error ? error.name : "unknown",
        },
        "failed to purge summary queue after data deletion",
      );
    }

    // Counts only — never content, names, or JIDs.
    request.log.info({ deleted }, "data_deleted");

    return DeleteAllDataResponse.parse({ ok: true, deleted });
  });
}
