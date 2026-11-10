/**
 * Internal WhatsApp adapter contract (architecture §4.3, ADR 0004).
 *
 * ALL Baileys-specific code lives in `baileys-adapter.ts`; nothing else
 * in the service may import `@whiskeysockets/baileys`. The rest of the
 * service is unit-testable against `FakeAdapter` with no WhatsApp
 * account and no network (AGENTS.md).
 *
 * The raw-message shape below is deliberately Baileys-free: it carries
 * only identifiers, timestamps, and extracted text/caption fragments.
 * Policy (skip rules, classification) lives in `normalize.ts`.
 */

/** Content classification performed inside the adapter (ADR 0004). */
export type RawContentKind =
  /** Plain text (conversation / extendedTextMessage without a link preview). */
  | "text"
  /** Text carrying a link preview (extendedTextMessage with canonical url). */
  | "link-preview"
  /** Any other content type (media, contacts, polls, ...). */
  | "other"
  /** Reaction to a message — never persisted. */
  | "reaction"
  /** Protocol message (edits, deletions, key exchanges) — never persisted. */
  | "protocol"
  /** System/stub notice (group events, history-sync notices) — never persisted. */
  | "system"
  /** No usable content at all. */
  | "empty";

/** A single incoming WhatsApp message, adapter-normalized (untrusted data). */
export interface RawInboundMessage {
  /** Chat JID. Group chats end in `@g.us`. */
  chatJid: string;
  /** Stable WhatsApp message id (Baileys key.id); null when absent. */
  messageId: string | null;
  /** Sender participant JID; null when WhatsApp did not provide one. */
  senderJid: string | null;
  /**
   * Sender's WhatsApp push name when the message carried one (PII,
   * display only — persisted as messages.sender_name). Null when absent.
   */
  senderName: string | null;
  /** Unix seconds (WhatsApp messageTimestamp); null when absent/invalid. */
  timestampSec: number | null;
  /** True for messages sent by the linked account itself. */
  fromMe: boolean;
  kind: RawContentKind;
  /** Text content for kinds "text" and "link-preview". */
  text: string | null;
  /** Caption for kind "other" when the content type carries one. */
  caption: string | null;
  /** True when the message carries a link preview. */
  linkPreview: boolean;
}

/**
 * Linking-payload TTLs published to `whatsapp_connections` (ADR 0008).
 * A Baileys QR rotates roughly every 20 s but may stay valid longer, so
 * the published expiry is a conservative ~60 s; pairing codes live a
 * few minutes (documented as such by WhatsApp) and get 5 minutes. The
 * pairing TTL also bounds how long the adapter waits before starting a
 * FRESH pairing flow (CR#6): an expired code must not dead-end linking.
 */
export const LINKING_QR_TTL_MS = 60_000;
export const PAIRING_CODE_TTL_MS = 300_000;

/**
 * One roster entry of a group chat (ADR 0008): participant JID + display
 * name when known + phone-number JID fallback + admin flag. Best-effort
 * data — WhatsApp does not replay membership history.
 */
export interface GroupMemberInfo {
  /** Participant JID (may be an `@lid` or `@s.whatsapp.net` form). */
  userId: string;
  /**
   * Display name when known. Group metadata carries only JIDs, so the
   * adapter resolves this from WhatsApp contacts / message push names;
   * null when no name has been observed yet.
   */
  name: string | null;
  /**
   * Phone-number JID (`…@s.whatsapp.net`) when known; null for LID-only
   * members. A fallback identifier for the admin UI — PII like the rest
   * of the roster.
   */
  phone: string | null;
  isAdmin: boolean;
}

/** A display name observed for one or more WhatsApp JID aliases. */
export interface ContactNameUpdate {
  /** Normalized JID aliases (LID and/or PN form) the name applies to. */
  jids: string[];
  /** Display name (already trimmed to the contract cap). PII — never logged. */
  name: string;
}

/** Result of a live WhatsApp session health probe. */
export interface SessionCheckResult {
  ok: boolean;
  /** Round-trip latency in milliseconds (null when not measured). */
  latencyMs: number | null;
  /** Safe error code/message; never contains message content or secrets. */
  error: string | null;
}

/** A group chat the linked account participates in. */
export interface DiscoveredChat {
  chatJid: string;
  /** Group subject (name). May fall back to the JID when unset. */
  name: string;
  /**
   * Roster snapshot from the group metadata (ADR 0008, best-effort).
   * Empty when the metadata carried no participants — never treated as
   * "this group has no members" (see db.syncGroupMembers).
   */
  members: GroupMemberInfo[];
}

/** Why an on-demand history request could not be fulfilled. */
export type HistoryFailureReason =
  | "history_phone_offline"
  | "history_declined"
  | "history_expired"
  | "history_unavailable";

/**
 * How the socket treats WhatsApp's initial history sync (ADR 0007):
 * - "off": only ON_DEMAND responses to our own requests (privacy-first).
 * - "recent": allow the initial RECENT/INITIAL_BOOTSTRAP sync to complete
 *   (required by WhatsApp's protocol state machine) but DROP the payload.
 * - "full": also request/capture the initial/full history for monitored
 *   groups (opt-in backfill; requires a re-link to trigger).
 */
export type HistorySyncMode = "off" | "recent" | "full";

/** Participant-change actions (mirror of the WhatsApp event taxonomy). */
export type ParticipantsAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "modify";

/**
 * History-import cursor (ADR 0007): the oldest message already held, so
 * WhatsApp returns messages older than it. Null requests the newest
 * history WhatsApp will provide.
 */
export interface HistoryCursor {
  messageId: string;
  fromMe: boolean;
  /** Unix seconds (the adapter converts to milliseconds for WhatsApp). */
  timestampSec: number;
}

export interface HistoryFetchRequest {
  chatJid: string;
  /** How many messages to request in this round (bounded budget). */
  count: number;
  /** Oldest message already held; null = no cursor (newest available). */
  cursor: HistoryCursor | null;
}

export type AdapterEvent =
  /** The socket is being (re)established. */
  | { type: "connecting" }
  /** A linkable QR code (linking UX; presentation happens outside). */
  | { type: "qr"; qr: string }
  /** A phone-number pairing code (linking UX). */
  | { type: "pairing-code"; code: string }
  /** The WhatsApp connection is open. */
  | { type: "open" }
  /**
   * The connection closed. `retryable` is false for terminal causes
   * (logged out / replaced / invalid session): the service must stop
   * reconnecting and require a re-link (ADR 0004).
   */
  | { type: "close"; retryable: boolean; reason: string }
  /** Incoming messages (already adapter-filtered to what we handle). */
  | { type: "messages"; messages: RawInboundMessage[] }
  /** A group's metadata changed (e.g. subject renamed). */
  | { type: "chat-updated"; chat: DiscoveredChat }
  /**
   * A group's roster changed (join/leave/promote/demote). The service
   * refreshes that chat's roster via `fetchRoster` (ADR 0008).
   */
  | {
      type: "participants";
      chatJid: string;
      action: ParticipantsAction;
      /** Affected participant JIDs (identifiers; never logged). */
      participants: string[];
    }
  /**
   * Display names learned from WhatsApp contacts / message push names
   * (ADR 0008). Group metadata never carries names, so this is how the
   * roster learns them after discovery. `jids` are the aliases the name
   * applies to (LID and/or PN form). Names are PII: never logged.
   */
  | {
      type: "contact-names";
      contacts: ContactNameUpdate[];
    }
  /**
   * Fetched history for ONE chat (ADR 0007). Emits only messages for
   * chats with an outstanding history request — WhatsApp may return
   * other chats' history in the same batch and it is dropped inside the
   * adapter BEFORE normalization (privacy boundary).
   */
  | {
      type: "history";
      chatJid: string;
      messages: RawInboundMessage[];
      /** "initial" is WhatsApp's connect-time sync; "on-demand" is a request. */
      origin: "initial" | "on-demand";
      /** WhatsApp's batch progress hint (null when not provided). */
      progress: number | null;
      /** Peer-data request id when WhatsApp echoed one (correlation). */
      requestId: string | null;
    }
  /**
   * The phone answered an on-demand history request with a failure
   * code (offline primary, declined, expired, ...). The import service
   * stops waiting and reports the reason instead of a generic timeout.
   */
  | {
      type: "history-error";
      chatJid: string;
      reason: HistoryFailureReason;
    }
  /**
   * The phone answered an on-demand request with REQUEST_SUCCESS but no
   * history payload followed (the chat has no older history). The import
   * finishes as `done` with 0 instead of a false `history_timeout`.
   */
  | { type: "history-success"; chatJid: string };

/**
 * The WhatsApp integration as the rest of the service sees it.
 * Implementations must be safe to `connect()` repeatedly (a reconnect
 * after a transient close creates a fresh socket) and `disconnect()`
 * must close the socket and persist any pending auth state.
 */
export interface WhatsAppAdapter {
  connect(): Promise<void>;
  /** Graceful shutdown: close the socket and save auth state. */
  disconnect(): Promise<void>;
  /** Lists group chats (`@g.us`) the account participates in. */
  fetchChats(): Promise<DiscoveredChat[]>;
  /**
   * Requests up to `count` history messages older than `cursor` for ONE
   * chat (ADR 0007). Results arrive asynchronously as `history` events
   * (possibly several batches). Returns the WhatsApp request id; the
   * promise resolves when the request is RELAYED, not when the history
   * arrives.
   */
  requestHistory(request: HistoryFetchRequest): Promise<string>;
  /**
   * Drops the chat from the adapter's history filter (import finished):
   * late `messaging-history.set` batches for it are no longer emitted
   * ("ignore stale history events", ADR 0007).
   */
  releaseHistoryChat(chatJid: string): void;
  /**
   * Sets the monitored chats eligible for the opt-in initial history
   * capture (mode "full"). The service refreshes this set on start and
   * after discovery; other chats' history is never parsed or stored.
   */
  setHistoryCaptureChats(chatJids: ReadonlySet<string>): void;
  /**
   * Full current roster for ONE chat (group metadata). Best-effort:
   * returns [] when the metadata is unavailable; callers must treat an
   * empty roster as "no data", never as "the group is empty" (ADR 0008).
   */
  fetchRoster(chatJid: string): Promise<GroupMemberInfo[]>;
  /**
   * Live session health probe: checks that the socket is open and that a
   * lightweight WhatsApp query succeeds. Never logs or returns message
   * content; a failure returns a safe code.
   */
  checkSession(): Promise<SessionCheckResult>;
  /**
   * Ends the session (admin logout control, ADR 0008): revokes the
   * linked device remotely when connected and closes the socket. The
   * CALLER purges the local auth-state files (`purgeSessionDir`) — it
   * owns that step so it always runs even when this call stalls (M-1
   * bounds it with a timeout). Idempotent — a missing socket is not an
   * error.
   */
  logout(): Promise<void>;
  /** Subscribes to adapter events; returns an unsubscribe function. */
  subscribe(handler: (event: AdapterEvent) => void): () => void;
}
