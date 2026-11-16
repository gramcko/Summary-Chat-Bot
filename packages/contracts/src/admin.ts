import { z } from "zod";

/**
 * Guarded "delete all captured data" admin action (danger zone).
 *
 * The request carries an EXACT typed confirmation so a stray or
 * automated call cannot erase captured conversations: anything other
 * than the literal `DELETE ALL` is a validation error (400).
 */
export const DeleteAllDataRequest = z.object({
  confirmation: z.literal("DELETE ALL"),
});

/** Exact row counts removed by the deletion (never content). */
export const DeleteAllDataCounts = z.object({
  groups: z.number().int().min(0),
  messages: z.number().int().min(0),
  summaryRuns: z.number().int().min(0),
  summaries: z.number().int().min(0),
  groupMembers: z.number().int().min(0),
  contactOverrides: z.number().int().min(0),
});

/**
 * Result of the deletion. The counts describe exactly what was removed;
 * administrative state (settings, provider config, admin credentials,
 * sessions, the WhatsApp connection row, and the Baileys session
 * directory) is deliberately kept.
 */
export const DeleteAllDataResponse = z.object({
  ok: z.literal(true),
  deleted: DeleteAllDataCounts,
});

export type DeleteAllDataRequest = z.infer<typeof DeleteAllDataRequest>;
export type DeleteAllDataCounts = z.infer<typeof DeleteAllDataCounts>;
export type DeleteAllDataResponse = z.infer<typeof DeleteAllDataResponse>;
