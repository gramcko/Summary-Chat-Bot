import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  type ConnectionState as BaileysConnectionState,
  type GroupMetadata,
  type SocketConfig,
  type WAVersion,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { errorReason } from "../lib/errors.js";
import { isPhoneJid, normalizeJidAlias } from "../lib/jid.js";
import type { Logger } from "../lib/log.js";
import { safeChatRef } from "../lib/privacy.js";
import type {
  AdapterEvent,
  ContactNameUpdate,
  DiscoveredChat,
  GroupMemberInfo,
  HistoryFailureReason,
  HistoryFetchRequest,
  HistorySyncMode,
  ParticipantsAction,
  RawContentKind,
  RawInboundMessage,
  SessionCheckResult,
  WhatsAppAdapter,
} from "./adapter.js";
import { PAIRING_CODE_TTL_MS } from "./adapter.js";

/**
 * The ONLY module that imports `@whiskeysockets/baileys` (architecture
 * §4.3, ADR 0004). It translates Baileys sockets/events/messages into
 * the internal adapter contract so the rest of the service is testable
 * without Baileys and without a WhatsApp account.
 *
 * Baileys is an UNOFFICIAL WhatsApp Web integration: upstream protocol
 * changes or account restrictions can break it at any time (ADR 0004).
 * The pinned version and the translation rules below were verified
 * against the installed package sources, not remembered behavior.
 *
 * Privacy posture (ADR 0004):
 * - the Baileys logger is silenced (its logs can carry chat metadata)
 * - `shouldIgnoreJid` drops every non-group JID before decryption
 * - history sync is disabled (no bulk backfill of old conversations)
 * - `markOnlineOnConnect` is off; own group messages flow through the
 *   normal capture path and keep their `fromMe` origin
 */

export interface BaileysAdapterOptions {
  /** Protected session-state directory (WA_SESSION_DIR). Never logged. */
  sessionDir: string;
  /** E.164 digits for pairing-code linking; null/undefined = QR linking. */
  phoneNumber?: string | null;
  /**
   * Opt-in egress (WA_CHECK_UPDATES=yes): fetch the latest WhatsApp Web
   * version manifest from the Baileys repository at connect time. Off by
   * default — the version bundled with the pinned Baileys release is
   * used instead (no third-party influence on the protocol version).
   */
  checkForUpdates?: boolean;
  /**
   * How long a requested pairing code stays latched before a FRESH
   * pairing flow may start (CR#6). Defaults to the published payload
   * TTL: once the dashboard shows the code as expired, the adapter must
   * not dead-end linking on the stale latch.
   */
  pairingCodeTtlMs?: number;
  /** Initial/full history policy (ADR 0007). Defaults to "off". */
  historySyncMode?: HistorySyncMode;
  log: Logger;
}

type BaileysLogger = SocketConfig["logger"];

/** Pino-compatible logger that drops everything (privacy, ADR 0004). */
function createSilentLogger(): BaileysLogger {
  const silent = (): void => {};
  const self: BaileysLogger = {
    level: "silent",
    child: () => self,
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
  };
  return self;
}

/** Error reason for logs: code or truncated message, never file paths. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Name fields a WhatsApp contact may carry (any subset). */
interface ContactFields {
  notify?: string;
  name?: string;
  verifiedName?: string;
}

/** Best display name from the available contact fields (contract cap). */
function bestContactName(fields: ContactFields): string | null {
  const candidate = fields.notify ?? fields.name ?? fields.verifiedName;
  return candidate === undefined ? null : candidate.slice(0, 300);
}

/** Extracts the non-empty name fields of a contact-like object. */
function contactFields(contact: {
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}): ContactFields {
  const fields: ContactFields = {};
  const notify = stringOrNull(contact.notify);
  const name = stringOrNull(contact.name);
  const verifiedName = stringOrNull(contact.verifiedName);
  if (notify !== null) fields.notify = notify;
  if (name !== null) fields.name = name;
  if (verifiedName !== null) fields.verifiedName = verifiedName;
  return fields;
}

/** All normalized JID aliases a contact object exposes. */
function contactAliases(contact: {
  id?: string | null;
  jid?: string | null;
  lid?: string | null;
}): string[] {
  const aliases = new Set<string>();
  for (const jid of [contact.id, contact.jid, contact.lid]) {
    const alias = normalizeJidAlias(jid);
    if (alias !== null) aliases.add(alias);
  }
  return [...aliases];
}

/** Accepts protobufjs Long values and plain numbers (unix seconds). */
function toUnixSeconds(timestamp: unknown): number | null {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) && timestamp > 0
      ? Math.floor(timestamp)
      : null;
  }
  if (
    typeof timestamp === "object" &&
    timestamp !== null &&
    "toNumber" in timestamp &&
    typeof (timestamp as { toNumber: unknown }).toNumber === "function"
  ) {
    const value = (timestamp as { toNumber(): number }).toNumber();
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  return null;
}

/**
 * Protocol-level content keys that are internal noise. WhatsApp bundles
 * senderKeyDistributionMessage with ordinary text/media messages in the
 * same proto, so these may only be treated as the whole message when
 * they are the SOLE content (CR-M1).
 */
const NOISE_CONTENT_KEYS = [
  "senderKeyDistributionMessage",
  "messageHistoryNotice",
  "messageHistoryBundle",
] as const;

/** One level of the wrapper fields unwrapped before classification. */
const WRAPPER_FIELDS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

/**
 * True when protocolMessage / editedMessage content appears at ANY
 * unwrap depth (CR-m2): e.g. ephemeralMessage > editedMessage > text is
 * an edit and must never surface its replacement text as a new message.
 * Bounded to five levels like Baileys' own normalizeMessageContent.
 */
export function containsEditOrProtocol(
  content: proto.IMessage | null | undefined,
  depth = 0,
): boolean {
  if (content === null || content === undefined || depth > 5) return false;
  if (content.protocolMessage != null || content.editedMessage != null) {
    return true;
  }
  const asRecord = content as unknown as Record<
    string,
    { message?: proto.IMessage | null } | null | undefined
  >;
  for (const field of WRAPPER_FIELDS) {
    const inner = asRecord[field]?.message;
    if (inner !== null && inner !== undefined && containsEditOrProtocol(inner, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Strips the internal noise keys (CR-M1). Returns the content to
 * classify (the original object when there was no noise, the stripped
 * shallow copy otherwise) or `undefined` when the noise keys were the
 * sole content — in which case the message is a "system" notice.
 */
function stripSoleNoiseKeys(
  content: proto.IMessage,
): proto.IMessage | undefined {
  const record = content as unknown as Record<string, unknown>;
  const hasNoise = NOISE_CONTENT_KEYS.some((key) => record[key] != null);
  if (!hasNoise) return content;
  const stripped: Record<string, unknown> = { ...record };
  for (const key of NOISE_CONTENT_KEYS) delete stripped[key];
  const remaining = Object.keys(stripped).filter(
    (key) => stripped[key] != null,
  );
  return remaining.length > 0
    ? (stripped as unknown as proto.IMessage)
    : undefined;
}

/**
 * Maps one Baileys message to the internal raw shape (ADR 0004):
 * - group-event stubs -> "system"
 * - protocolMessage / editedMessage at ANY unwrap depth -> "protocol"
 *   (edits and deletions are never re-captured; the original is kept)
 * - senderKeyDistributionMessage / history-sync notices -> "system" ONLY
 *   when they are the sole content; when bundled with real content the
 *   real content is classified (CR-M1)
 * - conversation / extendedTextMessage -> "text" (or "link-preview" when
 *   the message carries a link preview)
 * - image/video/document (incl. captioned documents) -> "other" with the
 *   caption; audio/stickers -> "other" with no caption
 * - reactions -> "reaction"
 * - any other content type -> "other" with its caption when it has one
 * Returns null when the message has no usable identity (no chat JID).
 */
export function mapWAMessage(message: WAMessage): RawInboundMessage | null {
  const key = message.key;
  const chatJid = stringOrNull(key?.remoteJid);
  if (chatJid === null) return null;

  const base = {
    chatJid,
    messageId: stringOrNull(key?.id),
    senderJid: stringOrNull(key?.participant),
    // WhatsApp push name of the sender (PII, display only; ADR 0008).
    senderName: stringOrNull(message.pushName),
    timestampSec: toUnixSeconds(message.messageTimestamp),
    fromMe: key?.fromMe === true,
    text: null,
    caption: null,
    linkPreview: false,
  };

  // Group-event stubs (subject/participant changes etc.). StubType
  // UNKNOWN is 0 and means "not a stub".
  if (
    message.messageStubType !== null &&
    message.messageStubType !== undefined &&
    message.messageStubType !== 0
  ) {
    return { ...base, kind: "system" };
  }

  // Edits and deletions at ANY unwrap depth travel as
  // protocolMessage / editedMessage content and must never be
  // re-captured (ADR 0004) — unwrapping editedMessage would otherwise
  // surface the replacement text as a fresh message (CR-m2).
  if (containsEditOrProtocol(message.message)) {
    return { ...base, kind: "protocol" };
  }

  const rawContent =
    message.message !== null && message.message !== undefined
      ? stripSoleNoiseKeys(message.message)
      : undefined;
  if (rawContent === undefined) {
    // No content at all, or only internal noise (SKDM / history notices).
    return { ...base, kind: message.message != null ? "system" : "empty" };
  }

  const content = normalizeMessageContent(rawContent);
  if (content === undefined) {
    return { ...base, kind: "empty" };
  }
  const type = getContentType(content);
  if (type === undefined) {
    return { ...base, kind: "empty" };
  }

  switch (type) {
    case "conversation": {
      return {
        ...base,
        kind: "text",
        text: stringOrNull(content.conversation) ?? "",
      };
    }
    case "extendedTextMessage": {
      const extended = content.extendedTextMessage;
      // Link-preview detection: WhatsApp sets matchedText (the URL it
      // matched to build the preview) on previewed messages (ADR 0004).
      const linkPreview = stringOrNull(extended?.matchedText) !== null;
      return {
        ...base,
        kind: linkPreview ? "link-preview" : "text",
        text: stringOrNull(extended?.text) ?? "",
        linkPreview,
      };
    }
    case "imageMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.imageMessage?.caption),
      };
    case "videoMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.videoMessage?.caption),
      };
    case "documentMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.documentMessage?.caption),
      };
    case "documentWithCaptionMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(
          content.documentWithCaptionMessage?.message?.documentMessage
            ?.caption,
        ),
      };
    case "audioMessage":
    case "stickerMessage":
      return { ...base, kind: "other", caption: null };
    case "reactionMessage":
      return { ...base, kind: "reaction" };
    // The cases below are unreachable today — edits/protocol content is
    // caught by containsEditOrProtocol() and the noise keys are stripped
    // or rejected before classification. They are kept as annotated
    // backstops so a future wrapper shape can never fall into the
    // capture path by accident.
    case "protocolMessage":
    case "editedMessage":
      // Edits and deletions: skipped, the original captured text is kept.
      return { ...base, kind: "protocol" };
    case "senderKeyDistributionMessage":
    case "messageHistoryNotice":
    case "messageHistoryBundle":
      // Internal distribution/notice noise: never persisted.
      return { ...base, kind: "system" };
    default: {
      // Any other content type is captured as "other" with the caption
      // when the payload has one, else an empty body (ADR 0004).
      const payload = (content as Record<string, unknown>)[type];
      const caption =
        typeof payload === "object" && payload !== null
          ? stringOrNull((payload as { caption?: unknown }).caption)
          : null;
      return { ...base, kind: "other", caption };
    }
  }
}

/**
 * Classifies a connection close. Terminal causes (session revoked,
 * replaced, corrupt, forbidden) must stop reconnection and require a
 * manual re-link (ADR 0004); everything else retries with backoff.
 */
export function classifyClose(statusCode: number | undefined): {
  retryable: boolean;
  reason: string;
} {
  switch (statusCode) {
    case 401: // DisconnectReason.loggedOut — session revoked
      return { retryable: false, reason: "logged_out" };
    case 419: // unauthorized (Baileys UNAUTHORIZED_CODES) — cause unknown
      return { retryable: false, reason: "session_unauthorized" };
    case 440: // DisconnectReason.connectionReplaced — another device took over
      return { retryable: false, reason: "session_replaced" };
    case 500: // DisconnectReason.badSession — corrupt session state
      return { retryable: false, reason: "session_invalid" };
    case 403: // DisconnectReason.forbidden — account restricted
      return { retryable: false, reason: "account_forbidden" };
    case 411: // DisconnectReason.multideviceMismatch
      return { retryable: false, reason: "multidevice_mismatch" };
    case 515: // DisconnectReason.restartRequired — retried with backoff
      return { retryable: true, reason: "restart_required" };
    default:
      // 428 connectionClosed, 408 connectionLost/timedOut, 503
      // unavailableService, and unknown codes: transient.
      return { retryable: true, reason: "connection_lost" };
  }
}

/**
 * Maps one GroupMetadata participants list to roster entries (ADR
 * 0008). WhatsApp group metadata carries only JIDs (verified against
 * the installed 6.7.24 `extractGroupMetadata`), so names normally come
 * from the `resolveName` callback (contacts / push names learned by the
 * adapter). Any name fields present on the participant itself still win.
 * Missing names stay null (a sync must never fail because of a name).
 * Admin = the `admin` role field or the legacy `isAdmin` flag. `phone`
 * is the PN JID when the participant exposes one (LID-only members have
 * null).
 */
export function mapGroupParticipants(
  participants: ReadonlyArray<{
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
    admin?: string | null;
    isAdmin?: boolean;
  }>,
  resolveName?: (participant: {
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
  }) => string | null,
): GroupMemberInfo[] {
  const members: GroupMemberInfo[] = [];
  for (const participant of participants) {
    const userId = stringOrNull(participant.id);
    if (userId === null) continue;
    const phoneJid = isPhoneJid(participant.id)
      ? participant.id
      : isPhoneJid(participant.jid)
        ? participant.jid
        : null;
    members.push({
      userId,
      name:
        stringOrNull(participant.notify) ??
        stringOrNull(participant.name) ??
        stringOrNull(participant.verifiedName) ??
        resolveName?.(participant) ??
        null,
      phone: phoneJid === null ? null : normalizeJidAlias(phoneJid),
      isAdmin:
        participant.admin === "admin" ||
        participant.admin === "superadmin" ||
        participant.isAdmin === true,
    });
  }
  return members;
}

/** Best-effort status code from a Boom-wrapped disconnect error. */
function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const boom = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  if (typeof boom.output?.statusCode === "number") {
    return boom.output.statusCode;
  }
  if (typeof boom.statusCode === "number") return boom.statusCode;
  return undefined;
}

/**
 * True when an incoming stanza from `jid` must be ignored (never
 * decrypted, no events — ADR 0004): everything except group chats and
 * the account's OWN JIDs (device-to-self traffic such as the on-demand
 * history response; `selfUsers` holds the user part of the linked
 * account's PN and LID). Pure and unit-testable (SA-L2); the adapter
 * feeds it a live reading of `auth.state.creds.me`, which Baileys
 * mutates in place on `creds.update` (Socket/socket.js), so a first
 * ever link starts processing self traffic immediately.
 */
export function isIgnoredIncomingJid(
  jid: string | null | undefined,
  selfUsers: ReadonlySet<string>,
): boolean {
  // Baileys passes `node.attrs.from` for receipts/offline nodes, which can
  // be missing on malformed or protocol-only stanzas. Treating that as
  // "ignore" is safe; throwing here used to abort the whole offline-node
  // batch (including on-demand history responses).
  if (typeof jid !== "string" || jid === "") return true;
  if (jid.endsWith("@g.us")) return false;
  const user = jid.split(/[:@]/)[0] ?? jid;
  return !selfUsers.has(user);
}

/**
 * Correlation check for history payloads (SA-M3): a
 * `messaging-history.set` whose `peerDataRequestSessionId` is absent or
 * is not one of OUR outstanding request ids is logged (fixed safe line)
 * but still processed — ENFORCEMENT IS PENDING LIVE VERIFICATION
 * because the session-id echo behavior is unverified against a real
 * account (TODO(live-verify): enforce once confirmed).
 */
export function classifyHistoryCorrelation(
  sessionId: string | null,
  knownRequestIds: ReadonlySet<string>,
): "match" | "missing-session-id" | "unknown-session-id" {
  if (sessionId === null) return "missing-session-id";
  return knownRequestIds.has(sessionId) ? "match" : "unknown-session-id";
}

/**
 * True when a previously requested pairing code is older than its TTL
 * (CR#6): the published payload has expired, so the latch must release
 * and a fresh pairing flow may start. `requestedAt === null` means no
 * pairing code was requested yet — never "expired".
 */
export function pairingFlowExpired(
  requestedAt: number | null,
  now: number,
  ttlMs: number,
): boolean {
  return requestedAt !== null && now - requestedAt >= ttlMs;
}

/**
 * Maps the WhatsApp participant-action taxonomy
 * (`add|remove|promote|demote|modify`, verified in
 * Types/GroupMetadata.d.ts) onto the internal one; unknown values fall
 * back to "modify" (the service refreshes the roster for every action,
 * so an unknown action is safe).
 */
export function normalizeParticipantsAction(
  action: string | null | undefined,
): ParticipantsAction {
  switch (action) {
    case "add":
    case "remove":
    case "promote":
    case "demote":
      return action;
    default:
      return "modify";
  }
}

/**
 * Maps the phone's on-demand history response code to a safe failure
 * reason. `0` (REQUEST_SUCCESS) is not a failure — the history payload
 * arrives separately. Unknown/absent codes also return null.
 */
export function historyFailureFromResponseCode(
  code: unknown,
): HistoryFailureReason | null {
  switch (code) {
    case 5: // ERROR_HOSTED_DEVICE_NOT_CONNECTED
      return "history_phone_offline";
    case 2: // DECLINED_SHARING_HISTORY
      return "history_declined";
    case 1: // REQUEST_TIME_EXPIRED
      return "history_expired";
    case 3: // GENERIC_ERROR
    case 4: // ERROR_REQUEST_ON_NON_SMB_PRIMARY
    case 6: // ERROR_HOSTED_DEVICE_LOGIN_TIME_NOT_SET
      return "history_unavailable";
    default:
      return null;
  }
}

/**
 * Extracts a failed on-demand history response from an incoming PDO
 * response message (verified against the 6.7.24 proto:
 * `peerDataOperationRequestResponseMessage.peerDataOperationResult[].
 * fullHistorySyncOnDemandRequestResponse.responseCode`). Baileys itself
 * only handles placeholder resends, so without this a failed request
 * looks like a 30-second timeout. Returns null for success/other PDOs.
 */
export function mapHistoryResponseFailure(message: WAMessage): {
  requestId: string | null;
  reason: HistoryFailureReason;
} | null {
  const response =
    message.message?.protocolMessage?.peerDataOperationRequestResponseMessage;
  if (response === null || response === undefined) return null;
  const requestId = stringOrNull(response.stanzaId);
  for (const result of response.peerDataOperationResult ?? []) {
    const history = result.fullHistorySyncOnDemandRequestResponse;
    if (history === null || history === undefined) continue;
    const reason = historyFailureFromResponseCode(history.responseCode);
    if (reason !== null) return { requestId, reason };
  }
  return null;
}

/**
 * Parses BOTH outcomes of an on-demand history PDO response. A
 * REQUEST_SUCCESS (code 0) with no history payload means "no older
 * history available"; surfacing it lets the import finish as `done`
 * with 0 instead of a false `history_timeout`.
 */
export function mapHistoryResponse(message: WAMessage): {
  requestId: string | null;
  kind: "success" | "failure";
  reason: HistoryFailureReason | null;
} | null {
  const response =
    message.message?.protocolMessage?.peerDataOperationRequestResponseMessage;
  if (response === null || response === undefined) return null;
  const requestId = stringOrNull(response.stanzaId);
  for (const result of response.peerDataOperationResult ?? []) {
    const history = result.fullHistorySyncOnDemandRequestResponse;
    if (history === null || history === undefined) continue;
    const reason = historyFailureFromResponseCode(history.responseCode);
    if (reason !== null) return { requestId, kind: "failure", reason };
    if (history.responseCode === 0) {
      return { requestId, kind: "success", reason: null };
    }
  }
  return null;
}

/**
 * The `messaging-history.set` payload as delivered by Baileys
 * (Types/Events.d.ts, verified against the installed 6.7.24 sources):
 * `{ chats, contacts, messages, isLatest?, progress?, syncType?,
 * peerDataRequestSessionId? }`. Only the fields we use are typed here.
 */
export interface HistorySetPayload {
  messages: WAMessage[];
  contacts?: Array<{
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
  }>;
  progress?: number | null;
  syncType?: number | undefined;
  peerDataRequestSessionId?: string | null;
}

/**
 * Translates one history batch into adapter `history` events
 * (ADR 0007, verified against Baileys 6.7.24 process-message.js /
 * Utils/history.js): messages are already reverse-chronological and may
 * span MANY chats — only chats with an outstanding request are mapped,
 * everything else is dropped BEFORE normalization (privacy boundary:
 * history for other chats is never parsed or stored).
 */
export function mapHistorySet(
  payload: HistorySetPayload,
  requestedChats: ReadonlySet<string>,
  origin: "initial" | "on-demand" = "on-demand",
): Array<Extract<AdapterEvent, { type: "history" }>> {
  const byChat = new Map<string, RawInboundMessage[]>();
  for (const message of payload.messages) {
    const chatJid = stringOrNull(message.key?.remoteJid);
    if (chatJid === null || !requestedChats.has(chatJid)) continue;
    const mapped = mapWAMessage(message);
    if (mapped === null) continue;
    const bucket = byChat.get(chatJid);
    if (bucket === undefined) byChat.set(chatJid, [mapped]);
    else bucket.push(mapped);
  }
  const requestId = stringOrNull(payload.peerDataRequestSessionId);
  return [...byChat.entries()].map(([chatJid, messages]) => ({
    type: "history",
    chatJid,
    messages,
    origin,
    progress: typeof payload.progress === "number" ? payload.progress : null,
    requestId,
  }));
}

export class BaileysAdapter implements WhatsAppAdapter {
  private socket: WASocket | null = null;
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private stopping = false;
  private pairingRequested = false;
  private pairingRequestedAt: number | null = null;
  private pairingCodeFailed = false;
  private saveCreds: (() => Promise<void>) | null = null;
  /**
   * Chats with an outstanding history request (ADR 0007): history
   * batches for any other chat are dropped before normalization.
   * Bounded by the import service (one import at a time).
   */
  private readonly pendingHistoryChats = new Set<string>();
  /** Monitored chats eligible for opt-in initial history capture. */
  private readonly historyCaptureChats = new Set<string>();
  private readonly historySyncMode: HistorySyncMode;
  /**
   * Outstanding request ids (SA-M3): request id -> chat, for
   * log-only correlation of `messaging-history.set` payloads.
   */
  private readonly pendingHistoryRequestIds = new Map<string, string>();
  /**
   * Serializes auth-state writes (audit L3): concurrent writeFile calls
   * on creds.json can corrupt the session and force a re-link, so every
   * save runs after the previous one completes.
   */
  private saveChain: Promise<void> = Promise.resolve();
  /**
   * Display-name cache keyed by normalized JID alias (ADR 0008). Group
   * metadata never carries names, so they are learned from WhatsApp
   * contact events and message push names. Values are PII and never
   * logged. Cleared on connect so a re-linked account cannot inherit
   * another account's names.
   */
  private readonly contacts = new Map<string, ContactFields>();

  constructor(private readonly options: BaileysAdapterOptions) {
    this.historySyncMode = options.historySyncMode ?? "off";
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: AdapterEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  /** Enqueues one serialized auth-state save. */
  private queueSaveCreds(): void {
    this.saveChain = this.saveChain
      .then(async () => {
        await this.saveCreds?.();
      })
      .catch((error) => {
        this.options.log("error", "save_creds_failed", {
          reason: errorReason(error),
        });
      });
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.pairingRequested = false;
    this.pairingRequestedAt = null;
    this.pairingCodeFailed = false;
    // Never inherit display names across a re-link: the next account's
    // contact stream repopulates the cache (persisted names stay in
    // group_members and are kept by COALESCE).
    this.contacts.clear();
    const silentLogger = createSilentLogger();

    // The session directory is protected storage; fs failures are
    // re-thrown with codes only so the path can never reach the logs.
    let auth: Awaited<ReturnType<typeof useMultiFileAuthState>>;
    try {
      auth = await useMultiFileAuthState(this.options.sessionDir);
    } catch (error) {
      throw new Error(`session storage unavailable (${errorReason(error)})`);
    }
    // Race guard (CR): stop() may have run during the awaits above — do
    // not create a socket nobody will close.
    if (this.stopping) return;
    this.saveCreds = auth.saveCreds;

    const version = await this.resolveVersion();
    if (this.stopping) return;

    // Own-account JIDs (user + LID forms) must be allowed through
    // shouldIgnoreJid: WhatsApp delivers our on-demand history response
    // as a device-to-self protocolMessage (historySyncNotification,
    // verified in Baileys' process-message.js — it even drops spoofed
    // non-self ones). Everything else non-group is still never
    // decrypted (ADR 0004 privacy boundary). The self users are read
    // LAZILY from the live creds object (Baileys mutates it in place on
    // creds.update, Socket/socket.js:570), so a first-ever link starts
    // processing self traffic as soon as `me` exists (SA-L2).
    const readSelfUsers = (): Set<string> =>
      new Set(
        [auth.state.creds.me?.id, auth.state.creds.me?.lid]
          .filter((jid): jid is string => typeof jid === "string" && jid !== "")
          .map((jid) => jid.split(/[:@]/)[0] ?? jid),
      );

    this.socket = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger),
      },
      logger: silentLogger,
      ...(version !== undefined ? { version } : {}),
      emitOwnEvents: false,
      markOnlineOnConnect: false,
      // Privacy-minimizing collection (ADR 0004): by default only the
      // ON_DEMAND responses to OUR OWN history requests are processed.
      // `WA_HISTORY_SYNC=recent` lets the connect-time RECENT sync
      // complete (WhatsApp's protocol state machine and app-state sync
      // depend on it; the payload is dropped), and `full` additionally
      // captures INITIAL_BOOTSTRAP/RECENT/FULL history for monitored
      // groups (opt-in backfill, requires a re-link).
      ...(this.historySyncMode === "off"
        ? {}
        : { browser: Browsers.windows("Desktop") }),
      syncFullHistory: this.historySyncMode === "full",
      shouldSyncHistoryMessage: (historyMsg) => {
        if (
          historyMsg.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND
        ) {
          return true;
        }
        // Some phones answer an on-demand request with RECENT/FULL and
        // echo OUR peer-data session id; allow those ONLY while the id is
        // an outstanding request (mapHistorySet still drops other chats).
        const sessionId = stringOrNull(historyMsg.peerDataRequestSessionId);
        if (
          sessionId !== null &&
          this.pendingHistoryRequestIds.has(sessionId)
        ) {
          return true;
        }
        if (this.historySyncMode === "off") return false;
        if (
          historyMsg.syncType ===
            proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
          historyMsg.syncType === proto.HistorySync.HistorySyncType.RECENT
        ) {
          return true;
        }
        return (
          this.historySyncMode === "full" &&
          historyMsg.syncType === proto.HistorySync.HistorySyncType.FULL
        );
      },
      // No decryption of non-group, non-self JIDs (DMs, newsletters,
      // status broadcasts, ...).
      shouldIgnoreJid: (jid) => isIgnoredIncomingJid(jid, readSelfUsers()),
      generateHighQualityLinkPreview: false,
    });

    // Race guard (CR): stop() raced socket creation — close the socket
    // created late so no orphan connection survives shutdown.
    if (this.stopping) {
      const late = this.socket;
      this.socket = null;
      try {
        late.end(undefined);
      } catch {
        // Already closed; nothing to release.
      }
      return;
    }

    this.socket.ev.on("creds.update", () => {
      this.queueSaveCreds();
    });
    this.socket.ev.on("connection.update", (update) => {
      this.onConnectionUpdate(update);
    });
    this.socket.ev.on("messages.upsert", (upsert) => {
      this.onMessagesUpsert(upsert);
    });
    this.socket.ev.on("groups.upsert", (groups) => {
      for (const group of groups) this.onGroupUpdate(group);
    });
    this.socket.ev.on("groups.update", (updates) => {
      for (const update of updates) this.onGroupUpdate(update);
    });
    this.socket.ev.on("group-participants.update", (update) => {
      this.onParticipantsUpdate(update);
    });
    this.socket.ev.on("contacts.upsert", (contacts) => {
      this.onContactsChanged(contacts);
    });
    this.socket.ev.on("contacts.update", (contacts) => {
      this.onContactsChanged(contacts);
    });
    this.socket.ev.on("messaging-history.set", (set) => {
      this.onHistorySet(set);
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.end(undefined);
      } catch {
        // Already closed; nothing to release.
      }
    }
    // Final serialized auth-state flush (creds.update already saves on
    // change; queued saves complete before this returns).
    this.queueSaveCreds();
    await this.saveChain;
  }

  async fetchChats(): Promise<DiscoveredChat[]> {
    const socket = this.socket;
    if (socket === null) throw new Error("not connected");
    // Saved-contact names live in the app-state `critical_unblock_low`
    // collection (verified in 6.7.24 Utils/chat-utils.js contactAction).
    // Bulk history sync is disabled, so Baileys' initial app-state sync
    // never runs; resync JUST that collection so the roster can resolve
    // saved names. Best-effort: a failure only means fewer names.
    //
    // `resyncAppState` is a buffered function: it activates the event
    // buffer and normally relies on the history-sync state machine to
    // flush it. We triggered it manually, so flush it ourselves unless
    // something else was already buffering (then that owner flushes).
    const wasBuffering = socket.ev.isBuffering();
    try {
      await socket.resyncAppState(["critical_unblock_low"], true);
    } catch (error) {
      this.options.log("warn", "contact_sync_failed", {
        reason: errorReason(error),
      });
    } finally {
      if (!wasBuffering) socket.ev.flush();
    }
    // groupFetchAllParticipating returns full GroupMetadata per chat —
    // including the participants roster (verified in the installed
    // 6.7.24 types: GroupMetadata.participants: GroupParticipant[]).
    const participating = await socket.groupFetchAllParticipating();
    const chats: DiscoveredChat[] = [];
    for (const [jid, metadata] of Object.entries(participating)) {
      if (!jid.endsWith("@g.us")) continue;
      const name = stringOrNull(metadata?.subject) ?? jid;
      const members = mapGroupParticipants(
        metadata?.participants ?? [],
        (participant) => this.resolveContactName(participant),
      );
      chats.push({ chatJid: jid, name, members });
    }
    return chats;
  }

  /**
   * Current roster for ONE chat via `groupMetadata(jid)`
   * (verified: `(jid: string) => Promise<GroupMetadata>`). Best-effort:
   * an unavailable metadata yields [] (never an error) so roster syncs
   * can never fail the surrounding flows (ADR 0008).
   */
  async fetchRoster(chatJid: string): Promise<GroupMemberInfo[]> {
    const socket = this.socket;
    if (socket === null) return [];
    try {
      const metadata = await socket.groupMetadata(chatJid);
      return mapGroupParticipants(
        metadata?.participants ?? [],
        (participant) => this.resolveContactName(participant),
      );
    } catch (error) {
      this.options.log("warn", "roster_fetch_failed", {
        chatRef: safeChatRef(chatJid),
        reason: errorReason(error),
      });
      return [];
    }
  }

  /**
   * Live session health probe: the socket must be open and a lightweight
   * USync status query must succeed. Returns a safe code, never message
   * content or credentials.
   */
  async checkSession(): Promise<SessionCheckResult> {
    const socket = this.socket;
    if (socket === null) {
      return { ok: false, latencyMs: 0, error: "not_connected" };
    }
    const meJid = stringOrNull(socket.authState.creds.me?.id);
    if (meJid === null) {
      return { ok: false, latencyMs: 0, error: "not_authenticated" };
    }
    const started = Date.now();
    try {
      if (!socket.ws.isOpen) throw new Error("socket_closed");
      await socket.fetchStatus(meJid);
      return { ok: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: errorReason(error).slice(0, 200),
      };
    }
  }

  /**
   * Requests on-demand history for ONE chat (ADR 0007).
   *
   * Verified Baileys 6.7.24 surface (Socket/messages-recv.js:707):
   *   fetchMessageHistory(
   *     count: number,
   *     oldestMsgKey: WAMessageKey,
   *     oldestMsgTimestamp: number | Long,   // used as MILLISECONDS
   *   ): Promise<string>                      // relayed request msg id
   * It builds a `historySyncOnDemandRequest`
   * `{ chatJid, oldestMsgFromMe, oldestMsgId, oldestMsgTimestampMs,
   * onDemandMsgCount }` via a peer-data-operation message. Results come
   * back asynchronously as `messaging-history.set` events (delivered as
   * device-to-self historySyncNotification protocol messages, whose
   * `peerDataRequestSessionId` is forwarded on our `history` events).
   */
  async requestHistory(request: HistoryFetchRequest): Promise<string> {
    const socket = this.socket;
    if (socket === null) throw new Error("not connected");
    const cursor = request.cursor;
    // Empty cursor (= first round) asks for the newest available
    // history; subsequent rounds page backwards from the oldest message
    // already received. Exact WhatsApp cursor semantics are documented
    // as unverified in ADR 0007 (no live account in tests).
    const oldestKey = {
      remoteJid: request.chatJid,
      fromMe: cursor?.fromMe ?? false,
      id: cursor?.messageId ?? "",
    };
    const oldestTimestampMs = cursor !== null ? cursor.timestampSec * 1000 : 0;
    // WhatsApp accepts at most 50 messages per on-demand query (Baileys
    // README); larger counts are silently ignored.
    const count = Math.min(Math.max(1, Math.trunc(request.count)), 50);
    this.pendingHistoryChats.add(request.chatJid);
    try {
      const requestId = await socket.fetchMessageHistory(
        count,
        oldestKey,
        oldestTimestampMs,
      );
      // Kept for log-only correlation of the responses (SA-M3).
      this.pendingHistoryRequestIds.set(requestId, request.chatJid);
      return requestId;
    } catch (error) {
      this.pendingHistoryChats.delete(request.chatJid);
      throw error;
    }
  }

  /** Stops filtering for a chat's history batches (import finished). */
  releaseHistoryChat(chatJid: string): void {
    this.pendingHistoryChats.delete(chatJid);
    for (const [requestId, chat] of this.pendingHistoryRequestIds) {
      if (chat === chatJid) this.pendingHistoryRequestIds.delete(requestId);
    }
  }

  /** Updates the monitored chats eligible for initial history capture. */
  setHistoryCaptureChats(chatJids: ReadonlySet<string>): void {
    this.historyCaptureChats.clear();
    for (const chatJid of chatJids) this.historyCaptureChats.add(chatJid);
  }

  /**
   * Admin logout (ADR 0008). Verified Baileys surface:
   * `logout(msg?: string) => Promise<void>` (Socket/socket.js:327) sends
   * `remove-companion-device` — revoking the linked device server-side —
   * then ends the socket with a `loggedOut` close. It does NOT delete
   * the local auth state: the CALLER purges the session files after this
   * resolves or times out (session-control, M-1), so a stalled network
   * can never retain credentials. Idempotent.
   */
  async logout(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        await socket.logout();
      } catch (error) {
        this.options.log("warn", "remote_logout_failed", {
          reason: errorReason(error),
        });
        try {
          socket.end(undefined);
        } catch {
          // Already closed; nothing to release.
        }
      }
    }
    // Disable credential saves so a late creds.update cannot re-create
    // auth files while the caller purges them.
    this.saveCreds = null;
    await this.saveChain;
  }

  private onHistorySet(set: HistorySetPayload): void {
    if (this.stopping) return;
    // Contact names travel with history payloads; cache them even when
    // the batch contains no messages for an outstanding request.
    this.onContactsChanged(set.contacts ?? []);
    // No outstanding on-demand request: this is the connect-time sync.
    if (this.pendingHistoryChats.size === 0) {
      if (this.historySyncMode === "off") return;
      const syncType = set.syncType ?? null;
      if (this.historySyncMode === "recent") {
        // Let WhatsApp's state machine complete, but never persist or
        // surface unrequested history (privacy boundary, ADR 0004).
        this.options.log("debug", "history_initial_dropped", {
          syncType,
          messages: set.messages.length,
        });
        return;
      }
      // "full": opt-in backfill for MONITORED groups only. The adapter
      // filters before mapping, so other chats' content is never parsed.
      const events = mapHistorySet(set, this.historyCaptureChats, "initial");
      let captured = 0;
      for (const event of events) {
        captured += event.messages.length;
        for (const message of event.messages) {
          this.rememberContact({
            id: message.senderJid,
            notify: message.senderName,
          });
        }
        this.emit(event);
      }
      this.options.log("debug", "history_initial_captured", {
        syncType,
        messages: set.messages.length,
        chats: events.length,
        captured,
      });
      return;
    }
    // SA-M3 (LOG-ONLY for now): correlate to OUR request ids.
    // TODO(live-verify): ENFORCEMENT is pending live verification — the
    // peerDataRequestSessionId echo behavior is unverified against a
    // real account, so an absent/differing id is logged but processed
    // (ADR 0007).
    const correlation = classifyHistoryCorrelation(
      stringOrNull(set.peerDataRequestSessionId),
      new Set(this.pendingHistoryRequestIds.keys()),
    );
    if (correlation !== "match") {
      this.options.log("warn", "history_payload_unverified", {
        reason: correlation,
      });
    }
    for (const event of mapHistorySet(
      set,
      this.pendingHistoryChats,
      "on-demand",
    )) {
      for (const message of event.messages) {
        this.rememberContact({ id: message.senderJid, notify: message.senderName });
      }
      this.emit(event);
    }
  }

  /**
   * Merges name fields from a contact event into the alias cache and
   * emits the resulting names so the service can persist them on the
   * roster. Names are PII: this method never logs them.
   */
  private onContactsChanged(
    contacts: ReadonlyArray<{
      id?: string | null;
      jid?: string | null;
      lid?: string | null;
      name?: string | null;
      notify?: string | null;
      verifiedName?: string | null;
    }>,
  ): void {
    if (this.stopping || contacts.length === 0) return;
    const updates: ContactNameUpdate[] = [];
    for (const contact of contacts) {
      const update = this.rememberContact(contact);
      if (update !== null) updates.push(update);
    }
    if (updates.length > 0) {
      this.emit({ type: "contact-names", contacts: updates });
    }
  }

  /**
   * Stores a contact's name fields under every alias it exposes and
   * returns the best resulting name, or null when the contact carries
   * no name. Later partial updates merge with earlier fields, so a
   * push-name update never erases a saved contact name.
   */
  private rememberContact(contact: {
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
  }): ContactNameUpdate | null {
    const fields = contactFields(contact);
    if (
      fields.notify === undefined &&
      fields.name === undefined &&
      fields.verifiedName === undefined
    ) {
      return null;
    }
    const aliases = contactAliases(contact);
    if (aliases.length === 0) return null;
    let best: string | null = null;
    let changed = false;
    for (const alias of aliases) {
      const previous = this.contacts.get(alias);
      const merged: ContactFields = { ...previous, ...fields };
      const previousName = previous === undefined ? null : bestContactName(previous);
      const mergedName = bestContactName(merged);
      if (mergedName !== previousName) changed = true;
      this.contacts.set(alias, merged);
      best = mergedName ?? best;
    }
    // Re-emit only when something changed: Baileys repeats the same
    // push name on every message, and each emit is a DB write.
    return best === null || !changed ? null : { jids: aliases, name: best };
  }

  /**
   * Resolves a participant's display name from the contact cache using
   * any of its JID aliases (participant id, PN jid, lid). Null when no
   * name has been observed yet.
   */
  private resolveContactName(participant: {
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
  }): string | null {
    for (const jid of [participant.id, participant.jid, participant.lid]) {
      const alias = normalizeJidAlias(jid);
      if (alias === null) continue;
      const fields = this.contacts.get(alias);
      if (fields === undefined) continue;
      const name = bestContactName(fields);
      if (name !== null) return name;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Baileys event translation
  // ------------------------------------------------------------------

  private onConnectionUpdate(update: Partial<BaileysConnectionState>): void {
    if (this.stopping) return;
    if (typeof update.qr === "string" && update.qr !== "") {
      this.onQr(update.qr);
    }
    if (update.connection === "connecting") {
      this.emit({ type: "connecting" });
    } else if (update.connection === "open") {
      this.emit({ type: "open" });
    } else if (update.connection === "close") {
      const statusCode = disconnectStatusCode(update.lastDisconnect?.error);
      const { retryable, reason } = classifyClose(statusCode);
      this.emit({ type: "close", retryable, reason });
    }
  }

  private onQr(qr: string): void {
    const phoneNumber = this.options.phoneNumber;
    if (
      phoneNumber !== undefined &&
      phoneNumber !== null &&
      phoneNumber !== "" &&
      !this.pairingCodeFailed
    ) {
      // Pairing-code linking (stretch, ADR 0004): request the code and
      // show it instead of the QR. CR#6: the latch expires with the
      // published code — a QR arriving past the TTL starts a FRESH
      // pairing flow instead of dead-ending on a stale one.
      const ttlMs = this.options.pairingCodeTtlMs ?? PAIRING_CODE_TTL_MS;
      if (pairingFlowExpired(this.pairingRequestedAt, Date.now(), ttlMs)) {
        this.pairingRequested = false;
        this.pairingRequestedAt = null;
      }
      if (this.pairingRequested) return;
      this.pairingRequested = true;
      this.pairingRequestedAt = Date.now();
      void this.requestPairingCode(phoneNumber, qr);
      return;
    }
    this.emit({ type: "qr", qr });
  }

  private async requestPairingCode(
    phoneNumber: string,
    fallbackQr: string,
  ): Promise<void> {
    try {
      const code = await this.socket?.requestPairingCode(phoneNumber);
      if (typeof code !== "string" || code === "") {
        throw new Error("empty pairing code");
      }
      this.emit({ type: "pairing-code", code });
    } catch (error) {
      // Never leave the operator without a way to link: fall back to the
      // QR now, and let every FRESH QR through afterwards (a QR expires
      // within ~20s and must be replaced by a newer one — forwarding
      // only this stale fallback would leave the operator stuck).
      this.pairingCodeFailed = true;
      this.options.log("warn", "pairing_code_failed", {
        reason: errorReason(error),
      });
      this.emit({ type: "qr", qr: fallbackQr });
    }
  }

  private onMessagesUpsert(upsert: {
    messages: WAMessage[];
    type: string;
  }): void {
    // Both live ("notify") and replayed ("append") upserts flow through
    // the same idempotent capture path (ADR 0004): duplicates count as
    // already captured, and history sync is disabled anyway.
    const messages: RawInboundMessage[] = [];
    for (const message of upsert.messages) {
      // An on-demand history response is a PDO response message;
      // Baileys ignores its result code, so surface it here instead of
      // letting the import burn the full round timeout.
      const historyResponse = mapHistoryResponse(message);
      if (historyResponse !== null) {
        const chatJid =
          (historyResponse.requestId === null
            ? undefined
            : this.pendingHistoryRequestIds.get(historyResponse.requestId)) ??
          (this.pendingHistoryChats.size === 1
            ? [...this.pendingHistoryChats][0]
            : undefined);
        if (chatJid !== undefined) {
          if (historyResponse.kind === "failure") {
            this.emit({
              type: "history-error",
              chatJid,
              reason: historyResponse.reason ?? "history_unavailable",
            });
          } else {
            this.emit({ type: "history-success", chatJid });
          }
        }
      }
      // Cache the sender's push name even if the message itself is
      // skipped (reaction/system): it is the main name source for
      // unsaved contacts in LID-addressed groups.
      if (message.key?.fromMe !== true) {
        this.rememberContact({
          id: stringOrNull(message.key?.participant) ?? stringOrNull(message.key?.remoteJid),
          notify: message.pushName,
        });
      }
      const mapped = mapWAMessage(message);
      if (mapped !== null) messages.push(mapped);
    }
    if (messages.length > 0) {
      this.emit({ type: "messages", messages });
    }
  }

  private onGroupUpdate(group: Partial<GroupMetadata>): void {
    // Only meaningful subject updates: a missing subject must never
    // overwrite a registered group name with its JID (ADR 0004).
    const chatJid = stringOrNull(group.id);
    const name = stringOrNull(group.subject);
    if (chatJid === null || name === null || !chatJid.endsWith("@g.us")) {
      return;
    }
    this.emit({ type: "chat-updated", chat: { chatJid, name, members: [] } });
  }

  private onParticipantsUpdate(update: {
    id?: string | null;
    participants?: string[] | null;
    action?: string | null;
  }): void {
    if (this.stopping) return;
    const chatJid = stringOrNull(update.id);
    if (chatJid === null || !chatJid.endsWith("@g.us")) return;
    const participants = (update.participants ?? [])
      .map((jid) => stringOrNull(jid))
      .filter((jid): jid is string => jid !== null);
    this.emit({
      type: "participants",
      chatJid,
      action: normalizeParticipantsAction(update.action),
      participants,
    });
  }

  private async resolveVersion(): Promise<WAVersion | undefined> {
    // Opt-in egress (audit L6): the version manifest fetch phones home on
    // every connect and lets a third party influence the protocol
    // version. By default the WhatsApp Web version bundled with the
    // pinned Baileys release is used (undefined = Baileys default).
    if (this.options.checkForUpdates !== true) return undefined;
    try {
      const { version } = await fetchLatestBaileysVersion();
      return version;
    } catch (error) {
      // Offline or GitHub unreachable: fall back to the bundled version.
      this.options.log("warn", "baileys_version_fetch_failed", {
        reason: errorReason(error),
      });
      return undefined;
    }
  }
}
