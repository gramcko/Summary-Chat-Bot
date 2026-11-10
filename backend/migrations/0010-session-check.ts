import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Admin-requested WhatsApp session health check (ADR 0008 follow-up).
 * The backend sets `session_check_requested_at`; the bot-worker performs
 * a bounded live probe and writes the result columns. The dashboard
 * polls `GET /api/connection` for the pending/ok/failed state.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("whatsapp_connections", {
    session_check_requested_at: { type: "timestamptz" },
    session_check_checked_at: { type: "timestamptz" },
    session_check_ok: { type: "boolean" },
    session_check_latency_ms: { type: "integer" },
    session_check_error: {
      type: "text",
      comment: "Safe check error code/message; never message content",
    },
  });
}

/** Drops the session-check columns; connection state is unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("whatsapp_connections", [
    "session_check_requested_at",
    "session_check_checked_at",
    "session_check_ok",
    "session_check_latency_ms",
    "session_check_error",
  ]);
}
