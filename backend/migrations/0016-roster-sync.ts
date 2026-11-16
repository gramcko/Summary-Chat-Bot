import type { MigrationBuilder } from "node-pg-migrate";

/**
 * On-demand roster sync request (ADR 0008 follow-up).
 *
 * Roster capture is best-effort and event-driven: the bot-worker syncs a
 * chat's members on discovery and on membership changes. A group that was
 * discovered BEFORE the admin enabled monitoring therefore has no roster
 * (discovery only syncs monitored chats), and enabling monitoring later
 * produced an empty Members tab with no way to refresh it short of a
 * membership event.
 *
 * `roster_sync_requested_at` is the same pattern as the logout/reset/
 * session-check flags: the backend only records the request (monitoring
 * enabled, or an explicit `POST /api/groups/:id/roster-sync`), and the
 * bot-worker consumes it on its existing session-control poll — claim one
 * request atomically, fetch the group metadata, sync the roster. It is an
 * internal control column: it is NOT part of the `Group` API contract.
 *
 * Monitored groups only: the column is only ever set for a monitored
 * group, and the bot-worker's claim re-checks `monitored = true` so
 * un-monitoring revokes a pending request (the ADR 0004 boundary).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("groups", {
    roster_sync_requested_at: {
      type: "timestamptz",
      comment:
        "Pending on-demand roster sync request; set by the backend, consumed and cleared by the bot-worker (monitored groups only)",
    },
  });
}

/** Drops only what this migration added; group data is unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("groups", ["roster_sync_requested_at"]);
}
