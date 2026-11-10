import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Own group messages are now captured: the linked WhatsApp account is the
 * administrator's own phone, so its contributions belong in the summary.
 * `from_me` preserves the WhatsApp message origin for the on-demand
 * history anchor (ADR 0007). Existing rows were captured under the old
 * policy, where own messages were skipped, so `false` is correct for them.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("messages", {
    from_me: {
      type: "boolean",
      notNull: true,
      default: false,
      comment: "True when the linked account sent the message",
    },
  });
}

/** Drops the origin flag; message capture is unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("messages", ["from_me"]);
}
