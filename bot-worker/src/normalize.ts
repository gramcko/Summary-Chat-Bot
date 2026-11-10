import type { RawInboundMessage } from "./whatsapp/adapter.js";

/**
 * Message normalization policy (architecture §4.3/§5.1, ADR 0004).
 * Pure and dependency-free so every rule is unit-testable.
 *
 * CAPTURE (MVP: text and links):
 * - text content (conversation / extendedTextMessage) -> message_type
 *   "text", or "link" when the message carries a link preview or the
 *   body is only URLs (whitespace-separated http(s) URLs).
 * - every other content type (images, videos, documents, audio,
 *   stickers, contacts, locations, polls, ...) -> message_type "other"
 *   with body = the caption when the type carries one, else "" (no
 *   media is ever downloaded). A caption-only "other" row stays
 *   "other" even when the caption contains URLs.
 *
 * SKIP (counted, never persisted):
 * - status broadcasts (status@broadcast)
 * - reactions
 * - protocol messages, which is how WhatsApp delivers message edits and
 *   deletions (the original text is kept; edits are not re-captured)
 * - system/stub notices (group create/subject/participant notices,
 *   history-sync notices)
 * - empty or whitespace-only text bodies (nothing to summarize)
 * - messages without usable content, without a message id, or without a
 *   usable timestamp
 * - non-group chats (DMs) — defense in depth behind the adapter's
 *   shouldIgnoreJid filter; only `@g.us` group chats are ever captured.
 *
 * Own messages (`fromMe`) in a group ARE captured: the linked account is
 * the administrator's own WhatsApp, so their contributions are part of the
 * conversation being summarized. Non-group own traffic (DMs, self-chat,
 * status) is still skipped by the rules above.
 */

export type SkipReason =
  | "not-group"
  | "status-broadcast"
  | "reaction"
  | "protocol"
  | "system"
  | "unsupported-type"
  | "empty-body"
  | "missing-id"
  | "missing-timestamp";

export type MessageType = "text" | "link" | "other";

/** A normalized message row ready for idempotent persistence. */
export interface NewMessage {
  chatJid: string;
  whatsappMessageId: string;
  senderJid: string | null;
  /** WhatsApp push name of the sender when known (PII, display only). */
  senderName: string | null;
  sentAt: Date;
  body: string;
  messageType: MessageType;
  /** True when the linked account sent the message (its own group messages). */
  fromMe: boolean;
}

export type NormalizeResult =
  | { action: "capture"; row: NewMessage }
  | { action: "skip"; reason: SkipReason };

/** All skip reasons, for counted summaries. */
export const SKIP_REASONS: readonly SkipReason[] = [
  "not-group",
  "status-broadcast",
  "reaction",
  "protocol",
  "system",
  "unsupported-type",
  "empty-body",
  "missing-id",
  "missing-timestamp",
];

/**
 * True when `text` consists solely of http(s) URLs separated by
 * whitespace (a URL sharing more text stays "text"). This is the
 * documented MVP heuristic for message_type "link" (ADR 0004).
 */
export function isUrlOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return /^(?:https?:\/\/\S+\s*)+$/i.test(trimmed);
}

/**
 * Applies the documented capture/skip policy to one adapter-normalized
 * message. Order matters: identity checks first, then event taxonomy,
 * then content.
 */
export function normalizeMessage(raw: RawInboundMessage): NormalizeResult {
  if (raw.chatJid === "status@broadcast") {
    return { action: "skip", reason: "status-broadcast" };
  }
  // Group chats end in `@g.us` (ADR 0004). DMs and channels are never
  // captured, whatever the adapter emitted.
  if (!raw.chatJid.endsWith("@g.us")) {
    return { action: "skip", reason: "not-group" };
  }
  if (raw.kind === "reaction") return { action: "skip", reason: "reaction" };
  if (raw.kind === "protocol") return { action: "skip", reason: "protocol" };
  if (raw.kind === "system") return { action: "skip", reason: "system" };
  if (raw.kind === "empty") return { action: "skip", reason: "unsupported-type" };
  if (raw.messageId === null || raw.messageId === "") {
    return { action: "skip", reason: "missing-id" };
  }
  if (raw.timestampSec === null) {
    return { action: "skip", reason: "missing-timestamp" };
  }

  const sentAt = new Date(raw.timestampSec * 1000);
  // Sender names are clamped to the contract maximum (300 chars, CR#5):
  // the same rule on the live-capture and history-import paths, which
  // share this normalize step.
  const senderName =
    raw.senderName !== null && raw.senderName !== ""
      ? raw.senderName.slice(0, 300)
      : null;
  const base = {
    chatJid: raw.chatJid,
    whatsappMessageId: raw.messageId,
    senderJid: raw.senderJid,
    senderName,
    sentAt,
    fromMe: raw.fromMe,
  };

  if (raw.kind === "other") {
    return {
      action: "capture",
      row: { ...base, body: raw.caption ?? "", messageType: "other" },
    };
  }

  // "text" | "link-preview"
  const body = raw.text ?? "";
  // Empty or whitespace-only text has nothing to capture (CR-m1).
  if (body.trim() === "") {
    return { action: "skip", reason: "empty-body" };
  }
  const messageType: MessageType =
    raw.linkPreview || isUrlOnly(body) ? "link" : "text";
  return { action: "capture", row: { ...base, body, messageType } };
}
