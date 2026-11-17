# 0008 — Product upgrade: custom instructions, group detail, session control

- **Status:** Shipped (rounds 1-4) (2026-11-04) — data model + backend
  API + summary-worker instructions (round 1), bot-worker
  linking/QR/members capture (round 2), backend worker supervision
  (round 3), and the dashboard screens (round 4) are all in the tree.
  Hardening fix rounds A (contracts/backend/summary-worker/docs) and B
  (bot-worker) close security-audit and code-review findings on top;
  see "Implementation" below.

## Context

The MVP summarizes but gives the admin little control and little
context: summaries cannot be steered ("focus on decisions"), the
dashboard cannot show a group's members, past summaries, or a chat-like
message view, and a linked WhatsApp session can only be unlinked by
deleting files on the server. Four product requirements follow:
custom summary prompts, group detail data (members, messages,
summaries), QR-based session (re)linking plus in-app END/UNLINK, and
storing sender/member names so summaries and the UI can use them.

Privacy constraints carry over from ADR 0004/0007: all of this is
admin-only data behind the authenticated API, nothing extends capture
beyond monitored groups, and no new secrets enter logs.

## Decision

### Custom instructions: a separate, labelled channel

- `CreateRunRequest.instructions` (optional, trimmed, 1..2000 chars)
  is stored on the run (`summary_runs.instructions`, NULL when absent;
  migration 0004) and echoed on `SummaryRun.instructions`. On the
  create-or-find repeat path the **first** request's instructions win —
  run identity `(group, interval, kind)` deliberately excludes them.
- The queue payload stays identifier-only (ADR 0003): the summary-worker
  loads `instructions` from the run row and passes it to the AI adapter
  as `AiSummaryInput.instructions` (provider-neutral, `null` = absent),
  truncated defensively at the 2000-char cap at the boundary.
- **Separation rule:** adapters must present instructions as a clearly
  labelled ADMIN INSTRUCTIONS section of its own — never merged into
  the delimited conversation data block and never into the fixed system
  instruction. The Gemini adapter appends the section after the
  byte-identical data block; message text (which is untrusted data)
  cannot cross into it. This keeps the threat model of ADR 0005 intact:
  instructions are operator input, conversation content is data, and
  the two never mix. The mock provider only records deterministically
  that instructions were provided (it never "follows" them).

### Group detail data (members, messages, summaries)

- New `group_members` table (migration 0004): best-effort roster
  snapshot per chat, upserted by the bot-worker on membership events /
  refresh (`UNIQUE(chat_id, user_id)`). WhatsApp does not replay
  membership history, so the roster drifts toward reality; leavers are
  kept as `active: false` history, never deleted.
- `messages.sender_name` (display only) captures the WhatsApp push name
  alongside each message so the chat view and summaries can use names.
- API surface: `GET /api/groups/:id` (single group),
  `GET /api/groups/:id/members`, `GET /api/groups/:id/messages`
  (newest-first chat view, half-open `from`/`to` instant range,
  cursor pagination), `GET /api/groups/:id/summaries` (past summaries
  with their run intervals).
- **PII note:** member names, sender names, and JIDs are personal data.
  They are served on the authenticated admin API only, never logged, and
  covered by the same retention/purge rules as the messages themselves.
- **Rosters are monitored-only** (fix round B, audit H-1): the
  bot-worker syncs and the API serves `group_members` only for
  monitored groups (`409` "Group is not monitored." otherwise) — the
  ADR 0004 opt-in boundary applied to the roster; migration 0006
  (`0006-roster-monitored-cleanup`) deletes rows captured before the
  gate (its `down` is a deliberate no-op: deleted PII is not restored).

### Session control: QR via database, logout as a control flag

- The bot-worker publishes the current pairing QR/payload into
  `whatsapp_connections.linking_qr` + `linking_qr_expires_at`
  (migration 0004); `GET /api/connection` exposes it as
  `ConnectionStatus.linking` only while unexpired and only on the
  authenticated API. **The QR is a live pairing ticket**: it is never
  logged and never leaves the auth boundary (same class of secret as
  session state, ADR 0004).
- END/UNLINK is `POST /api/connection/logout` (202, idempotent): it sets
  `whatsapp_connections.logout_requested_at` (first timestamp wins) and
  returns — the API never touches the session itself. The bot-worker
  consumes the flag (logout + session cleanup) and clears it. This
  keeps the boundary of ADR 0004: only bot-worker owns the Baileys
  connection and its credentials.
- **Delete connection data** (migration 0014) is the recovery control for
  a partial/invalid session that leaves the worker reconnecting with
  stale credentials and no QR. `POST /api/connection/reset` sets
  `session_reset_requested_at` (202, idempotent) and the bot-worker
  processes it **before** any logout request: it skips the remote
  `logout()` entirely, purges the local session directory, finalizes the
  row, and re-arms linking so a fresh QR appears. The consume statement
  also clears `logout_requested_at`, so a reset wins over a pending
  remote logout. Captured data, settings, and the AI configuration are
  untouched; the flag is never exposed in `ConnectionStatus`.

### Workers supervision (round 3)

`npm run dev -w @summarly/backend` + the dashboard is the whole dev
workflow: the backend spawns and supervises the `summary-worker` and
`bot-worker` child processes itself.

- **Switch:** `SUPERVISE_WORKERS` (default `true`; `false` disables
  spawning — e2e runs its own worker child, and the future deployment
  Compose must run the workers as its own services and set `false`).
- **Entry rule:** a worker runs from its built `dist/index.js` whenever
  that build exists; otherwise from `src/index.ts` via `--import tsx`
  (`NODE_ENV=production` without a build falls back to the dev entry
  rather than crash-looping). Rationale: production starts must run the
  build without extra flags, while dev must keep working before any
  build exists. A build older than the worker's `src/` logs
  `worker_entry_stale` but still runs — the fix is a rebuild (or
  deleting `dist/`), never a silent mode switch.
- **Restart policy:** exponential backoff 1s → 60s cap, max 5 restarts
  per 10-minute sliding window per worker; past that supervision for
  THAT worker pauses with a `worker_supervision_paused` log while the
  backend keeps serving. A worker stable for 5 minutes resets its
  backoff.
- **Stop ordering:** on shutdown the supervisor stops the children
  FIRST (SIGTERM, force-kill ~10s later), then the app/queue/pool close
  as before. Children also receive `SUMMARLY_PARENT_PID`; the
  summary-worker polls it and shuts down gracefully if the backend
  vanishes (the bot-worker adopts the same watchdog in fix round B).
- **Windows caveat:** hard-killing the backend (e.g. `child.kill()`,
  which is forceful there) skips the graceful path and can orphan the
  children — stop the backend with Ctrl+C (or Ctrl+Break, also handled).

## Consequences

- Summaries can be steered per request without touching prompts or
  system instructions; the run record documents what was asked.
- The dashboard can render group pages (members, chat history, past
  summaries) and the link/unlink flow with zero new privileged surface:
  everything rides the existing auth + error envelope contracts.
- The roster is best-effort by construction (WhatsApp limitation, ADR
  0004); the API shape allows it to be empty or stale and the docs say
  so.
- The linking QR's sensitivity is documented at the contract level
  (`ConnectionLinking`); any future consumer inherits the warning.

## Implementation

- **Round 1 (shipped):** migration 0004; contracts
  (`GroupMember`, `ApiMessage`, `GroupSummary`, `ConnectionLinking`,
  `SummaryRun.instructions`, `CreateRunRequest.instructions`,
  `AiSummaryInput.instructions`); backend Store/routes (group detail,
  connection linking/logout, run instructions); summary-worker
  instructions pass-through + Gemini/mock adapter behavior.
- **Round 2 (shipped):** bot-worker side - pairing-QR/pairing-code and
  roster publication, sender-name capture, logout consumption.
- **Round 3 (shipped):** worker supervision (decision above).
- **Round 4 (shipped):** dashboard screens (group detail, chat view,
  link/unlink UX).
- **Fix round A (shipped):** hardening on contracts/backend/
  summary-worker/docs - pairing-ticket visibility gate (linking states +
  unexpired only) and `Cache-Control: no-store` on API responses,
  `ConnectionLinking.kind` + migration 0005, purge covers the member
  roster, display names (never JIDs) to the AI provider, strict cursor
  validation (400, never 500), `ApiMessagePage` + exact-multiple
  pagination, instant-based cursor tie-breaks, roster COALESCE name
  semantics, `worker_entry_stale` warning, summary-worker parent-PID
  watchdog.
- **Fix round B (follows):** the same audit/review hardening on
  bot-worker files (including adopting the parent-PID watchdog).
- **Roster names fix (2026-11-04):** group metadata was mistakenly
  assumed to carry display names; it carries only JIDs (verified in
  Baileys 6.7.24 `extractGroupMetadata`), so every member was stored
  with `name = null` and the dashboard showed opaque LIDs. The adapter
  now keeps a contact-name cache from `contacts.upsert` /
  `contacts.update` and message push names, resolves participants by
  their LID/PN aliases, and emits `contact-names` so learned names are
  written to `group_members` (monitored groups only). A nullable
  `phone` PN-JID fallback (migration 0007) is stored on roster rows so
  LID-only members have a readable identifier until a name is learned.
- **Contacts and source messages (2026-11-04):** the dashboard gained a
  Contacts surface (`GET /api/contacts`, `/api/contacts/:id`,
  `/api/contacts/:id/messages`) listing active members of monitored
  groups, the groups they participate in, and their cross-group
  messages. The run detail screen now has a "Messages used" tab that
  reads the group's messages for the run's half-open interval. Group
  messages also fall back to the roster name when the captured push
  name is missing. Admins can override a contact's display name
  (`PATCH /api/contacts/:id`, `contact_overrides` table); the override
  wins over roster names and is never overwritten by automatic syncs.
  Groups and contacts have client-side search/filter, the sidebar is
  collapsible to an icon rail, and summary-run status changes raise
  in-app toast notifications.
- **On-demand roster sync (2026-11-16):** an empty Members tab was
  reachable without a membership event — after "delete all data" groups
  are re-created unmonitored, discovery only syncs monitored chats, and
  enabling monitoring afterwards had no way to request a roster. The
  backend now records `groups.roster_sync_requested_at` (migration
  0016) when monitoring is enabled (unmonitored → monitored PATCH) or
  on `POST /api/groups/:id/roster-sync` (202 `{ "ok": true }`, 404
  unknown, 409 unmonitored). The bot-worker claims at most ONE request
  per session-control tick (`FOR UPDATE SKIP LOCKED`, `monitored = true`
  re-checked, so un-monitoring revokes it), calls
  `adapter.fetchRoster(chatJid)` and writes via `syncGroupMembers`;
  empty metadata logs `roster_sync_empty` and writes nothing. The flag
  is internal and never part of the `Group` contract. Best-effort by
  design: a failure is logged safely and the admin can refresh again
  (no retry loop).
- **Display-name precedence (2026-11-16):** contact overrides are the
  display-name source of truth for the Members tab and for messages.
  `listGroupMembers` resolves the override, then the roster name, then
  the newest push name observed for that sender in the chat; the message
  readers (`listGroupMessages`, `listContactMessages`,
  `searchMessages`) now prefer the override-aware roster name
  (`COALESCE(gm.name, m.sender_name)`), so an admin rename applies to
  already-captured messages. Message push names are fallback only; the
  InMemoryStore mirrors both behaviors.
- **Clickable source references (2026-11-16):** each cited message in a
  run summary is now a link to
  `/runs/<runId>?tab=messages&message=<messageId>`. The run page reads
  `tab`/`message` from the URL with `useSearchParams`, opens the
  "Messages used" tab, and forwards the id to `RunMessagesTab`. That tab
  walks older pages with the existing `nextCursor`/`MESSAGE_PAGE_SIZE`
  pagination (bounded to 40 fetches) until the cited message is loaded,
  scrolls it into view inside the scroll container, and highlights it
  briefly; a message that cannot be found (or falls outside the run's
  interval) raises an inline alert instead of failing. No new API
  endpoint or contract field was added.
