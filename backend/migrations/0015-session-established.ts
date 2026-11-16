import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Persistent "this session has opened at least once" flag (ADR 0007
 * correction, follow-up).
 *
 * `creds.me` is written by Baileys as soon as the QR scan succeeds, but
 * the very next socket is still the registration handshake: WhatsApp
 * closes it with 515 restart_required, and on the reconnect that follows
 * `creds.me` already exists. Treating `creds.me` as "linked" therefore
 * applied the Desktop preset + `syncFullHistory` to the FIRST
 * post-scan reconnect, which WhatsApp closes with 428 before
 * `connection: open` — the worker loops and the phone reports the link
 * as failed.
 *
 * The flag is set by the bot-worker only after a socket actually reaches
 * `connection: open`, and cleared by `finalizeLogout` (logout and reset
 * both use it). The connect-time history config reads it instead of
 * `creds.me`, so `WA_HISTORY_SYNC=full` applies only after the first
 * successful open (a later reconnect/restart), never during linking.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("whatsapp_connections", {
    session_established: {
      type: "boolean",
      notNull: true,
      default: false,
      comment:
        "True after the socket reached connection:open at least once; gates Desktop preset + syncFullHistory (ADR 0007)",
    },
  });
}

/** Drops only what this migration added; connection state is unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("whatsapp_connections", ["session_established"]);
}
