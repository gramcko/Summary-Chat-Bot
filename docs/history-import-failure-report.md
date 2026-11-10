# History import failure report

**Date:** 2026-11-09  
**Scope:** WhatsApp on-demand history import (`POST /api/groups/:id/history-import`, ADR 0007)  
**Status:** Code-path defects fixed; live import still returns no history payload. Remaining cause is most likely environmental (phone not answering / no older history / unsupported account).

## Executive summary

The import request is now well-formed and is sent to WhatsApp, but the linked phone returns **no `messaging-history.set` payload and no peer-data response code**. The bot waits for the first batch and then records `history_timeout` after the 30-second round timeout.

Several real code bugs were found and fixed along the way:

1. The first request used an empty history cursor. WhatsApp requires a real oldest-message key; an empty key is silently ignored.
2. The batch size defaulted to 100, above WhatsApp’s 50-message on-demand limit.
3. A `TypeError` in the JID predicate aborted the entire offline-node/receipt batch when Baileys passed an undefined `from` JID.
4. Non-`ON_DEMAND` history responses were dropped even when they echoed our outstanding peer-data request id.

After those fixes, the request is sent with a valid anchor and a valid count, but the phone still does not answer. That points to the phone/account side rather than the request shape.

## What the import does

1. Backend stores a `pending` import on the group.
2. Bot-worker claims it, reads the oldest captured message for the chat, and calls `fetchMessageHistory(count, oldestMsgKey, oldestTimestampMs)`.
3. WhatsApp relays a peer-data request to the primary phone.
4. The phone should return a `historySyncNotification`; Baileys emits `messaging-history.set`.
5. The adapter filters the payload to the requested chat, the service ingests it idempotently, and progress/completion is written to PostgreSQL.

A round with no first batch after 30 seconds is recorded as `history_timeout`.

## Evidence from the live test

- The import status moved `pending → running → failed` with `history_timeout` after ~30 seconds.
- The Baileys request was actually sent: the debug log showed `sending message to 1 devices` with a relayed message id.
- No `got history notification`, no `messaging-history.set`, and no peer-data failure code arrived.
- The offline preview contained regular messages (e.g. 20 messages) but **zero notifications**, so the history response was not in that batch.
- After fixing the undefined-JID `TypeError`, the offline-node/receipt errors disappeared; the import still timed out.
- Using the **newest** captured message as the anchor produced the same timeout, so the anchor choice is not the current blocker.
- The group had only a few captured messages; it may have no older history for the phone to return.
- The new **session health probe succeeds** (about 100 ms), so the bot’s socket/session can reach WhatsApp. This rules out a dead local session as the cause of the import timeout; the remaining gap is the phone’s on-demand history response.

## Confirmed causes (fixed)

### 1. Empty first cursor

`fetchMessageHistory` requires a real oldest-message key. The original first round passed an empty id and timestamp `0`. WhatsApp ignores that request, which surfaced as a timeout.

**Fix:** seed the first cursor from the oldest captured message in PostgreSQL. If the chat has no captured messages, fail fast with `history_no_anchor`.

### 2. Batch size above the WhatsApp cap

The default batch count was 100. WhatsApp caps on-demand history at 50 messages per query; larger values are silently ignored.

**Fix:** default and validate at 50, and clamp defensively in the adapter.

### 3. Undefined JID crashed offline-node processing

Baileys calls `shouldIgnoreJid(node.attrs.from)` for receipts and offline nodes. Some stanzas have no `from`; the predicate called `.endsWith` on `undefined`, throwing a `TypeError` that aborted the whole offline batch. That could hide a history response.

**Fix:** treat a missing/empty JID as “ignore” instead of throwing.

### 4. Non-`ON_DEMAND` history responses were dropped

The adapter only allowed `HistorySyncType.ON_DEMAND`. Some phones answer an on-demand request with a different sync type while echoing our peer-data session id.

**Fix:** allow a non-`ON_DEMAND` payload only when its `peerDataRequestSessionId` matches an outstanding request; `mapHistorySet` still drops other chats.

### 5. No distinction between “no history” and “timeout”

If the phone answers with success but no history payload, the service waits the full round timeout and reports a failure. The current UI has a friendly message, but the state is still `failed`.

**Recommended fix:** parse the success peer-data response and, if no history notification follows within a short grace window, finish as `done` with 0 imported (no older history) instead of `failed`.

## Remaining suspected causes

These are ordered by likelihood based on the evidence.

### 1. The linked phone is offline or not connected

On-demand history is served by the **primary phone**, not by WhatsApp’s servers. The bot’s companion session can be `connected` and the new session probe can succeed while the phone itself is offline. In that case the peer-data request is sent but never answered.

**How to confirm:** open WhatsApp on the phone, keep it online, and retry. The new session test button probes the bot’s session; a success does not prove the phone is online.

**Fix:** keep the phone online; a phone-presence probe (not just the bot socket) would be needed to fail fast.

### 2. The group has no older history available

If the captured messages are the beginning of the chat, the phone may have nothing older to return. Some clients answer with success and no payload; Baileys currently ignores that success response.

**How to confirm:** test on a group known to have months of history.

**Fix:** treat a successful peer-data response with no history payload as `done` (0 imported).

### 3. The account/phone does not support on-demand history

The response-code enum includes `ERROR_REQUEST_ON_NON_SMB_PRIMARY` and `ERROR_HOSTED_DEVICE_NOT_CONNECTED`. Baileys is an unofficial client; support varies by account type, platform, and WhatsApp version.

**How to confirm:** the phone returns a non-zero peer-data response code; we now parse and surface it. If no response is returned at all, this cannot be confirmed from the bot side.

**Fix:** document the limitation; there is no reliable workaround inside Baileys. A re-link or a different account may help, but this is not guaranteed.

### 4. The session is stale or partially registered

The session credentials show `registered: false` and `accountSyncCounter: 0`, and the session has no app-state sync key. The new session probe succeeds, so the socket is reachable, but these missing state pieces may still affect some server/phone flows.

**How to confirm:** re-link the account and retry. A fresh session may restore the missing state.

**Fix:** re-link if the phone is online and imports still fail; expose session health in the dashboard (state, last message, app-state sync, phone probe).

### 5. The response is dropped before the adapter

If the phone sends a history notification from a JID the adapter treats as non-self, `shouldIgnoreJid` drops it before decryption. The current predicate allows group chats, the account’s own PN/LID users, and `@s.whatsapp.net`.

**How to confirm:** enable safe protocol logging (no content) and check whether a `HISTORY_SYNC_NOTIFICATION` arrives and whether `shouldProcessHistoryMsg` is true.

**Fix:** only broaden the predicate if evidence shows a legitimate self/phone JID being dropped; do not open the filter to DMs or arbitrary users.

### 6. Chat JID mismatch in the payload

`mapHistorySet` keeps only messages whose `remoteJid` exactly matches the requested chat JID. If the phone returns a LID/PN variant of the group JID, the payload would be dropped.

**How to confirm:** log the response chat JID shape (server part only, no user data) and compare it to the requested chat JID.

**Fix:** normalize the chat JID before comparison if this is observed; do not normalize blindly across different chats.

## Recommended plan

### Short term (operator)

1. Keep WhatsApp open and online on the linked phone.
2. Retry the import on a group known to have older history.
3. If it still fails, re-link the WhatsApp session from **Connection** and retry.
4. Use the new **Test session** button to confirm the live session is working before importing.

### Short term (code)

1. Add a session health probe and require it before an import; surface `history_phone_offline` when it fails.
2. Parse the success peer-data response and finish as `done` with 0 if no history arrives within a short grace window.
3. Keep the safe diagnostic logs: request sent, response code, sync type, payload received (counts only).
4. Add an integration test with a mocked “success but no payload” response and a “failure code” response.

### Medium term

1. Add an operator-visible import diagnostic panel: last request time, last response code, last payload count, phone probe result.
2. Document account/phone support limitations in the dashboard and README.
3. Consider a controlled one-time initial history sync for a group **only with explicit consent**, if the product accepts the privacy trade-off; this is not recommended for the default flow.

## What not to do

- Do not enable full history sync globally just to make imports work; it violates the privacy boundary in ADR 0004.
- Do not retry indefinitely on permanent failures (`history_phone_offline`, `history_declined`, unsupported account).
- Do not log message bodies, JIDs, phone numbers, or session secrets while debugging.
- Do not assume `connected` means the phone is online; they are different states.

## Relevant code paths

- `bot-worker/src/history-import.ts` — claim, cursor, rounds, timeout, completion.
- `bot-worker/src/whatsapp/baileys-adapter.ts` — `requestHistory`, `onHistorySet`, `shouldSyncHistoryMessage`, JID filter, PDO response parsing.
- `bot-worker/src/db.ts` — `getOldestMessageCursor`, import state.
- `backend/src/lib/postgres-store.ts` — import state read/write.
- `docs/decisions/0007-history-import.md` — design and known limitations.

## Web research update (2026-11-10)

The remaining failure is consistent with a known Baileys/WhatsApp limitation
for companion devices, not a local request-shape defect:

- `fetchMessageHistory` returns a request id but the phone never sends a
  `HISTORY_SYNC_NOTIFICATION` / `messaging-history.set` payload:
  Baileys #2452 and #1934.
- Baileys v7 had a separate regression where the event was not emitted even
  for initial sync; it was fixed by marking peer-routed self stanzas as
  `fromMe` (commit `5ddc231`). The pinned 6.7.24 already includes that
  decode fix.
- WhatsApp Web's own on-demand flow requires the initial history sync and
  app-state sync to be complete before it accepts the response
  (whatsapp-web.js #201890).
- WhatsApp's help center confirms that linked devices receive a recent
  history window (Desktop receives more than Web) and that there is no
  full-archive guarantee.

Implemented mitigations:

1. `WA_HISTORY_SYNC=recent` lets the connect-time RECENT/INITIAL_BOOTSTRAP
   sync complete (payload dropped) so the protocol state machine and
   app-state sync run. Try this first, then re-link.
2. `WA_HISTORY_SYNC=full` additionally requests `syncFullHistory` with a
   Windows Desktop browser preset and captures initial/full history for
   monitored groups only. This is the reliable backfill path; it requires a
   re-link and is opt-in because of the ADR 0004 privacy posture.
3. A phone `REQUEST_SUCCESS` with no history payload now finishes as
   `done` with 0 imported instead of `history_timeout`.
4. Safe diagnostics were added for initial-sync drops/captures and
   success-without-payload; no message content is logged.

If `full` still imports nothing after a re-link, the remaining causes are
phone/account-side (primary offline, account type unsupported, or WhatsApp
not returning history for that chat).
