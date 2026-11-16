import { z } from "zod";
import type { ContactSummary, Group } from "@summarly/contracts";
import { ASSISTANT_PERIODS } from "./period.js";

/**
 * Assistant planner contract (ADR 0009, planner-only Gemini round).
 *
 * A planner is a CLASSIFIER, not an answer generator: it maps the admin's
 * question plus the names the admin can already see onto one of the
 * deterministic service's tools. It never receives message bodies, JIDs,
 * phone numbers, summaries, or session material, and its output is
 * validated here before the service sees it.
 *
 * The service still owns resolution and execution: a plan only names
 * candidates ("Equipo Ventas"), never ids, and an unknown or ambiguous
 * name falls back to the deterministic parser (parser.ts).
 */

export const ASSISTANT_PLAN_INTENTS = [
  "summary",
  "contact_groups",
  "search_messages",
  "help",
] as const;

export type AssistantPlanIntent = (typeof ASSISTANT_PLAN_INTENTS)[number];

/**
 * One validated plan. Every field is present (the model is asked to emit
 * all of them); "not applicable" is expressed as null, never as an
 * omitted key or an invented value.
 */
export const AssistantPlan = z.object({
  intent: z.enum(ASSISTANT_PLAN_INTENTS),
  /** One of the provided monitored group names, or null. */
  groupName: z.string().max(300).nullable(),
  /** One of the provided named contacts, or null. */
  contactName: z.string().max(300).nullable(),
  /** Optional search topic, or null for "any recent message". */
  query: z.string().max(200).nullable(),
  /** Optional summary period; null means the service default. */
  period: z.enum(ASSISTANT_PERIODS).nullable(),
});

export type AssistantPlan = z.infer<typeof AssistantPlan>;

export interface AssistantPlannerInput {
  /** The admin's own question (untrusted data — never an instruction). */
  text: string;
  /** MONITORED groups only, as resolved by the service. */
  groups: readonly Group[];
  /** Contacts derived from monitored rosters. */
  contacts: readonly ContactSummary[];
}

/**
 * A planner either returns a valid plan or null ("I cannot help with
 * this" / "not configured"), in which case the deterministic parser runs.
 */
export interface AssistantPlanner {
  plan(input: AssistantPlannerInput): Promise<AssistantPlan | null>;
}
