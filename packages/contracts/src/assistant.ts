import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";

/**
 * Dashboard assistant (MVP): a deterministic, rule-based chat over the
 * data the admin can already see — monitored groups, captured messages,
 * and summary runs. Replies are always produced by deterministic tools,
 * so the same request against the same data is reproducible; an optional
 * planner may only CLASSIFY the question (intent + candidate names) and
 * never writes reply text.
 *
 * Privacy boundary: the assistant may only surface MONITORED groups and
 * messages captured from them, and it never accepts a group id from the
 * client — the backend resolves names against the store.
 */

export const AssistantRole = z.enum(["user", "assistant"]);

/**
 * One conversation turn. The MVP only reads the most recent user turn
 * (deterministic intents, no provider context), but the array shape
 * keeps the door open for multi-turn follow-ups without a contract
 * change.
 */
export const AssistantTurn = z.object({
  role: AssistantRole,
  content: z.string().min(1).max(4000),
});

export const AssistantChatRequest = z.object({
  /** 1..20 turns, oldest first. */
  messages: z.array(AssistantTurn).min(1).max(20),
});

/**
 * One piece of evidence backing a reply. `kind` says what the reference
 * points at: a monitored group, a captured message, or a summary run.
 * Only the fields that apply to the kind are set; the rest are null.
 */
export const AssistantCitation = z.object({
  kind: z.enum(["group", "message", "run"]),
  groupId: Id,
  groupName: z.string().min(1).max(300),
  /** Set for `message` citations; null otherwise. */
  messageId: z.string().min(1).max(100).nullable(),
  /** Set for `run` citations; null otherwise. */
  runId: Id.nullable(),
  /** Message timestamp for `message` citations; null otherwise. */
  sentAt: IsoDateTime.nullable(),
});

export const AssistantChatResponse = z.object({
  /** Human-readable answer (plain text, newlines allowed). */
  reply: z.string().min(1).max(8000),
  /** Evidence for the reply, capped so one answer stays readable. */
  citations: z.array(AssistantCitation).max(20),
  /**
   * The summary run the reply refers to, when the intent created (or
   * found) one. Null for every other intent.
   */
  pendingRunId: Id.nullable(),
});

export type AssistantRole = z.infer<typeof AssistantRole>;
export type AssistantTurn = z.infer<typeof AssistantTurn>;
export type AssistantChatRequest = z.infer<typeof AssistantChatRequest>;
export type AssistantCitation = z.infer<typeof AssistantCitation>;
export type AssistantChatResponse = z.infer<typeof AssistantChatResponse>;
