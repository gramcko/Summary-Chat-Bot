import { createHash, randomUUID } from "node:crypto";
import {
  Id,
  type ApiMessage,
  type ConnectionLinking,
  type ConnectionStatus,
  type ContactDetail,
  type ContactMessage,
  type ContactSummary,
  type DateFormat,
  type Group,
  type GroupMember,
  type GroupSummary,
  type Interval,
  type RunKind,
  type Summary,
  type SummaryRun,
} from "@summarly/contracts";

export interface AdminRecord {
  passwordHash: string;
  recoveryCodeHashes: Set<string>;
}

export interface ProviderRecord {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Server-side only. Never part of any API response. */
  apiKey: string | null;
}

export interface CreateRunInput {
  groupId: string;
  interval: Interval;
  kind: RunKind;
  /**
   * Admin custom summary instructions (ADR 0008); omitted/undefined
   * stores NULL. The FIRST request's instructions win on a repeated
   * create-or-find, like the timezone label — run identity is
   * (group, interval, kind) and does not include them.
   */
  instructions?: string | null;
}

/** Membership upsert entry (system fields come from the store). */
export interface GroupMemberInput {
  userId: string;
  name: string | null;
  /** PN JID fallback when known (null for LID-only members). */
  phone: string | null;
  isAdmin: boolean;
  active: boolean;
}

/** Newest-first message listing (ADR 0008). `cursor` is opaque text. */
export interface ListMessagesOptions {
  /** Inclusive lower bound (ISO instant). */
  from?: string;
  /** Exclusive upper bound (ISO instant) — half-open [from, to). */
  to?: string;
  limit: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

/** Cursor = `<sentAt ISO>|<message id>`; undefined when invalid. */
export function decodeMessageCursor(
  cursor: string,
): { sentAt: string; id: string } | undefined {
  const separator = cursor.indexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) return undefined;
  const sentAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  // The id MUST be a contract `Id` (UUID): anything else is a malformed
  // cursor — a 400 at the route, never a `::uuid` cast error in SQL
  // (fix round A, audit L-4).
  if (!Number.isFinite(Date.parse(sentAt)) || !Id.safeParse(id).success) {
    return undefined;
  }
  return { sentAt, id };
}

export function encodeMessageCursor(message: {
  sentAt: string;
  id: string;
}): string {
  return `${message.sentAt}|${message.id}`;
}

/**
 * Linking-visibility rule (fix round A, audit M-4): the pairing ticket
 * is served ONLY while the session is actually being linked — state
 * `connecting` or `disconnected` — AND the payload has not expired.
 * Both stores route through this helper so they cannot drift.
 */
export function servedLinking(
  state: string,
  linking: ConnectionLinking | null,
  nowMs: number = Date.now(),
): ConnectionLinking | null {
  if (linking === null) return null;
  if (state !== "connecting" && state !== "disconnected") return null;
  return Date.parse(linking.expiresAt) > nowMs ? linking : null;
}

/**
 * Run identity key: (group, start instant, end instant, kind) — the
 * exact tuple protected by the database's UNIQUE constraint. The
 * timezone label is deliberately excluded (presentation metadata).
 */
export function runIdentity(input: CreateRunInput): string {
  return `${input.groupId}|${Date.parse(input.interval.start)}|${Date.parse(input.interval.end)}|${input.kind}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Session tokens are opaque random secrets carried by the cookie. Only a
 * SHA-256 hash of the token is ever persisted (admin_sessions.token_hash),
 * so a database leak does not yield usable sessions.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Persistence boundary for everything the API reads or writes. The
 * in-memory implementation keeps the skeleton testable; PostgresStore is
 * the durable implementation (PostgreSQL is the source of truth per
 * docs/decisions/0001). Routes must depend on this interface only.
 */
export interface Store {
  // ---- Admin credentials (single administrator) ----
  getAdmin(): Promise<AdminRecord | null>;
  /**
   * First-run setup: insert-only. Returns true when the record was
   * created and false when an administrator already exists — concurrent
   * setup attempts must never overwrite each other (one caller wins).
   */
  setAdmin(record: AdminRecord): Promise<boolean>;
  /**
   * Atomically replaces the password hash — and, when provided, rotates
   * the recovery-code hashes — and deletes ALL sessions in the same
   * statement/transaction. Password changes and resets must never leave
   * sessions alive after a partial failure.
   */
  updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void>;
  /**
   * Single-use recovery: removes the consumed code, sets the new
   * password hash, and evicts all sessions atomically. Returns false
   * when the code is unknown.
   */
  consumeRecoveryCode(codeHash: string, newPasswordHash: string): Promise<boolean>;

  // ---- Sessions (implementations persist only token hashes) ----
  createSession(token: string): Promise<void>;
  validateSession(token: string): Promise<boolean>;
  deleteSession(token: string): Promise<void>;
  clearSessions(): Promise<void>;

  // ---- Monitored groups ----
  listGroups(): Promise<Group[]>;
  getGroup(id: string): Promise<Group | undefined>;
  /**
   * Full replacement of the MUTABLE (admin-preference) group fields.
   * Undefined when unknown. The system-managed `historyImport` state is
   * NOT mutable here — it is always preserved untouched (ADR 0007).
   */
  updateGroup(group: Group): Promise<Group | undefined>;
  /**
   * Natural-key registration for discovered chats. When `chatId` is
   * provided it is the identity: repeated upserts of the same chat keep
   * the stored id (so run/message foreign keys stay stable) and update
   * ONLY the name — never-clobber (ADR 0004 / audit M3): monitored,
   * timezone, and summary_time are admin preferences and are never
   * overwritten here (updateGroup is the only admin-preference writer).
   * Without a chatId the id is the key (insert or full replace of the
   * mutable fields). The system-managed `historyImport` state is always
   * preserved: discovery must never reset an import (ADR 0007).
   */
  upsertGroup(group: Group): Promise<Group>;
  /**
   * Requests a history import for the group (ADR 0007): transitions the
   * system-managed state to `pending` and resets its progress fields
   * (startedAt/finishedAt null, importedCount 0, error null). Undefined
   * when the group is unknown. The result reports whether THIS call
   * performed the transition (`changed`) — the route derives 202
   * (changed) from 200 (an import is already in flight, the returned
   * group is unchanged). A no-op while `pending`/`running`; repeated
   * requests after `done`/`failed` are accepted. The ROUTE enforces the
   * "must be monitored" rule.
   */
  requestHistoryImport(
    groupId: string,
  ): Promise<{ group: Group; changed: boolean } | undefined>;
  /**
   * Cancels a PENDING history import by clearing the system-managed
   * state (status/timestamps/error to null, count to 0). Returns true
   * when a pending import was actually cleared. `running` imports are
   * NEVER touched — the bot-worker aborts those itself (SA-M1: an
   * un-monitored group's consent to import history is revoked).
   */
  cancelPendingHistoryImport(groupId: string): Promise<boolean>;

  // ---- Group detail data (ADR 0008) ----
  /**
   * Best-effort roster refresh for a chat (bot-worker's discovery
   * shape): upserts by (chatId, userId), updating name/isAdmin/active.
   * Leavers are marked `active: false` by the caller — rows are kept
   * as history, never deleted here.
   */
  upsertGroupMembers(
    chatId: string,
    members: GroupMemberInput[],
  ): Promise<void>;
  /** Members of a chat, admin names first then alphabetical. */
  listGroupMembers(chatId: string): Promise<GroupMember[]>;
  /**
   * Captured messages of a chat for the admin chat view: newest first
   * over the half-open date range [from, to), `limit` rows per page.
   * `cursor` is the `nextCursor` of the previous page (opaque).
   */
  listGroupMessages(
    chatId: string,
    options: ListMessagesOptions,
  ): Promise<ApiMessage[]>;
  /**
   * Contacts derived from MONITORED groups: people who are currently
   * active members, aggregated by canonical identity (PN JID when
   * known, else LID). Includes the groups they belong to and their
   * message volume. PII — authenticated admin API only.
   */
  listContacts(): Promise<ContactSummary[]>;
  /** One contact by canonical id, or undefined. Includes its aliases. */
  getContact(contactId: string): Promise<ContactDetail | undefined>;
  /**
   * Sets an admin display-name override for a contact (wins over roster
   * names and survives automatic refreshes). Returns the updated contact,
   * or undefined when the contact is not on a monitored roster.
   */
  renameContact(
    contactId: string,
    name: string,
  ): Promise<ContactDetail | undefined>;
  /**
   * Messages sent by a contact across monitored groups, newest first.
   * `aliases` are the contact's JID forms (LID/PN); device suffixes on
   * stored sender ids are normalized before matching.
   */
  listContactMessages(
    aliases: readonly string[],
    options: ListMessagesOptions,
  ): Promise<ContactMessage[]>;
  /**
   * Past summaries of a GROUP (summary runs join by group id — a group
   * without a discovered chat can still have scheduled runs), newest
   * first, each with the run interval.
   */
  listGroupSummaries(
    groupId: string,
    options: { limit: number },
  ): Promise<GroupSummary[]>;

  // ---- Summary runs ----
  /**
   * Create-or-find semantics: a request for the same group, half-open
   * interval (compared as instants), and kind returns the existing run
   * instead of creating a duplicate. The first request's timezone label
   * is kept on the run; the label is presentation metadata, not identity.
   */
  createOrFindRun(input: CreateRunInput): Promise<{ run: SummaryRun; created: boolean }>;
  /**
   * Read-only identity lookup (group, interval instants, kind) — used
   * by the scheduler to ask "does a run already exist for this
   * window?" WITHOUT creating one. Undefined when there is none.
   */
  findRunByIdentity(input: CreateRunInput): Promise<SummaryRun | undefined>;
  getRun(id: string): Promise<SummaryRun | undefined>;
  /** Newest first. */
  listRuns(): Promise<SummaryRun[]>;
  /** Replaces the mutable run fields (status, attempts, error, updatedAt). */
  updateRun(run: SummaryRun): Promise<SummaryRun>;

  // ---- Summaries ----
  /**
   * Idempotent write keyed by runId (one summary per run): a repeated
   * write for the same run replaces the result and returns the stored
   * summary with its original id/createdAt.
   */
  saveSummary(summary: Summary): Promise<Summary>;
  getSummary(id: string): Promise<Summary | undefined>;
  getSummaryByRunId(runId: string): Promise<Summary | undefined>;

  // ---- AI provider configuration ----
  /** apiKey is server-side only; routes mask it before responding. */
  getProviderConfig(): Promise<ProviderRecord | null>;
  setProviderConfig(record: ProviderRecord): Promise<ProviderRecord>;

  // ---- Global settings ----
  /** IANA zone used for new groups and the summary form's initial value. */
  getDefaultTimezone(): Promise<string>;
  setDefaultTimezone(timezone: string): Promise<string>;
  /** Display date format for generic dashboard timestamps. */
  getDefaultDateFormat(): Promise<DateFormat>;
  setDefaultDateFormat(dateFormat: DateFormat): Promise<DateFormat>;

  // ---- WhatsApp connection status (non-secret) ----
  getConnectionStatus(): Promise<ConnectionStatus>;
  setConnectionStatus(status: ConnectionStatus): Promise<void>;
  /**
   * Requests a live WhatsApp session health check. Sets the request
   * timestamp and clears any previous result; the bot-worker performs
   * the bounded probe and writes the outcome.
   */
  requestSessionCheck(): Promise<void>;
  /**
   * Sets (or clears with null) the pairing QR / payload displayed by
   * the bot-worker (ADR 0008). The QR is a live pairing ticket: it is
   * served only on the authenticated API and must never be logged.
   * Writing does NOT touch `logout_requested_at`.
   */
  updateConnectionLinking(
    linking: {
      qr: string;
      expiresAt: string;
      /** Pairing payload kind (bot-worker publishes it); default qr. */
      kind?: ConnectionLinking["kind"];
    } | null,
  ): Promise<void>;
  /**
   * Records the admin's "end / unlink session" request
   * (logout_requested_at = now()). Idempotent: an already-pending
   * request keeps its original timestamp. The bot-worker consumes the
   * flag and clears it via {@link clearLogoutRequest}.
   */
  requestLogout(): Promise<void>;
  /** Clears the consumed logout request (bot-worker side). */
  clearLogoutRequest(): Promise<void>;
}

/**
 * TEMPORARY in-memory persistence for the skeleton milestone.
 * PostgreSQL is the source of truth (docs/decisions/0001); this class is
 * superseded by PostgresStore for the running application. Nothing stored
 * here is durable across restarts. Behavior is kept identical to the
 * original skeleton store so the existing test suite passes unchanged
 * in meaning.
 */
export class InMemoryStore implements Store {
  private admin: AdminRecord | null = null;
  private readonly sessions = new Map<string, { createdAt: string }>();
  private readonly groups = new Map<string, Group>();
  private readonly runs = new Map<string, SummaryRun>();
  private readonly runsByIdentity = new Map<string, string>();
  private readonly summaries = new Map<string, Summary>();
  private readonly summariesByRunId = new Map<string, string>();
  private provider: ProviderRecord | null = null;
  private defaultTimezone = "UTC";
  private defaultDateFormat: DateFormat = "DD/MM/YYYY";
  private connection: ConnectionStatus = {
    state: "unavailable",
    since: nowIso(),
    lastMessageAt: null,
    linking: null,
    check: null,
  };
  private logoutRequestedAt: string | null = null;
  private readonly members = new Map<string, Map<string, GroupMember>>();
  private readonly messageLog: ApiMessage[] = [];
  /** Admin display-name overrides keyed by canonical contact id. */
  private readonly contactOverrides = new Map<string, string>();

  async getAdmin(): Promise<AdminRecord | null> {
    return this.admin;
  }

  async setAdmin(record: AdminRecord): Promise<boolean> {
    // Insert-only: concurrent setup attempts must not overwrite each other.
    if (this.admin !== null) return false;
    this.admin = record;
    return true;
  }

  async updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void> {
    const admin = this.admin;
    if (admin === null) return;
    admin.passwordHash = input.passwordHash;
    if (input.recoveryCodeHashes !== undefined) {
      admin.recoveryCodeHashes = input.recoveryCodeHashes;
    }
    this.sessions.clear();
  }

  async consumeRecoveryCode(codeHash: string, newPasswordHash: string): Promise<boolean> {
    const admin = this.admin;
    if (admin === null || !admin.recoveryCodeHashes.has(codeHash)) return false;
    admin.recoveryCodeHashes.delete(codeHash);
    admin.passwordHash = newPasswordHash;
    this.sessions.clear();
    return true;
  }

  async createSession(token: string): Promise<void> {
    this.sessions.set(hashSessionToken(token), { createdAt: nowIso() });
  }

  async validateSession(token: string): Promise<boolean> {
    return this.sessions.has(hashSessionToken(token));
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(hashSessionToken(token));
  }

  async clearSessions(): Promise<void> {
    this.sessions.clear();
  }

  async listGroups(): Promise<Group[]> {
    return [...this.groups.values()];
  }

  async getGroup(id: string): Promise<Group | undefined> {
    return this.groups.get(id);
  }

  async updateGroup(group: Group): Promise<Group | undefined> {
    const existing = this.groups.get(group.id);
    if (existing === undefined) return undefined;
    // Admin preferences only: the system-managed history-import state
    // is preserved untouched (ADR 0007) — even if a caller passes one,
    // this writer can never alter it.
    const stored: Group = { ...group, historyImport: existing.historyImport };
    this.groups.set(group.id, stored);
    return stored;
  }

  async upsertGroup(group: Group): Promise<Group> {
    // Natural key is chatId when provided (see Store.upsertGroup): the
    // stored id wins so foreign keys stay stable across rediscovery, and
    // ONLY the name is updated — never-clobber (ADR 0004): admin
    // preferences (monitored/timezone/summaryTime) survive re-registration.
    if (group.chatId !== null) {
      for (const [id, existing] of this.groups) {
        if (existing.chatId === group.chatId) {
          const stored: Group = { ...existing, name: group.name };
          this.groups.set(id, stored);
          return stored;
        }
      }
    }
    // Id key: insert or full replace of the MUTABLE fields. An existing
    // row keeps its system-managed history-import state (discovery and
    // re-registration must never reset an import — ADR 0007).
    const existingById = this.groups.get(group.id);
    const stored: Group =
      existingById === undefined
        ? group
        : { ...group, historyImport: existingById.historyImport };
    this.groups.set(group.id, stored);
    return stored;
  }

  async requestHistoryImport(
    groupId: string,
  ): Promise<{ group: Group; changed: boolean } | undefined> {
    const existing = this.groups.get(groupId);
    if (existing === undefined) return undefined;
    const current = existing.historyImport;
    if (
      current !== null &&
      (current.status === "pending" || current.status === "running")
    ) {
      // Idempotent: an import in flight is never restarted (ADR 0007).
      return { group: existing, changed: false };
    }
    const stored: Group = {
      ...existing,
      historyImport: {
        status: "pending",
        requestedAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        importedCount: 0,
        error: null,
      },
    };
    this.groups.set(groupId, stored);
    return { group: stored, changed: true };
  }

  async cancelPendingHistoryImport(groupId: string): Promise<boolean> {
    const existing = this.groups.get(groupId);
    if (existing?.historyImport?.status !== "pending") return false;
    // Pending only: a `running` import is aborted by the bot-worker
    // itself; done/failed states are history and stay (SA-M1).
    this.groups.set(groupId, { ...existing, historyImport: null });
    return true;
  }

  async upsertGroupMembers(
    chatId: string,
    members: GroupMemberInput[],
  ): Promise<void> {
    const roster = this.members.get(chatId) ?? new Map<string, GroupMember>();
    for (const member of members) {
      const existing = roster.get(member.userId);
      roster.set(member.userId, {
        userId: member.userId,
        // COALESCE parity with the SQL writer (fix round A, m9): a
        // refresh without a display name (Baileys group metadata
        // carries only JIDs) must never wipe a name learned from a
        // message pushName.
        name: member.name ?? existing?.name ?? null,
        phone: member.phone ?? existing?.phone ?? null,
        isAdmin: member.isAdmin,
        active: member.active,
        updatedAt: nowIso(),
      });
    }
    this.members.set(chatId, roster);
  }

  async listGroupMembers(chatId: string): Promise<GroupMember[]> {
    const roster = this.members.get(chatId);
    if (roster === undefined) return [];
    // Admins first, then name (nulls last, mirroring the SQL ORDER BY),
    // then stable by userId.
    return [...roster.values()].sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return Number(b.isAdmin) - Number(a.isAdmin);
      if (a.name === null && b.name !== null) return 1;
      if (a.name !== null && b.name === null) return -1;
      if (a.name !== null && b.name !== null && a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      return a.userId.localeCompare(b.userId);
    });
  }

  /** Test seam: capture writes belong to bot-worker in production. */
  seedMessages(messages: ApiMessage[]): void {
    this.messageLog.push(...messages);
  }

  async listGroupMessages(
    chatId: string,
    options: ListMessagesOptions,
  ): Promise<ApiMessage[]> {
    const from = options.from === undefined ? -Infinity : Date.parse(options.from);
    const to = options.to === undefined ? Infinity : Date.parse(options.to);
    const cursor =
      options.cursor === undefined
        ? undefined
        : decodeMessageCursor(options.cursor);
    // A provided cursor that does not decode is a caller bug: throw
    // instead of silently returning page 1 (the route validates first
    // and answers 400 — this is the store-level backstop).
    if (options.cursor !== undefined && cursor === undefined) {
      throw new Error("invalid message cursor");
    }
    const cursorSentAtMs =
      cursor === undefined ? Infinity : Date.parse(cursor.sentAt);
    const matching = this.messageLog.filter(
      (message) =>
        message.chatId === chatId &&
        Date.parse(message.sentAt) >= from &&
        Date.parse(message.sentAt) < to &&
        (cursor === undefined ||
          Date.parse(message.sentAt) < cursorSentAtMs ||
          // Keyset tie-break at EQUAL INSTANTS — compared as instants,
          // not strings, so equivalent spellings ("...Z" vs "+02:00")
          // land on the same side of the cursor (fix round A, m2).
          (Date.parse(message.sentAt) === cursorSentAtMs &&
            message.id < cursor.id)),
    );
    matching.sort(
      (a, b) =>
        Date.parse(b.sentAt) - Date.parse(a.sentAt) ||
        // Plain string comparison = PostgreSQL uuid byte ordering for
        // canonical lowercase uuids (localeCompare would disagree).
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const roster = this.members.get(chatId);
    const normalize = (jid: string): string => jid.replace(/:.*@/, "@");
    // Roster-name fallback (mirrors the SQL LEFT JOIN): messages captured
    // before a name was learned still display the member's current name.
    // An admin contact override wins over both.
    return matching.slice(0, options.limit).map((message) => {
      if (roster === undefined) return message;
      const sender = normalize(message.senderId);
      const member =
        roster.get(sender) ??
        [...roster.values()].find(
          (candidate) => candidate.phone !== null && candidate.phone === sender,
        );
      const key = member === undefined ? undefined : (member.phone ?? member.userId);
      const override = key === undefined ? undefined : this.contactOverrides.get(key);
      const name = override ?? member?.name ?? message.senderName;
      return name === message.senderName ? message : { ...message, senderName: name };
    });
  }

  /**
   * Aggregated contacts derived from active members of monitored
   * groups. Kept in one helper so the list and detail endpoints cannot
   * disagree about identity, groups, or message counts.
   */
  private contactIndex(): Map<
    string,
    {
      id: string;
      name: string | null;
      phone: string | null;
      aliases: Set<string>;
      groups: Map<string, { id: string; name: string }>;
      messageCount: number;
      lastMessageAt: string | null;
    }
  > {
    const groupByChat = new Map(
      [...this.groups.values()]
        .filter((group) => group.monitored && group.chatId !== null)
        .map((group) => [group.chatId as string, group]),
    );
    const byKey = new Map<
      string,
      {
        id: string;
        name: string | null;
        phone: string | null;
        aliases: Set<string>;
        groups: Map<string, { id: string; name: string }>;
        messageCount: number;
        lastMessageAt: string | null;
      }
    >();
    for (const [chatId, roster] of this.members) {
      const group = groupByChat.get(chatId);
      if (group === undefined) continue;
      for (const member of roster.values()) {
        if (!member.active) continue;
        const key = member.phone ?? member.userId;
        const entry = byKey.get(key) ?? {
          id: key,
          name: null,
          phone: null,
          aliases: new Set<string>(),
          groups: new Map<string, { id: string; name: string }>(),
          messageCount: 0,
          lastMessageAt: null,
        };
        const override = this.contactOverrides.get(key);
        if (override !== undefined) entry.name = override;
        else if (member.name !== null) entry.name = member.name;
        if (member.phone !== null) entry.phone = member.phone;
        entry.aliases.add(member.userId);
        if (member.phone !== null) entry.aliases.add(member.phone);
        entry.groups.set(group.id, { id: group.id, name: group.name });
        byKey.set(key, entry);
      }
    }
    for (const message of this.messageLog) {
      if (message.chatId === undefined) continue;
      if (!groupByChat.has(message.chatId)) continue;
      const sender = message.senderId.replace(/:.*@/, "@");
      for (const entry of byKey.values()) {
        if (!entry.aliases.has(sender)) continue;
        entry.messageCount += 1;
        if (
          entry.lastMessageAt === null ||
          Date.parse(message.sentAt) > Date.parse(entry.lastMessageAt)
        ) {
          entry.lastMessageAt = message.sentAt;
        }
        break;
      }
    }
    return byKey;
  }

  async listContacts(): Promise<ContactSummary[]> {
    return [...this.contactIndex().values()]
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        phone: entry.phone,
        groups: [...entry.groups.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
        messageCount: entry.messageCount,
        lastMessageAt: entry.lastMessageAt,
      }))
      .sort((a, b) => {
        if (a.name === null && b.name !== null) return 1;
        if (a.name !== null && b.name === null) return -1;
        if (a.name !== null && b.name !== null && a.name !== b.name) {
          return a.name.localeCompare(b.name);
        }
        return a.id.localeCompare(b.id);
      });
  }

  async getContact(contactId: string): Promise<ContactDetail | undefined> {
    const entry = this.contactIndex().get(contactId);
    if (entry === undefined) return undefined;
    return {
      id: entry.id,
      name: entry.name,
      phone: entry.phone,
      groups: [...entry.groups.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      messageCount: entry.messageCount,
      lastMessageAt: entry.lastMessageAt,
      aliases: [...entry.aliases].sort(),
    };
  }

  async renameContact(
    contactId: string,
    name: string,
  ): Promise<ContactDetail | undefined> {
    const contact = await this.getContact(contactId);
    if (contact === undefined) return undefined;
    this.contactOverrides.set(contactId, name.trim().slice(0, 300));
    return this.getContact(contactId);
  }

  async listContactMessages(
    aliases: readonly string[],
    options: ListMessagesOptions,
  ): Promise<ContactMessage[]> {
    const from = options.from === undefined ? -Infinity : Date.parse(options.from);
    const to = options.to === undefined ? Infinity : Date.parse(options.to);
    const cursor =
      options.cursor === undefined
        ? undefined
        : decodeMessageCursor(options.cursor);
    if (options.cursor !== undefined && cursor === undefined) {
      throw new Error("invalid message cursor");
    }
    const cursorSentAtMs =
      cursor === undefined ? Infinity : Date.parse(cursor.sentAt);
    const groupByChat = new Map(
      [...this.groups.values()]
        .filter((group) => group.monitored && group.chatId !== null)
        .map((group) => [group.chatId as string, group]),
    );
    const normalizedAliases = new Set(
      aliases.map((alias) => alias.replace(/:.*@/, "@")),
    );
    const matching = this.messageLog.filter((message) => {
      if (message.chatId === undefined) return false;
      const group = groupByChat.get(message.chatId);
      if (group === undefined) return false;
      if (!normalizedAliases.has(message.senderId.replace(/:.*@/, "@"))) {
        return false;
      }
      const sentAt = Date.parse(message.sentAt);
      return (
        sentAt >= from &&
        sentAt < to &&
        (cursor === undefined ||
          sentAt < cursorSentAtMs ||
          (sentAt === cursorSentAtMs && message.id < cursor.id))
      );
    });
    matching.sort(
      (a, b) =>
        Date.parse(b.sentAt) - Date.parse(a.sentAt) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return matching.slice(0, options.limit).map((message) => {
      const group = groupByChat.get(message.chatId as string);
      const roster = this.members.get(message.chatId as string);
      const sender = message.senderId.replace(/:.*@/, "@");
      const member =
        roster?.get(sender) ??
        [...(roster?.values() ?? [])].find(
          (candidate) => candidate.phone !== null && candidate.phone === sender,
        );
      const key = member === undefined ? undefined : (member.phone ?? member.userId);
      const override = key === undefined ? undefined : this.contactOverrides.get(key);
      return {
        ...message,
        senderName: override ?? member?.name ?? message.senderName,
        groupId: group?.id ?? "",
        groupName: group?.name ?? "",
      };
    });
  }

  async listGroupSummaries(
    groupId: string,
    options: { limit: number },
  ): Promise<GroupSummary[]> {
    const items: GroupSummary[] = [];
    for (const summary of this.summaries.values()) {
      const run = this.runs.get(summary.runId);
      if (run === undefined || run.groupId !== groupId) continue;
      items.push({ ...summary, interval: run.interval });
    }
    items.sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
    return items.slice(0, options.limit);
  }

  async createOrFindRun(
    input: CreateRunInput,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    // Identity compares instants, not timestamp strings: equivalent
    // formats (e.g. "...Z" vs "+02:00") map to the same run. The
    // timezone label is presentation metadata, not part of identity —
    // the message set for [start, end) is identical regardless — so the
    // first request's label is kept on the run.
    const identity = runIdentity(input);
    const existingId = this.runsByIdentity.get(identity);
    if (existingId !== undefined) {
      const existing = this.runs.get(existingId);
      if (existing !== undefined) return { run: existing, created: false };
    }
    const now = nowIso();
    const run: SummaryRun = {
      id: randomUUID(),
      groupId: input.groupId,
      kind: input.kind,
      status: "pending",
      interval: input.interval,
      attempts: 0,
      // First request's instructions win on a repeated create-or-find
      // (identity excludes them) — ADR 0008.
      instructions: input.instructions ?? null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.runs.set(run.id, run);
    this.runsByIdentity.set(identity, run.id);
    return { run, created: true };
  }

  async findRunByIdentity(
    input: CreateRunInput,
  ): Promise<SummaryRun | undefined> {
    const existingId = this.runsByIdentity.get(runIdentity(input));
    return existingId === undefined ? undefined : this.runs.get(existingId);
  }

  async getRun(id: string): Promise<SummaryRun | undefined> {
    return this.runs.get(id);
  }

  async listRuns(): Promise<SummaryRun[]> {
    return [...this.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async updateRun(run: SummaryRun): Promise<SummaryRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async saveSummary(summary: Summary): Promise<Summary> {
    const existingId = this.summariesByRunId.get(summary.runId);
    if (existingId !== undefined) {
      // One summary per run: replace the result but keep the stored
      // identity (idempotent worker writes).
      const stored: Summary = { ...summary, id: existingId };
      this.summaries.set(existingId, stored);
      return stored;
    }
    this.summaries.set(summary.id, summary);
    this.summariesByRunId.set(summary.runId, summary.id);
    return summary;
  }

  async getSummary(id: string): Promise<Summary | undefined> {
    return this.summaries.get(id);
  }

  async getSummaryByRunId(runId: string): Promise<Summary | undefined> {
    const id = this.summariesByRunId.get(runId);
    return id === undefined ? undefined : this.summaries.get(id);
  }

  async getProviderConfig(): Promise<ProviderRecord | null> {
    return this.provider;
  }

  async setProviderConfig(record: ProviderRecord): Promise<ProviderRecord> {
    this.provider = record;
    return record;
  }

  async getDefaultTimezone(): Promise<string> {
    return this.defaultTimezone;
  }

  async setDefaultTimezone(timezone: string): Promise<string> {
    this.defaultTimezone = timezone;
    return timezone;
  }

  async getDefaultDateFormat(): Promise<DateFormat> {
    return this.defaultDateFormat;
  }

  async setDefaultDateFormat(dateFormat: DateFormat): Promise<DateFormat> {
    this.defaultDateFormat = dateFormat;
    return dateFormat;
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    // Parity with PostgresStore (fix round A, audit M-4): the stored
    // payload is RAW and visibility (linking states + unexpired) is
    // applied at read time through the shared rule.
    return {
      ...this.connection,
      linking: servedLinking(this.connection.state, this.connection.linking),
    };
  }

  async setConnectionStatus(status: ConnectionStatus): Promise<void> {
    // Only the state fields are mutable here; the pairing-queue
    // ("linking") state is written exclusively by
    // updateConnectionLinking (mirrors the SQL columns — ADR 0008).
    // The session-check result is owned by requestSessionCheck/worker.
    this.connection = {
      ...status,
      linking: this.connection.linking,
      check: this.connection.check,
    };
  }

  async requestSessionCheck(): Promise<void> {
    this.connection = {
      ...this.connection,
      check: {
        status: "pending",
        requestedAt: nowIso(),
        checkedAt: null,
        latencyMs: null,
        error: null,
      },
    };
  }

  async updateConnectionLinking(
    linking: {
      qr: string;
      expiresAt: string;
      kind?: ConnectionLinking["kind"];
    } | null,
  ): Promise<void> {
    this.connection = {
      ...this.connection,
      linking:
        linking === null
          ? null
          : {
              // Pre-kind payloads are QR payloads (documented default).
              kind: linking.kind ?? "qr",
              qr: linking.qr,
              expiresAt: linking.expiresAt,
            },
    };
  }

  async requestLogout(): Promise<void> {
    // Idempotent: an already-pending request keeps its timestamp.
    if (this.logoutRequestedAt === null) {
      this.logoutRequestedAt = nowIso();
    }
  }

  async clearLogoutRequest(): Promise<void> {
    this.logoutRequestedAt = null;
  }
}
