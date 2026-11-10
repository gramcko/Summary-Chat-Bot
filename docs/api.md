# Summarly Chat Bot — API contract

- **Status:** Skeleton milestone. The authoritative contract is `packages/contracts`
  (Zod schemas); this document explains it for humans.
- **Base URL:** the backend service (default `http://127.0.0.1:3000`).
- **Authentication:** session cookie `summarly_session` (httpOnly, SameSite=Strict;
  `Secure` when `COOKIE_SECURE=true`).

## Conventions

- Every request and response body is validated against the schemas in
  `@summarly/contracts`. The dashboard imports the same package for types.
- Errors always use one envelope:

  ```json
  { "error": { "code": "validation_error", "message": "...", "details": [{ "path": "...", "message": "..." }] } }
  ```

  Codes: `validation_error`, `unauthorized`, `forbidden`, `not_found`,
  `conflict`, `rate_limited`, `internal`.
- Intervals are **half-open**: `start` inclusive, `end` exclusive, with an
  explicit IANA `timezone`. The server compares instants, not wall times.
- `POST /api/summary-runs` is **create-or-find**: an identical request — same
  group, same `[start, end)` instants (timestamp formats are normalized to
  instants, so `...Z` and `+02:00` spellings of the same moment are the same
  request), same kind — returns the existing run with `200`; a new run is
  created with `201`. The first request's timezone label is kept on the run
  (the label does not change which messages the interval covers); the
  first request's `instructions` win likewise (run identity excludes
  both). Safe to retry. API-created runs are always `kind: "manual"`;
  scheduled runs are created by the scheduler (architecture §5.3).
- Saved provider API keys are **write-only**: responses only report
  `hasApiKey: true|false`. No response shape contains key material. In
  `PUT /api/settings/ai-provider`, omit `apiKey` to keep the saved key or send
  `null` to clear it.
- Message listings are **newest first** with opaque cursor pagination:
  the response envelope is `{ "items": [...], "nextCursor": string|null }`
  and the cursor is passed back verbatim in the `cursor` query parameter.
  Date ranges are **half-open instants** `[from, to)` (`from` inclusive,
  `to` exclusive), like summary intervals.
- `ConnectionStatus.linking.qr` is a **live pairing ticket** (the QR /
  pairing payload for linking the WhatsApp session). It is served only
  on the authenticated API and must never be logged or shared.

## Endpoints

### Public

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/health` | `{ "status": "ok" }` | readiness probe |
| GET | `/api/setup/status` | `SetupStatus` | `{ "needsSetup": bool }` |
| POST | `/api/setup` | `CreateAdminResponse` (201) | One-time first-run setup. Returns 10 recovery codes **exactly once**. `409` if already completed. |
| POST | `/api/auth/login` | `OkResponse` | Sets the session cookie. |
| POST | `/api/auth/recover` | `OkResponse` | Single-use recovery code + new password. Invalidates all sessions. |

Login and recovery share one soft throttle (not a hard lock): 5 failed
attempts within a 60-second sliding window start a 60-second cooldown
(`429` with an accurate `Retry-After`); every attempt made while cooling
down doubles the cooldown, capped at 5 minutes. A successful login or
recovery clears the state. Behind the dashboard proxy all clients share
**one** throttle bucket — the proxy strips client-supplied forwarding
headers, so the bucket key cannot be chosen by clients — which means one
user's wrong-password spree can briefly deny login (and recovery) to
others. That availability trade-off is deliberate and bounded (at most
5 minutes after the last attempt); operator escape hatches are the
server-side CLI password reset (`npm run reset-password -w
@summarly/backend`) and restarting the backend, which clears the
in-memory throttle.

### Session (authentication required)

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/logout` | `OkResponse` | Deletes the session and cookie. |
| POST | `/api/auth/password` | `OkResponse` | Requires the current password. Invalidates all sessions. |

### Application (authentication required)

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/api/connection` | `ConnectionStatus` | Non-secret WhatsApp connection state. `linking` carries the pairing QR + expiry while linking (see session control below); `null` otherwise. `check` carries the latest live session health probe (`pending`/`ok`/`failed`), or `null` when none was requested. |
| GET | `/api/groups` | `Group[]` | Monitored groups. |
| GET | `/api/groups/:id` | `Group` | Single group (detail screen). `400` non-UUID id; `404` unknown. |
| GET | `/api/groups/:id/members` | `GroupMember[]` | Best-effort roster snapshot (admin names first, then alphabetical). `[]` when no chat is discovered yet. **Monitored groups only** (fix round B, H-1): `409` with `"Group is not monitored."` when the group is not monitored (same privacy boundary as history import), `404` unknown group. Names/JIDs are PII (admin-only data). |
| GET | `/api/groups/:id/messages` | `ApiMessagePage` | Chat view, newest first (`items` + `nextCursor`; the cursor is emitted only when another page truly exists). Query: `from`/`to` half-open `[from, to)` ISO instants, `limit` 1-200 (default 50), `cursor` = previous `nextCursor`. `400` on an invalid range, limit, or cursor (including a non-UUID cursor id); `404` unknown group. |
| GET | `/api/groups/:id/summaries` | `GroupSummary[]` | Past summaries, newest first, each with the run `interval` and `provider`/`model`. Query: `limit` 1–200 (default 20). |
| GET | `/api/contacts` | `ContactSummary[]` | People who are active members of at least one **monitored** group, aggregated by canonical identity (PN JID when known, else LID). Includes their monitored groups, message count, and last message time. Names/phones/JIDs are PII (admin-only). |
| GET | `/api/contacts/:id` | `ContactDetail` | One contact plus its JID `aliases`. `404` unknown contact. `:id` is the canonical contact id (a JID, not a UUID) and must be URL-encoded. |
| PATCH | `/api/contacts/:id` | `ContactDetail` | Admin display-name override (`{ "name": "..." }`, 1–300 chars). It wins over roster/WhatsApp names and survives automatic refreshes. `400` invalid name; `404` unknown contact. |
| GET | `/api/contacts/:id/messages` | `ContactMessagePage` | Messages sent by the contact across monitored groups, newest first, each with `groupId`/`groupName`. Same `from`/`to`/`limit`/`cursor` semantics as the group chat view; `404` unknown contact. |
| PATCH | `/api/groups/:id` | `Group` | Partial update. `summaryTime: null` clears the daily cutoff. `historyImport` is system-managed and never changed by PATCH. |
| POST | `/api/groups/:id/history-import` | `Group` (202/200) | Request a WhatsApp history import (opt-in, ADR 0007). `409` when the group is not monitored; `200` when an import is already pending/running; `202` otherwise (including re-requests after done/failed). |
| POST | `/api/summary-runs` | `SummaryRun` (201/200) | Create-or-find (see conventions). Optional `instructions` (1–2000 chars) steers how the summary is produced (see custom instructions below). Non-terminal runs are queued for the summary-worker (`generate-summary`, docs/decisions/0003); enqueue failures leave the run `pending` and are repaired by reconciliation. |
| GET | `/api/summary-runs` | `RunListResponse` | Newest first. `nextCursor` is `null` in the skeleton. |
| GET | `/api/summary-runs/:id` | `SummaryRun` | |
| POST | `/api/summary-runs/:id/retry` | `SummaryRun` | `failed → pending` **and re-enqueues the run**; no-op for `pending`/`processing`; `409` for `completed` (regeneration is an open decision). |
| POST | `/api/connection/logout` | `{ "ok": true }` (202) | End/unlink the WhatsApp session (see session control below). Idempotent: `202` also while a request is pending. |
| POST | `/api/connection/test` | `{ "ok": true }` (202) | Requests a live session health probe. The bot-worker performs a bounded WhatsApp query and writes the result to `ConnectionStatus.check`; poll `GET /api/connection` for `pending` → `ok`/`failed`. |
| GET | `/api/summaries/:id` | `Summary` | `404` until the summary-worker has completed the run. |
| GET | `/api/summary-runs/:id/summary` | `Summary` | `404` for an unknown run or a run without a summary yet. |
| GET | `/api/settings/ai-provider` | `ProviderConfigPublic` | `404` when unconfigured. Never returns key material. |
| PUT | `/api/settings/ai-provider` | `ProviderConfigPublic` | Upsert. `apiKey`: omit = keep, string = replace, `null` = clear. |
| GET | `/api/settings/default-timezone` | `DefaultTimezoneSettings` | Global IANA zone for NEW groups and the summary form's initial value. |
| PUT | `/api/settings/default-timezone` | `DefaultTimezoneSettings` | Sets the global default zone (`{ "timezone": "America/Caracas" }`). `400` unknown zone. |

AI provider strings (ADR 0005): enter `provider: "google-gemini"` with
`model: "gemini-3.8-flash"` (or the cheaper `gemini-3.5-flash-lite`) to
use the Gemini adapter; `provider: "mock"` (or leaving the settings
unconfigured) selects the deterministic mock adapter used by tests.
Provider failures surface as safe run error codes on the run
(`error.code`, e.g. `provider_auth`, `provider_rate_limit`,
`provider_config`, `too_large`) with fixed messages — raw provider
error text is never stored or shown. Summary items in the
consequential sections carry `sourceRefs` (message ids + timestamps)
that were verified against the stored messages; rendering the cited
message text itself is a tracked follow-up, so the "verify against
sources" notice means "check the ids/timestamps against your records",
not clickable citations yet.

Note: `GET /api/summary-runs/:id/summary` is the primary result lookup for
a run — it returns the `Summary` schema and answers `404` (standard error
envelope) both when the run is unknown and when it has no summary yet.
With PostgreSQL persistence the backend now also requires `DATABASE_URL`
and `ENCRYPTION_KEY` (see `.env.example`); saved provider keys are stored
encrypted (AES-256-GCM) and never returned.

## Run state machine

```
pending → processing → completed
                     ↘ failed → (retry) → pending
```

Runs progress **automatically**: a created run is enqueued into the
BullMQ `summaries` queue (payload = the run id only, docs/decisions/0003),
consumed by the summary-worker, and marked `completed` together with its
summary. `GET /api/summary-runs/:id/summary` then returns the `Summary`.
Reconciliation (backend, every 60 s by default) re-enqueues runs that
stay `pending`/`processing` too long, so a lost job or a queue outage
never strands a run.

**Empty periods are valid.** A run whose interval contains no messages
completes normally with a summary whose overview states the period was
empty and whose sections are all empty — `404` from the summary
endpoints only means "not finished yet" (or an unknown run), never
"nothing to summarize". (The exact overview wording is adapter
behavior, not part of this API contract.)

**Scheduled runs (`kind: "scheduled"`).** The backend's scheduler
(ADR 0006) creates one run per monitored group per day, covering the
**previous calendar day** in the group's time zone — the half-open
window `[00:00, 24:00)` local, stored as instants — once the group's
cutoff is reached: its `summary_time` (HH:mm, set per group in the
dashboard) or the install default `DEFAULT_SUMMARY_TIME` (env, default
`09:00`). Exactly one run can exist per group/window (create-or-find),
the scheduler never re-runs a window, and a missed enqueue is recovered
by reconciliation. What the admin configures: per group `monitored`,
`timezone`, `summary_time`; per install `SCHEDULER_ENABLED`,
`SCHEDULER_INTERVAL_MS`, `DEFAULT_SUMMARY_TIME`. Scheduled runs flow
through the same state machine and summary endpoints as manual runs;
`POST /api/summary-runs/:id/retry` applies to them unchanged.

## History import

When the admin switches a group to monitored, the dashboard asks
whether to also retrieve the group's older WhatsApp messages. Accepting
calls `POST /api/groups/:id/history-import`, which records the request
on the group (`historyImport`, ADR 0007); the bot-worker performs the
actual import and reports progress back. Behavior and limits:

- **Opt-in per monitored group, user-driven.** Only monitored groups
  can ever be imported (409 otherwise) and nothing is fetched without
  this explicit request — the ADR 0004 privacy boundary is preserved.
- **Bounded and partial by WhatsApp's data.** The import is capped in
  messages/time (bot-worker budget) and WhatsApp only serves the
  history it makes available — there is no full-archive guarantee.
  `importedCount` reports what was actually stored. Reaching a budget
  cap ends the import as `done` with a partial count (a successful
  bounded backfill, ADR 0007); `failed` is reserved for real errors
  (`history_unavailable`, `history_timeout`, `group_unmonitored`,
  `history_internal` — the safe catch-all for unexpected importer
  crashes).
  Imported messages never update the connection's `lastMessageAt`.
- **Visible progress on the group.** `Group.historyImport` (nullable)
  carries `status` (`pending`/`running`/`done`/`failed`),
  `requestedAt`/`startedAt`/`finishedAt`, `importedCount`, and a safe
  `error` code/short message — never message content or secrets. It is
  system-managed: PATCH cannot set it and discovery never resets it.
- **Repeatable.** While `pending`/`running` a new request is an
  idempotent `200`; after `done`/`failed` a new request is accepted
  (`202`) and resets the progress fields.
- **Consent is revocable.** Un-monitoring a group cancels a `pending`
  import (the request never fires later); an import already `running`
  is left to the bot-worker to abort, and `done`/`failed` history is
  kept as record.
- **Data retention.** Imported messages are ordinary `messages` rows
  carrying their historical `sent_at` — retention and purge by
  group/chat/date apply to them exactly as to live capture, and the two
  are indistinguishable in storage (a provenance column is a tracked
  follow-up).

## Custom summary instructions (ADR 0008)

`POST /api/summary-runs` accepts an optional `instructions` string
(trimmed, 1–2000 chars) steering how the summary is produced — e.g.
"focus on decisions and ignore chit-chat". Semantics:

- Stored on the run (`summary_runs.instructions`) and echoed on
  `SummaryRun.instructions` (`null` when the request carried none). On
  the create-or-find repeat path the **first** request's instructions
  win (run identity excludes them).
- The queue payload stays identifier-only (docs/decisions/0003): the
  summary-worker reads `instructions` from the run row and delivers it
  to the AI adapter through a dedicated provider-neutral channel
  (`AiSummaryInput.instructions`), truncated defensively at 2000 chars.
- **Separation rule:** adapters present the instructions as a clearly
  labelled ADMIN INSTRUCTIONS section, separate from both the system
  instruction and the delimited conversation data block — message text
  is untrusted data and never crosses into it (and vice versa). See
  `docs/decisions/0008`.
- The mock adapter does not follow instructions; it only records
  deterministically that some were provided (its overview gains a fixed
  note).

## Group detail and session control (ADR 0008)

**Group detail.** `GET /api/groups/:id` returns the group itself;
`/members`, `/messages`, and `/summaries` provide what the group
detail screens render (see the endpoint table for shapes and
pagination):

- `GroupMember` rows are a **best-effort roster snapshot** maintained
  by the bot-worker - WhatsApp does not replay membership history, so
  the list may be incomplete or stale until the next refresh. Leavers
  stay in the roster as `active: false` history. Sorted admin names
  first, then alphabetical. **Names** are resolved from WhatsApp
  contacts and message push names (group metadata carries only JIDs);
  when no name has been observed, `phone` (the PN JID) is a fallback
  identifier for LID-addressed groups, and `null` means the member is
  LID-only. **Rosters are monitored-only** (fix round B, H-1): both the
  bot-worker's roster sync and this endpoint require the group to be
  monitored (`409` otherwise), matching the ADR 0004 opt-in boundary —
  un-monitoring revokes roster access too.
- `ApiMessage` keeps the stored body verbatim (including `senderName`,
  the WhatsApp push name captured with the message). When the captured
  push name is missing, the API falls back to the member's current
  roster name (matched by LID/PN alias), so older messages still show
  the name once it is learned. The chat view paginates newest-first;
  `from`/`to` filter the half-open instant range `[from, to)`.
- `GroupSummary` is a `Summary` plus the run's `interval` (what period
  the summary covers) and its `provider`/`model`.
- **Names and JIDs are PII** (admin-only data, like the message bodies
  already stored). They are never logged and are covered by the normal
  retention/purge rules.

**Contacts.** `/api/contacts` derives a contact list from the rosters
of monitored groups only. A contact is aggregated by canonical identity
(PN JID when known, otherwise LID), and includes the monitored groups
where the person is an active member plus their message count. The
detail endpoint exposes the contact's JID aliases and the messages it
sent across monitored groups, each tagged with its group. Unmonitoring
a group removes its members and messages from this surface immediately.
There is no global address book: people who are not on a monitored
group's roster never appear.

**Session control.** The connection screen shows the linking QR and can
end the session:

- While the session is being linked, `GET /api/connection` carries
  `linking: { kind, qr, expiresAt }` — the pairing payload published by
  the bot-worker (`kind` is `qr` or `pairing-code`; payloads published
  without a kind are served as `qr`). It is a **live pairing ticket**:
  authenticated API only, never logged. `linking` is served **only**
  while the session is being linked — state `connecting` or
  `disconnected` — and the payload is unexpired; it is `null` once
  connected or when the QR has expired (audit M-4). API responses are
  sent with `Cache-Control: no-store, private` and `Vary: Cookie` so no
  cache along the way retains the ticket.
- `POST /api/connection/logout` records the admin's END/UNLINK request
  (`logout_requested_at` on the connection row) and answers `202
  {"ok": true}` — idempotent, an already-pending request keeps its
  original timestamp. The API never touches the session itself: the
  **bot-worker consumes the flag** (ends the session, clears the stored
  credentials, resets the connection state) and clears the request.
  Until then the request stays pending and visible in server state.
- `POST /api/connection/test` requests a **live session health check**.
  The bot-worker performs a bounded probe (socket open + a lightweight
  WhatsApp USync status query) and writes `ConnectionStatus.check` with
  `status` (`pending`/`ok`/`failed`), latency, timestamp, and a safe error
  code. It never returns message content or credentials. Poll
  `GET /api/connection` until the status leaves `pending`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend listen port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` inside containers. |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `REDIS_URL` | — (required) | Redis connection string for BullMQ queue state (summary runs; docs/decisions/0003) |
| `ENCRYPTION_KEY` | — (required) | Base64 for 32 random bytes; encrypts stored provider keys (AES-256-GCM) |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs/CIDRs whose `X-Forwarded-For` is trusted for client-IP derivation (rate limiting) |
| `RECONCILE_INTERVAL_MS` | `60000` | Cadence of the summary-run reconciliation pass (positive integer, milliseconds; the floor is 1000) |
| `SUMMARY_QUEUE_PREFIX` | `summarly` | BullMQ key-prefix namespace for the summary queue (backend + summary-worker must agree; tests use `summarly-test`, e2e `summarly-e2e`) |
| `SCHEDULER_ENABLED` | `true` | Daily-summary scheduler on/off (true/false) |
| `SCHEDULER_INTERVAL_MS` | `60000` | Scheduler pass cadence (positive integer, milliseconds; the floor is 1000) |
| `DEFAULT_SUMMARY_TIME` | `09:00` | Install default daily cutoff (HH:mm) for groups without `summary_time` |
| `BACKFILL_DAYS` | `3` | Bounded missed-day recovery depth: each pass also schedules missing windows for the previous N local days (integer, clamped 1–31) |
| `MAX_MESSAGES_PER_RUN` | `2000` | Cost/size cap: runs with more messages fail with `too_large` (permanent) |
| `MAX_CHUNKS_PER_RUN` | `10` | Cost/size cap: runs needing more provider chunks fail with `too_large` (permanent) |
| `AI_REQUEST_TIMEOUT_MS` | `120000` | Bounded timeout for one AI provider request (positive integer, milliseconds) |
| `AI_ALLOW_CUSTOM_BASE_URL` | `unset` | PRIVILEGED opt-in (`yes`): allows saving a non-Google provider base URL — the API key is sent to that host (ADR 0005). Internal targets stay rejected regardless. |
| `HISTORY_IMPORT_POLL_MS` | `5000` | bot-worker: how often the importer polls for `pending` history imports |
| `HISTORY_IMPORT_BATCH_COUNT` | `100` | bot-worker: messages requested per history batch |
| `HISTORY_IMPORT_MAX_ROUNDS` | `20` | bot-worker: maximum history batches per import |
| `HISTORY_IMPORT_MAX_MESSAGES` | `2000` | bot-worker: message budget per import (reaching it ends the import `done`, partial) |
| `HISTORY_IMPORT_TIME_BUDGET_MS` | `120000` | bot-worker: wall-clock budget per import |
| `SUPERVISE_WORKERS` | `true` | Backend worker supervision (ADR 0008 round 3): the backend spawns/restarts/stops the summary-worker and bot-worker children itself. Set `false` when the workers run separately — e2e does, and the future deployment Compose must (no application Compose exists yet). |
| `SESSION_CONTROL_POLL_MS` | `3000` | bot-worker: how often session control is polled (pairing QR/pairing-code publication and consuming the admin's end/unlink request) |

## Security notes

- Passwords are hashed with scrypt (see `docs/decisions/0002`).
- Recovery codes are single-use **128-bit** codes, shown once, and stored as
  SHA-256 hashes.
- Login and recovery share the soft throttle above. Behind the dashboard
  proxy there is **one shared bucket** (the proxy strips client-supplied
  forwarding headers, so they cannot be trusted); direct connections are
  bucketed by socket peer, with `X-Forwarded-For` honored only from
  `TRUSTED_PROXIES` peers. Never add an untrusted address there: it would
  let clients choose their own bucket.
- Rate-limited responses carry an accurate `Retry-After` header (≤ 5
  minutes; see the soft-throttle semantics above).
- Password change and recovery invalidate all existing sessions.
- The backend binds to loopback by default; do not expose it to untrusted
  networks without HTTPS and a reviewed authentication model.
- `ConnectionStatus.linking.qr` is a **live pairing ticket** for the
  WhatsApp session: served on the authenticated API only, never logged,
  same sensitivity class as the session state itself (ADR 0004/0008).
- Member names, sender names, and JIDs are **PII**: admin-only API
  data, never logged, and covered by the retention rules below.

## Data retention

- Captured messages (`messages`) are **retained until deleted**. There is
  **no automatic expiry in the MVP**; the retention policy has not been
  productized yet (tracked for Phase E/F — see `docs/decisions/0004` §11).
- The explicit deletion path today is the operator CLI
  `npm run purge-messages -w @summarly/backend` (by group id, chat id,
  and/or a `--before <ISO date>` cutoff; destructive, with a typed
  confirmation or an explicit `--yes` flag; it reports counts only).
  It covers **both** captured messages and the `group_members` roster
  (fix round A, audit M-2/M5 — names/JIDs live in both): a
  chat-scoped purge removes the full roster of those chats (including
  departed members kept as history), a date-only purge removes roster
  rows last updated before the cutoff, and an empty resolved scope
  deletes nothing. There is no API or dashboard deletion endpoint yet.
- **Database backups are as sensitive as the WhatsApp session volume**:
  dumps contain full conversations and phone-number-bearing sender JIDs.
  Encrypt and rotate dumps, restrict their access — and remember that
  purging rows does not remove them from backups taken earlier.
- Sender names (`messages.sender_name`) travel with their message rows
  and are purged by the same command. The member roster
  (`group_members`) is a separate best-effort snapshot carrying names
  and JIDs; it is **monitored-only** (fix round B, H-1 — the API gate
  and the bot-worker's sync require a monitored group, and migration
  0006 removes rows captured before the gate), `purge-messages` covers
  it (see above), and it otherwise follows the same retention policy —
  it should be included in any future automated retention pass
  (tracked with retention productization, `docs/decisions/0004` §11).
