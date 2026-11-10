# 0007 — WhatsApp history import for monitored groups

- **Status:** Accepted (2026-11-02) - Phase E.5 round 1 (backend,
  contracts, migration), round 2 (bot-worker import implementation,
  see "Implementation" below), and the dashboard flow (the
  "retrieve old messages?" prompt and progress display) — all shipped.

## Context

Monitoring a group captures messages from *now on*; admins asked for
older history too. WhatsApp (via Baileys) can serve a portion of a
group's past messages, but not a guaranteed full archive (ADR 0004
documents the unofficial-integration limits). The feature must respect
the project's privacy boundary: **unmonitored groups are never
collected** — so importing history is only ever allowed for groups the
admin has explicitly opted in, and only when the admin explicitly asks
for it.

Questions to settle here: how the request is recorded and coordinated
between `backend` and `bot-worker`, what the admin controls, how
progress and errors are reported, and what the honest limits are.

## Decision

### Opt-in per monitored group, user-driven

- The dashboard asks "retrieve old messages?" when a group is switched
  to monitored (and the admin can request it later from the group
  screen). Accepting calls `POST /api/groups/:id/history-import`.
- The route requires the group to be **monitored** — a request for an
  unmonitored group is rejected `409` ("Group must be monitored before
  importing history."). This is the privacy boundary of ADR 0004
  enforced at the API: unmonitored groups are never imported, and no
  code path requests an import implicitly.

### DB-flag coordination (backend ⇄ bot-worker poll)

The `groups` table gained system-managed columns (migration 0003):
`history_import_status` (`pending`/`running`/`done`/`failed`),
`history_import_requested_at`, `history_import_started_at`,
`history_import_finished_at`, `history_import_imported_count`, and
`history_import_error` (safe code/short message only — never content,
credentials, or WhatsApp internals). Coordination is deliberately
**poll-based through PostgreSQL**, consistent with architecture §4.3
(bot-worker owns the WhatsApp session) and requiring no new queue or
RPC:

1. the backend transitions the row to `pending` (atomically, only when
   no import is `pending`/`running`);
2. the bot-worker polls for `pending` rows of monitored groups,
   transitions to `running`, performs the import, and reports
   `done` + `importedCount` or `failed` + `error` with the timestamps.

These columns are **system-managed**: `PATCH /api/groups/:id` cannot
alter them (they are excluded from `UpdateGroupRequest`) and group
discovery/upsert never resets them — a rediscovery or rename must never
cancel an import.

### Semantics of the request

- `202` when a request is accepted (fresh, or a repeat after
  `done`/`failed` - repeated requests are allowed); the progress fields
  reset together (`startedAt`/`finishedAt` null, `importedCount` 0,
  `error` null).
- `200` when an import is already `pending`/`running` - an idempotent
  no-op that never restarts or duplicates work in flight.
- The `202`-vs-`200` decision is made by the atomic write (did THIS
  request perform the transition?), never by a pre-write read: two
  concurrent requests cannot both answer `202` (review CR-m1).
- Un-monitoring a group **cancels** a `pending` import (audit SA-M1:
  consent to fetch history is revoked and the request can never fire
  later just because monitoring is re-enabled). A `running` import is
  left to the bot-worker to abort itself, and `done`/`failed` states
  are kept as record.
- `404` unknown group; `409` unmonitored group.

### Bounded budget

The import is deliberately **bounded**: a maximum number of messages
and a maximum duration (exact env knobs are defined by the bot-worker
round). Past-budget messages are simply not imported; the summary
pipeline's own caps (`MAX_MESSAGES_PER_RUN` etc.) bound downstream
spend independently.

### Honest limits (partial history)

WhatsApp serves only the history it makes available to the linked
session (roughly recent history; it varies by client and platform).
**There is no full-archive guarantee**: `importedCount` reports what
was actually stored, and an admin should read it as "as much as
WhatsApp allowed", not "everything". Media is out of scope (same as
live capture).

### Privacy stance preserved

- Unmonitored groups are never imported (route-enforced).
- Imports only ever start from an explicit admin action.
- Imported messages flow through the same monitored-only capture path
  and the same retention/summary rules as live messages.
- Operational logs and the `error` column carry identifiers and safe
  codes only — never message content (AGENTS.md).

## Consequences

- The dashboard shows import progress/failure on the group
  (`historyImport` is part of the `Group` shape).
- A failed import can be retried; a finished one can be re-requested,
  which resets the counters and imports again (idempotent message
  ingestion makes overlap harmless — uniqueness is enforced per
  WhatsApp message id).
- The poll-based design means import latency up to the bot-worker
  polling interval; acceptable for a background backfill.

## Implementation (Phase E.5 round 2 — bot-worker)

### Verified Baileys surface (6.7.24, read from the installed package)

- **Request:** `fetchMessageHistory(count, oldestMsgKey,
  oldestMsgTimestamp) => Promise<string>` (Socket/messages-recv.js:707).
  It relays a `historySyncOnDemandRequest`
  `{ chatJid, oldestMsgFromMe, oldestMsgId, oldestMsgTimestampMs,
  onDemandMsgCount }` as a peer-data-operation message and resolves with
  the relayed request id. Note the units: `oldestMsgTimestampMs` — the
  timestamp argument is **milliseconds** (we pass `messageTimestamp *
  1000`; message timestamps themselves are unix seconds).
- **Delivery:** `messaging-history.set` events with
  `{ chats, contacts, messages (reverse-chronological), isLatest?,
  progress?, syncType?, peerDataRequestSessionId? }`
  (Types/Events.d.ts), emitted from a device-to-self
  `historySyncNotification` protocol message. Two gating facts verified
  in the installed sources: (a) Baileys only processes the notification
  when `shouldSyncHistoryMessage(...)` accepts it (Socket/chats.js:779)
  and `PROCESSABLE_HISTORY_TYPES` includes the sync type; (b) the
  spoofing guard drops non-self history notifications
  (Utils/process-message.js).
- **Consequences for our socket config (refinement of ADR 0004):**
  `shouldSyncHistoryMessage` now accepts **only** `ON_DEMAND` sync types
  — the responses to OUR OWN requests. Bulk sync (INITIAL_BOOTSTRAP /
  RECENT / FULL / PUSH_NAME) stays disabled and the connect-time sync
  wait stays off. `shouldIgnoreJid` now exempts the account's own JIDs
  (user + LID forms) in addition to `@g.us` groups — without that, the
  device-to-self history response would be dropped before decryption.
  All other non-group JIDs are still never decrypted.

### Bounded budget ("as many as possible, bounded")

The import runs in rounds: request `HISTORY_IMPORT_BATCH_COUNT`
messages with a backwards cursor → collect the batches WhatsApp returns
for that chat → ingest → repeat while WhatsApp keeps returning new
messages. Effort is bounded by env knobs (`.env.example`):
`HISTORY_IMPORT_POLL_MS` (5000, floor 1000),
`HISTORY_IMPORT_BATCH_COUNT` (50 — WhatsApp caps an on-demand query at 50),
`HISTORY_IMPORT_MAX_ROUNDS` (20),
`HISTORY_IMPORT_MAX_MESSAGES` (2000, an **exact** cap - the last batch
is truncated to the remaining room), and
`HISTORY_IMPORT_TIME_BUDGET_MS` (120000). Internal timing values — a
30 s first-response/per-round cap followed by a 2 s quiet window after
activity — live in `DEFAULT_HISTORY_IMPORT_BUDGETS` (see the fix-round
section below).

**Outcome semantics:** exhausting a budget ends the import as
**`done`** with the inserted count — a bounded import is a *successful
partial* import, not a failure. `failed` is reserved for actual
problems, with safe codes in `history_import_error`:
`history_unavailable` (the request could not be sent),
`history_timeout` (WhatsApp never answered the first round),
`group_unmonitored` (the admin unmonitored the group mid-import — the
import stops immediately), `history_internal` (unexpected local error).

**Pagination:** the cursor is the OLDEST message received so far
(message id + fromMe + timestamp). The FIRST request must page back from
the oldest captured message in PostgreSQL: WhatsApp silently ignores an
empty/synthetic key, which used to surface as a 30-second
`history_timeout`. If the chat has no captured message yet there is no
anchor, so the import fails fast with `history_no_anchor` instead of
waiting. Exact WhatsApp cursor semantics could not be verified without a
live account - the loop is robust either way: rounds that return only
duplicates (or nothing) end the import.

**The linked phone must be online.** On-demand history is served by the
primary phone, not by the WhatsApp servers. If the phone is offline (or
does not answer), no `messaging-history.set` arrives and the round ends
as `history_timeout`. The adapter now also parses the peer-data
operation response code (`fullHistorySyncOnDemandRequestResponse`) and
surfaces `history_phone_offline`, `history_declined`, or
`history_expired` immediately when the phone explicitly refuses. The
dashboard maps these codes to actionable copy (keep the phone online,
then retry). The self-JID predicate also tolerates missing `from` JIDs
on receipts/offline nodes; a `TypeError` there previously aborted the
whole offline-node batch, which could hide a history response.

### Claim lifecycle and stale recovery

- One import at a time. `claimPendingHistoryImports` atomically claims
  `pending` rows **that are monitored** (`FOR UPDATE SKIP LOCKED`; the
  privacy boundary is in the WHERE clause) and marks them `running`.
- Completion/release are guarded by the claim's `started_at` (stored at
  millisecond precision so it round-trips exactly through JavaScript
  Dates), so a stale claim can never overwrite a newer import's outcome.
- **Graceful shutdown** releases the active claim straight back to
  `pending`; **crash recovery**: `running` claims older than **10
  minutes** are re-queued to `pending` on every poll tick and can be
  claimed again. A crashed import therefore stays `running` at most 10
  minutes before recovery.
- Late `messaging-history.set` batches after completion are ignored
  (the import service drops them and the adapter releases the chat from
  its filter).

### Ingestion rules

- Imported messages go through the SAME normalization (text/link/other,
  skip rules) and the SAME monitored-only, idempotent batch path as live
  capture (`ON CONFLICT (connection_id, chat_id, whatsapp_message_id) DO
  NOTHING`, INSERT-level `monitored` enforcement). Duplicates count as
  already captured; `imported_count` counts **inserts only**.
- **`whatsapp_connections.last_message_at` is NOT updated by imports**
  (the insert passes `touchLastMessage: false`): historical messages
  must not masquerade as live traffic in connection status.
- Privacy boundary re-checked before EVERY round: an unmonitored group
  stops the import immediately (`group_unmonitored`), and history for
  chats other than the requested one is dropped inside the adapter
  **before normalization** (it is never parsed or stored).

### Operational logs

Counts, group ids, and hashed chat references only (`safeChatRef`) —
never message content, JIDs, or names: `history_import_started`,
`history_round` (debug: received/fresh/inserted/duplicates per round),
`history_import_completed`, `history_import_released`,
`history_claims_requeued`, `history_buffer_overflow`, and the failure
events with safe reasons.

### Request correlation (log-only — SA-M3)

History payloads are correlated to OUR peer-data requests by
`peerDataRequestSessionId` (the id `fetchMessageHistory` resolves with
is kept per import). When a `messaging-history.set` payload arrives with
an absent or differing session id it is logged with the fixed safe line
`history_payload_unverified` (`reason: missing-session-id |
unknown-session-id`) and still processed. **Enforcement is deliberately
deferred: the session-id echo behavior is unverified against a live
account** (`TODO(live-verify)` in `baileys-adapter.ts`) — once
confirmed, unmatched payloads should be dropped outright.

### Fix-round hardening (Phase E.5 review)

- A round now waits for its FIRST response up to the round timeout
  before concluding "no history" (WhatsApp peer-data latency is
  unverified; the quiet window only applies after activity). A
  never-answering round still ends in `history_timeout`.
- `history_import_imported_count` is updated after EVERY round (fenced
  exactly like completion), so the dashboard can render "N imported so
  far" mid-run; the terminal write stays exact.
- Stale-claim recovery compares against the **database** clock
  (`now() - make_interval(...)` in SQL), never the worker clock, and the
  budget invariant `timeBudgetMs + roundTimeoutMs < staleMs` is enforced
  at startup so a slow-but-active import can never be requeued as stale.
- The per-round receive buffer is capped at `maxMessages × 2` with a
  counted `history_buffer_overflow` drop, and released after each round.

## Live-verification update (2026-11-10): why on-demand still times out

The on-demand request itself is correct (real anchor, `oldestMsgTimestampMs`
in milliseconds, count <= 50, ON_DEMAND enabled), but WhatsApp does not
reliably answer `fetchMessageHistory` for companion devices. This is a
known upstream limitation, not a request-shape bug:

- Baileys issues [#2452](https://github.com/WhiskeySockets/Baileys/issues/2452)
  and [#1934](https://github.com/WhiskeySockets/Baileys/issues/1934): the
  request is relayed and a session id is returned, but no
  `messaging-history.set` / `HISTORY_SYNC_NOTIFICATION` arrives.
- Baileys issue [#2580](https://github.com/WhiskeySockets/Baileys/issues/2580)
  tracks a v7 regression where the event was not emitted at all; it was
  fixed by marking peer-routed self stanzas as `fromMe`
  ([commit 5ddc231](https://github.com/WhiskeySockets/Baileys/commit/5ddc231)).
  The pinned 6.7.24 build already contains that decode fix.
- WhatsApp Web's own on-demand history requires the initial history sync
  and app-state sync to have completed; a whatsapp-web.js investigation
  ([#201890](https://github.com/wwebjs/whatsapp-web.js/issues/201890))
  found that the phone replied but Web discarded the response until those
  gates were satisfied.
- WhatsApp's help center: the phone sends recent history when a device is
  linked, Desktop receives more than Web, and there is no full-archive
  guarantee (https://faq.whatsapp.com/653480766448040).

Consequences for this project:

1. **Default (`WA_HISTORY_SYNC=off`)** remains privacy-first: only
   ON_DEMAND responses to explicit imports are processed.
2. **`WA_HISTORY_SYNC=recent`** lets Baileys complete the connect-time
   RECENT/INITIAL_BOOTSTRAP sync and app-state sync (the payload is
   dropped). Some phones only answer ON_DEMAND after this state machine
   has run. This is the least invasive way to try to fix on-demand.
3. **`WA_HISTORY_SYNC=full`** additionally requests `syncFullHistory` with
   a Windows Desktop browser preset and captures INITIAL_BOOTSTRAP /
   RECENT / FULL history for **monitored groups only**. This is the
   reliable backfill path, but it requires a WhatsApp **re-link** to
   trigger the initial sync and decrypts recent group history in memory
   (unmonitored chats are filtered before mapping and are never stored).
   It is opt-in because it changes the ADR 0004 privacy posture.
4. A phone `REQUEST_SUCCESS` with no history payload now finishes the
   import as **`done` with 0 imported** (no older history) instead of a
   false `history_timeout`.

Operational recommendation: try `recent` and a re-link first; if the phone
still does not answer ON_DEMAND, use `full` and re-link. Keep the primary
phone online while importing.
