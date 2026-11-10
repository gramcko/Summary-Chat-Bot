import { randomUUID } from "node:crypto";
import type {
  BotDb,
  ChatDefaults,
  GroupMemberUpsert,
  HistoryImportClaim,
  HistoryImportOutcome,
  InsertMessagesOptions,
  InsertMessagesResult,
  LinkingPayload,
  ConnectionState,
  SessionCheckClaim,
  SyncMembersResult,
  UpsertChatsResult,
} from "../src/db.js";
import type { LogFields, LogLevel, Logger } from "../src/lib/log.js";
import type { NewMessage } from "../src/normalize.js";
import type {
  AdapterEvent,
  DiscoveredChat,
  GroupMemberInfo,
  HistoryCursor,
  HistoryFetchRequest,
  RawInboundMessage,
  SessionCheckResult,
  WhatsAppAdapter,
} from "../src/whatsapp/adapter.js";

/**
 * Test doubles for the bot-worker suite. No file here is collected by
 * vitest: only `*.test.ts` files run. NOTHING in this suite ever needs a
 * real WhatsApp account or network access (AGENTS.md).
 */

// ---------------------------------------------------------------------------
// FakeAdapter — the Baileys boundary replaced by a scripted event source.
// ---------------------------------------------------------------------------

export class FakeAdapter implements WhatsAppAdapter {
  connectCalls = 0;
  disconnectCalls = 0;
  /** Simulates a connect() that throws (e.g. unreachable network). */
  connectError: Error | null = null;
  /** Makes connect() slow (race-guard tests). */
  connectDelayMs = 0;
  /** Groups returned by fetchChats(); may be mutated between calls. */
  fetchChatsResults: DiscoveredChat[] = [];
  fetchChatsError: Error | null = null;
  /** Recorded history requests (ADR 0007). */
  historyRequests: HistoryFetchRequest[] = [];
  /** Makes requestHistory() throw. */
  requestHistoryError: Error | null = null;
  /** Hook for scripting responses to a history request. */
  onRequestHistory?: (request: HistoryFetchRequest) => void;
  /** Chats released via releaseHistoryChat(). */
  releasedHistoryChats: string[] = [];
  /** Rosters returned by fetchRoster(); may be mutated between calls. */
  rosterResults = new Map<string, GroupMemberInfo[]>();
  rosterError: Error | null = null;
  /** Recorded fetchRoster() calls. */
  rosterRequests: string[] = [];
  /** logout() call count (ADR 0008). */
  logoutCalls = 0;
  /** Makes logout() hang (M-1 timeout tests) or throw. */
  logoutBehavior: "ok" | "hang" | "throw" = "ok";
  /** Result returned by checkSession(). */
  sessionCheckResult: SessionCheckResult = {
    ok: true,
    latencyMs: 12,
    error: null,
  };

  private readonly handlers = new Set<(event: AdapterEvent) => void>();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    if (this.connectError !== null) throw this.connectError;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async fetchChats(): Promise<DiscoveredChat[]> {
    if (this.fetchChatsError !== null) throw this.fetchChatsError;
    return [...this.fetchChatsResults];
  }

  async fetchRoster(chatJid: string): Promise<GroupMemberInfo[]> {
    this.rosterRequests.push(chatJid);
    if (this.rosterError !== null) throw this.rosterError;
    return [...(this.rosterResults.get(chatJid) ?? [])];
  }

  async checkSession(): Promise<SessionCheckResult> {
    return this.sessionCheckResult;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
    // Mirrors the real adapter: the remote revoke + socket teardown;
    // the CALLER owns the local session purge (M-1 guarantees it runs
    // even when this call stalls).
    if (this.logoutBehavior === "hang") {
      return new Promise<never>(() => {});
    }
    if (this.logoutBehavior === "throw") {
      throw new Error("not connected");
    }
  }

  async requestHistory(request: HistoryFetchRequest): Promise<string> {
    this.historyRequests.push(request);
    if (this.requestHistoryError !== null) throw this.requestHistoryError;
    this.onRequestHistory?.(request);
    return `req-${this.historyRequests.length}`;
  }

  releaseHistoryChat(chatJid: string): void {
    this.releasedHistoryChats.push(chatJid);
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Scripted event injection (what Baileys would have emitted). */
  emit(event: AdapterEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  emitMessages(...messages: RawInboundMessage[]): void {
    this.emit({ type: "messages", messages });
  }

  /** Emits one history batch (what a fetchMessageHistory round returns). */
  emitHistory(
    chatJid: string,
    messages: RawInboundMessage[],
    extra: { progress?: number | null; requestId?: string | null } = {},
  ): void {
    this.emit({
      type: "history",
      chatJid,
      messages,
      progress: extra.progress ?? null,
      requestId: extra.requestId ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// FakeDb — implements the documented SQL semantics in memory, most
// importantly the NEVER-clobber discovery rule (insert monitored=false;
// conflict updates only the name).
// ---------------------------------------------------------------------------

export interface FakeStoredGroup {
  id: string;
  name: string;
  monitored: boolean;
  timezone: string;
  summaryTime: string | null;
  /** History-import columns (migration 0003, ADR 0007); null/absent = never requested. */
  historyStatus?: "pending" | "running" | "done" | "failed" | null;
  historyRequestedAt?: Date | null;
  historyStartedAt?: Date | null;
  historyFinishedAt?: Date | null;
  historyImportedCount?: number;
  historyError?: string | null;
}

export class FakeDb implements BotDb {
  readonly connectionId = randomUUID();
  readonly stateHistory: ConnectionState[] = [];
  readonly groups = new Map<string, FakeStoredGroup>();
  readonly messages: NewMessage[] = [];
  /** Explicit history anchors per chat (tests that need a cursor). */
  readonly historyAnchors = new Map<string, HistoryCursor>();
  /** Global default time zone returned to discovery (null = use config). */
  defaultTimezone: string | null = null;
  readonly insertCalls: NewMessage[][] = [];
  /** How often insertMessages() touched last_message_at (ADR 0007). */
  lastMessageTouches = 0;
  /** Current linking payload on the connection row (ADR 0008). */
  linking: LinkingPayload | null = null;
  /** Roster rows by chat: userId -> row (name/phone/is_admin/active). */
  readonly membersByChat = new Map<
    string,
    Map<
      string,
      {
        userId: string;
        name: string | null;
        phone: string | null;
        isAdmin: boolean;
        active: boolean;
      }
    >
  >();
  /** Pending admin logout request (ADR 0008). */
  logoutRequestedAt: Date | null = null;
  /** Session health check fields (ADR 0008 follow-up). */
  sessionCheckRequestedAt: Date | null = null;
  sessionCheckCheckedAt: Date | null = null;
  sessionCheckOk: boolean | null = null;
  sessionCheckLatencyMs: number | null = null;
  sessionCheckError: string | null = null;
  /** finalizeLogout() call count. */
  finalizeLogoutCalls = 0;
  /**
   * Per-call insert failures (CR-M2 tests): each insertMessages() call
   * shifts one error and throws it when present.
   */
  readonly insertFailures: Error[] = [];

  private readonly seen = new Set<string>();

  async ensureConnection(): Promise<string> {
    return this.connectionId;
  }

  async setConnectionState(
    _connectionId: string,
    state: ConnectionState,
  ): Promise<void> {
    this.stateHistory.push(state);
  }

  async filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>> {
    return new Set(
      chatJids.filter((chatJid) => this.groups.get(chatJid)?.monitored === true),
    );
  }

  async insertMessages(
    _connectionId: string,
    rows: NewMessage[],
    options: InsertMessagesOptions = {},
  ): Promise<InsertMessagesResult> {
    const touchLastMessage = options.touchLastMessage !== false;
    this.insertCalls.push([...rows]);
    const failure = this.insertFailures.shift();
    if (failure !== undefined) throw failure;
    let inserted = 0;
    let duplicates = 0;
    let droppedUnmonitored = 0;
    for (const row of rows) {
      // Mirrors the SQL EXISTS clause (audit M4): the write itself
      // refuses rows whose chat is not monitored at INSERT time.
      if (this.groups.get(row.chatJid)?.monitored !== true) {
        droppedUnmonitored += 1;
        continue;
      }
      const key = `${row.chatJid}\u0000${row.whatsappMessageId}`;
      if (this.seen.has(key)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(key);
      this.messages.push(row);
      inserted += 1;
    }
    if (inserted > 0 && touchLastMessage) this.lastMessageTouches += 1;
    return { inserted, duplicates, droppedUnmonitored };
  }

  async getDefaultTimezone(): Promise<string | null> {
    return this.defaultTimezone;
  }

  async getOldestMessageCursor(
    chatId: string,
  ): Promise<HistoryCursor | null> {    const explicit = this.historyAnchors.get(chatId);
    if (explicit !== undefined) return explicit;
    const rows = this.messages
      .filter((message) => message.chatJid === chatId)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    const row = rows[0];
    if (row === undefined) return null;
    return {
      messageId: row.whatsappMessageId,
      fromMe: row.fromMe,
      timestampSec: Math.floor(row.sentAt.getTime() / 1000),
    };
  }

  async upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult> {
    // Mirror the SQL: one row per chat, LAST occurrence wins.
    const byJid = new Map<string, string>();
    for (const chat of chats) byJid.set(chat.chatJid, chat.name);
    let inserted = 0;
    let updated = 0;
    for (const [chatJid, name] of byJid) {
      const existing = this.groups.get(chatJid);
      if (existing !== undefined) {
        // NEVER-clobber rule (mirrors the SQL): only the name changes.
        existing.name = name;
        updated += 1;
      } else {
        this.groups.set(chatJid, {
          id: randomUUID(),
          name,
          monitored: false,
          timezone: defaults.timezone,
          summaryTime: null,
          historyStatus: null,
          historyRequestedAt: null,
          historyStartedAt: null,
          historyFinishedAt: null,
          historyImportedCount: 0,
          historyError: null,
        });
        inserted += 1;
      }
    }
    return { inserted, updated };
  }

  // ---- History imports (ADR 0007): mirror the SQL semantics ----

  /** Simulates POST /api/groups/:id/history-import (backend behavior). */
  requestHistoryImport(chatJid: string): void {
    const group = this.requireGroup(chatJid);
    group.historyStatus = "pending";
    group.historyRequestedAt = new Date();
    group.historyStartedAt = null;
    group.historyFinishedAt = null;
    group.historyImportedCount = 0;
    group.historyError = null;
  }

  private requireGroup(chatJid: string): FakeStoredGroup {
    const group = this.groups.get(chatJid);
    if (group === undefined) throw new Error(`unknown chat ${chatJid}`);
    return group;
  }

  async claimPendingHistoryImports(limit = 1): Promise<HistoryImportClaim[]> {
    // Mirrors the SQL claim: pending + MONITORED + linked chat only.
    const eligible = [...this.groups.entries()]
      .filter(
        ([, group]) => group.historyStatus === "pending" && group.monitored === true,
      )
      .sort(
        ([, a], [, b]) =>
          (a.historyRequestedAt?.getTime() ?? 0) -
          (b.historyRequestedAt?.getTime() ?? 0),
      )
      .slice(0, Math.max(1, Math.floor(limit)));
    return eligible.map(([chatJid, group]) => {
      group.historyStatus = "running";
      group.historyStartedAt = new Date();
      return {
        groupId: group.id,
        chatJid,
        requestedAt: group.historyRequestedAt ?? new Date(),
        startedAt: group.historyStartedAt,
      };
    });
  }

  /** Recorded incremental progress writes (CR-M2). */
  readonly historyProgressUpdates: Array<{ groupId: string; importedCount: number }> =
    [];

  async updateHistoryImportProgress(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    importedCount: number,
  ): Promise<boolean> {
    for (const group of this.groups.values()) {
      if (group.id !== claim.groupId) continue;
      // Same fence as completion (mirrors the SQL).
      if (group.historyStatus !== "running") return false;
      if ((group.historyStartedAt?.getTime() ?? -1) !== claim.startedAt.getTime()) {
        return false;
      }
      group.historyImportedCount = importedCount;
      this.historyProgressUpdates.push({
        groupId: claim.groupId,
        importedCount,
      });
      return true;
    }
    return false;
  }

  async completeHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    outcome: HistoryImportOutcome,
  ): Promise<boolean> {
    for (const group of this.groups.values()) {
      if (group.id !== claim.groupId) continue;
      // Guarded by status AND startedAt (mirrors the SQL): stale claims
      // cannot overwrite a newer import.
      if (group.historyStatus !== "running") return false;
      if ((group.historyStartedAt?.getTime() ?? -1) !== claim.startedAt.getTime()) {
        return false;
      }
      group.historyStatus = outcome.status;
      group.historyFinishedAt = new Date();
      group.historyImportedCount = outcome.importedCount;
      group.historyError = outcome.error;
      return true;
    }
    return false;
  }

  async requeueStaleHistoryImports(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    let requeued = 0;
    for (const group of this.groups.values()) {
      if (group.historyStatus !== "running") continue;
      if ((group.historyStartedAt?.getTime() ?? Infinity) >= cutoff) continue;
      group.historyStatus = "pending";
      group.historyStartedAt = null;
      requeued += 1;
    }
    return requeued;
  }

  async releaseHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
  ): Promise<boolean> {
    for (const group of this.groups.values()) {
      if (group.id !== claim.groupId) continue;
      if (group.historyStatus !== "running") return false;
      if ((group.historyStartedAt?.getTime() ?? -1) !== claim.startedAt.getTime()) {
        return false;
      }
      group.historyStatus = "pending";
      group.historyStartedAt = null;
      return true;
    }
    return false;
  }

  // ---- Session control and roster (ADR 0008): mirror the SQL ----

  async setLinkingQr(
    _connectionId: string,
    payload: LinkingPayload,
  ): Promise<void> {
    // A new payload replaces the previous one (mirrors the UPDATE).
    this.linking = payload;
  }

  async clearLinkingQr(_connectionId: string): Promise<void> {
    this.linking = null;
  }

  async clearExpiredLinking(): Promise<number> {
    if (this.linking !== null && this.linking.expiresAt.getTime() < Date.now()) {
      this.linking = null;
      return 1;
    }
    return 0;
  }

  async syncGroupMembers(
    chatId: string,
    members: GroupMemberUpsert[],
  ): Promise<SyncMembersResult> {
    // Dedupe by user id (last wins), like the SQL statement.
    const byUser = new Map<string, GroupMemberUpsert>();
    for (const member of members) {
      if (member.userId !== "") byUser.set(member.userId, member);
    }
    // Empty roster = no data: never deactivates everyone.
    if (byUser.size === 0) return { upserted: 0, deactivated: 0 };
    // Monitored boundary INSIDE the write (H-1, mirrors the EXISTS
    // guard): unmonitored or unknown chats sync nothing.
    if (this.groups.get(chatId)?.monitored !== true) {
      return { upserted: 0, deactivated: 0 };
    }

    const roster = this.membersByChat.get(chatId) ?? new Map();
    this.membersByChat.set(chatId, roster);
    let upserted = 0;
    for (const [userId, member] of byUser) {
      const existing = roster.get(userId);
      if (existing === undefined) {
        roster.set(userId, {
          userId,
          name: member.name,
          phone: member.phone,
          isAdmin: member.isAdmin,
          active: true,
        });
      } else {
        // Missing name/phone keeps the stored one (COALESCE in the SQL).
        existing.name = member.name ?? existing.name;
        existing.phone = member.phone ?? existing.phone;
        existing.isAdmin = member.isAdmin;
        existing.active = true;
      }
      upserted += 1;
    }
    let deactivated = 0;
    for (const row of roster.values()) {
      if (row.active && !byUser.has(row.userId)) {
        row.active = false; // kept as history — never deleted
        deactivated += 1;
      }
    }
    return { upserted, deactivated };
  }

  async updateGroupMemberNames(
    entries: ReadonlyArray<{ jids: string[]; name: string }>,
  ): Promise<number> {
    const byJid = new Map<string, string>();
    for (const entry of entries) {
      const name = entry.name.trim().slice(0, 300);
      if (name === "") continue;
      for (const jid of entry.jids) {
        if (jid !== "") byJid.set(jid, name);
      }
    }
    let updated = 0;
    for (const [chatId, roster] of this.membersByChat) {
      // Monitored boundary (mirrors the SQL join on groups).
      if (this.groups.get(chatId)?.monitored !== true) continue;
      for (const member of roster.values()) {
        const name = byJid.get(member.userId);
        if (name !== undefined && member.name !== name) {
          member.name = name;
          updated += 1;
        }
      }
    }
    return updated;
  }

  async claimSessionCheck(): Promise<SessionCheckClaim | null> {
    const requestedAt = this.sessionCheckRequestedAt;
    if (requestedAt === null) return null;
    if (
      this.sessionCheckCheckedAt !== null &&
      this.sessionCheckCheckedAt >= requestedAt
    ) {
      return null;
    }
    return { connectionId: this.connectionId, requestedAt };
  }

  async completeSessionCheck(
    claim: SessionCheckClaim,
    result: SessionCheckResult,
  ): Promise<boolean> {
    if (
      this.sessionCheckRequestedAt === null ||
      this.sessionCheckRequestedAt.getTime() !== claim.requestedAt.getTime()
    ) {
      return false;
    }
    this.sessionCheckCheckedAt = new Date();
    this.sessionCheckOk = result.ok;
    this.sessionCheckLatencyMs = result.latencyMs;
    this.sessionCheckError = result.error;
    return true;
  }

  /** Simulates the backend requesting a session health check. */
  requestSessionCheck(): void {
    this.sessionCheckRequestedAt = new Date();
    this.sessionCheckCheckedAt = null;
    this.sessionCheckOk = null;
    this.sessionCheckLatencyMs = null;
    this.sessionCheckError = null;
  }

  async consumeLogoutRequest(): Promise<Date | null> {
    const requestedAt = this.logoutRequestedAt;
    this.logoutRequestedAt = null;
    return requestedAt;
  }

  async finalizeLogout(_connectionId: string): Promise<void> {
    this.finalizeLogoutCalls += 1;
    this.stateHistory.push("unavailable");
    this.linking = null;
    // last_message_at is deliberately kept (mirrors the SQL).
  }

  /** Simulates the admin changing preferences in the dashboard. */
  adminConfigure(
    chatJid: string,
    prefs: {
      monitored?: boolean;
      timezone?: string;
      summaryTime?: string | null;
    },
  ): void {
    const group = this.groups.get(chatJid);
    if (group === undefined) throw new Error(`unknown chat ${chatJid}`);
    if (prefs.monitored !== undefined) group.monitored = prefs.monitored;
    if (prefs.timezone !== undefined) group.timezone = prefs.timezone;
    if (prefs.summaryTime !== undefined) group.summaryTime = prefs.summaryTime;
  }
}

// ---------------------------------------------------------------------------
// Recording logger + small async helpers
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export function recordingLogger(sink: LogEntry[]): Logger {
  return (level, event, fields) => {
    sink.push({ level, event, fields: fields ?? {} });
  };
}

export function findEvents(sink: LogEntry[], event: string): LogEntry[] {
  return sink.filter((entry) => entry.event === event);
}

/** True when any captured log line contains `secret` (privacy asserts). */
export function logsContain(sink: LogEntry[], secret: string): boolean {
  return sink.some((entry) => JSON.stringify(entry).includes(secret));
}

/** A normalized raw message with sensible defaults (group text). */
export function rawMessage(
  overrides: Partial<RawInboundMessage> = {},
): RawInboundMessage {
  return {
    chatJid: "111111111111-22222222@g.us",
    messageId: "MSG-1",
    senderJid: "sender@s.whatsapp.net",
    senderName: null,
    timestampSec: 1_772_000_000,
    fromMe: false,
    kind: "text",
    text: "hello",
    caption: null,
    linkPreview: false,
    ...overrides,
  };
}

/** Polls until `fn` returns a defined value; fails loudly on timeout. */
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
