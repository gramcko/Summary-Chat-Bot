import type { MigrationBuilder } from "node-pg-migrate";

/**
 * "Delete connection data" reset control (ADR 0004/0008 follow-up).
 *
 * A partial or invalid WhatsApp session can leave the bot-worker
 * reconnecting with stale credentials and never publishing a QR. The
 * existing END/UNLINK path revokes the linked device remotely first; this
 * flag asks the bot-worker for a LOCAL-ONLY reset: purge the Baileys
 * session directory, finalize the connection row, and re-arm linking so a
 * fresh QR appears. No remote revoke is attempted.
 *
 * The backend only records the request; the bot-worker consumes it
 * atomically (clearing this column and any pending
 * `logout_requested_at`, so a reset wins over a remote logout).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("whatsapp_connections", {
    session_reset_requested_at: {
      type: "timestamptz",
      comment:
        "Admin delete-connection-data request; consumed and cleared by bot-worker (local purge only, no remote revoke)",
    },
  });
}

/** Drops only what this migration added. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("whatsapp_connections", ["session_reset_requested_at"]);
}
