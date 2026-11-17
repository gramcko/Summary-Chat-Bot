# Summarly Chat Bot

Self-hosted application that captures authorized WhatsApp group messages and
turns them into verifiable daily summaries. Built with TypeScript, PostgreSQL,
Redis/BullMQ, and a Next.js dashboard.

> **Unofficial integration.** WhatsApp capture uses
> [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), an
> unofficial WhatsApp Web client. It is not an official WhatsApp API and can
> break or be restricted by upstream changes.

## Features

- **WhatsApp linking** — QR or phone-number pairing code from the dashboard;
  in-app **End session / Unlink** (remote revoke), **Delete connection data**
  (local session reset + fresh QR), plus a live **Test session** health probe.
- **Group discovery and opt-in monitoring** — groups are discovered
  unmonitored; the admin opts each one in.
- **Daily and manual summaries** — scheduled or on-demand, per group, with
  IANA time zones and half-open intervals.
- **Complete group capture** — every message in a monitored group, including
  the linked account's own messages, is captured for summarization.
- **Custom summary instructions** — per-run guidance sent as a separate,
  labelled channel to the AI provider.
- **Group detail** — summaries, member roster, chat history, and settings.
- **Contacts** — people who participate in monitored groups, the groups they
  are in, and the messages they sent across those groups.
- **Contact name overrides** — admins can rename a contact; the override wins
  over WhatsApp/roster names.
- **Search and filters** — groups and contacts can be searched/filtered.
- **Dashboard assistant** — ask questions in English or Spanish over
  monitored data: "do a summary on Equipo Ventas today", "which groups
  does Ana participate in?", "when did Ana talk about the launch?".
  Answers cite the groups, messages, or runs they used; conversations
  stay in the browser and are never stored. When Gemini is configured, a
  model call may classify the question and an optional second call may
  rewrite the reply text, but the tools, citations, and runs always come
  from monitored data.
- **Live notifications** — toasts for summary requested/started/completed/
  failed, history-import requests, and contact renames.
- **Collapsible sidebar** - icon-only rail on desktop, full labels when open;
  clicking a navigation item collapses it again.
- **History import** — bounded, best-effort backfill of older messages for a
  monitored group (WhatsApp decides what history is available).
- **Default time zone setting** — used for new groups, as the initial value
  in the summary request form, and for generic dashboard timestamps.
- **Default date format setting** — choose DD/MM/YYYY, MM/DD/YYYY,
  YYYY-MM-DD, or DD MMM YYYY for dates across the dashboard.
- **AI provider settings** — Google Gemini or the deterministic mock provider;
  saved API keys are encrypted server-side and never returned to the browser.

## Architecture

| Service | Responsibility |
| --- | --- |
| `backend` | HTTP API, authentication/authorization, use cases, group/run/contact data, scheduling/reconciliation, worker supervision |
| `bot-worker` | Owns the Baileys socket, session lifecycle, incoming WhatsApp events, message normalization, roster capture, history import |
| `summary-worker` | Consumes summary jobs, reads messages from PostgreSQL, calls the AI adapter, validates output, persists summaries |
| `dashboard` | Next.js admin UI. Talks only to the backend API — never directly to PostgreSQL or Redis |
| `packages/contracts` | Shared Zod schemas and inferred TypeScript types |

- **PostgreSQL** is the source of truth for messages, groups, runs, summaries,
  contacts, and settings.
- **Redis** is used by BullMQ for queue state only. It is not the permanent
  store for chat history or completed results.
- WhatsApp-specific behavior is isolated behind an adapter; AI providers behind
  a shared interface.

## Requirements

- Node.js **20 or newer**
- npm (workspaces)
- Docker (recommended for local PostgreSQL + Redis)
- A WhatsApp account you are authorized to link

## Quick start (development)

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL + Redis
docker compose -f docker-compose.dev.yml up -d

# 3. Create your local environment
#    Copy the example and fill in the values. Never commit .env.
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
```

Generate a master key for encrypted provider credentials:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put it in `ENCRYPTION_KEY` in `.env`. For local development on Windows (where
the session directory lives inside the repository), also set:

```env
WA_SESSION_ALLOW_INSECURE=yes
```

`.env.example` ships `COOKIE_SECURE=true` because the production stack serves
HTTPS. If your browser refuses the session cookie over plain HTTP during
development, set `COOKIE_SECURE=false`.

Apply migrations:

```bash
npm run migrate -w @summarly/backend up
```

Start the backend (it supervises the summary-worker and bot-worker by default)
and the dashboard in separate terminals:

```bash
npm run dev -w @summarly/backend
npm run dev -w @summarly/dashboard -- -p 3001
```

Open `http://localhost:3001`, complete the one-time `/setup` screen, then link
WhatsApp on the **Connection** page (QR or pairing code).

> The backend listens on `3000` by default; the dashboard uses `3001` in dev.
> The dashboard proxies `/api/*` to `BACKEND_URL` (default
> `http://127.0.0.1:3000`).

### First-use flow

1. Complete `/setup` (admin password + recovery codes).
2. Link WhatsApp from **Connection**.
3. Open **Groups**, opt a group into monitoring, and optionally import older
   history.
4. Open the group to see **Summaries**, **Members**, **Messages**, and
   **Settings**.
5. Request a summary from **Summary runs** (a group opened from its detail
   page is preselected, and the period defaults to the group's latest
   messages) or wait for the daily schedule.
6. Use **Contacts** to see who participates in monitored groups and their
   cross-group messages.

## Docker deployment

The production stack (PostgreSQL, Redis, migrations, backend, both workers,
dashboard, and Caddy for TLS) runs on a single host:

```bash
npm run setup -- --domain summarly.example.com   # generates .env, builds and starts
```

The setup script writes `.env` with a generated PostgreSQL password and
`ENCRYPTION_KEY` (generated locally, never printed) and runs
`docker compose up -d --build --wait`. Use `--domain localhost` for a local
install, `--no-start` to only create `.env`, and `--force` to overwrite an
existing `.env`. Manual equivalent:

```bash
cp .env.example .env    # set DOMAIN, POSTGRES_PASSWORD, ENCRYPTION_KEY
docker compose up -d --build --wait
```

Only Caddy publishes ports (80/443); PostgreSQL and Redis stay private. The
`migrate` service applies schema migrations before the application services
start. See **[docs/deployment.md](docs/deployment.md)** for prerequisites, DNS
and firewall, first-run `/setup`, WhatsApp linking, volumes, backups/restore,
upgrades and recovery.

Back up and restore the running stack with:

```bash
npm run backup -- --include-env --keep 14    # DB dump + WhatsApp session
npm run restore -- backups/<timestamp>       # restore, then restart the stack
```

Backups contain chat data and WhatsApp session credentials; encrypt them and
back up `ENCRYPTION_KEY` separately. See
[docs/deployment.md](docs/deployment.md#backups-and-restore).

## Configuration

All variables live in the repository-root `.env` (ignored by Git). See
`.env.example` for the full annotated list. Key variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `PORT`, `HOST` | Backend bind address (default `127.0.0.1:3000`) |
| `ENCRYPTION_KEY` | Base64 32-byte master key for stored AI provider keys |
| `COOKIE_SECURE` | Set `true` when the dashboard is served over HTTPS |
| `TRUSTED_PROXIES` | Reverse proxies allowed to supply `X-Forwarded-For` |
| `SUPERVISE_WORKERS` | `true` (default) lets the backend spawn/supervise workers |
| `WA_SESSION_DIR` | Protected Baileys session directory (default `./wa-session`) |
| `WA_PHONE_NUMBER` | Optional; use pairing-code linking instead of QR |
| `WA_HISTORY_SYNC` | `off` (default), `recent`, or `full` connect-time history policy |
| `DEFAULT_GROUP_TIMEZONE` | Fallback IANA zone for new groups |
| `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`, `DEFAULT_SUMMARY_TIME` | Daily scheduler |
| `MESSAGE_RETENTION_DAYS` | Delete captured messages older than N days (`0`/unset keeps forever; messages only) |
| `RETENTION_INTERVAL_MS` | Retention pass cadence (default one day; floor `60000`) |
| `HISTORY_IMPORT_*` | Bounded history-import budgets |

The **AI provider**, the **default time zone**, and the **default date format**
are configured in the dashboard's **Settings** page.

## Database migrations

```bash
npm run migrate -w @summarly/backend up
npm run migrate -w @summarly/backend down
```

Migrations include the group roster (`group_members`), message sender names,
history-import state, session control, contact name overrides
(`contact_overrides`), global settings (`app_settings`), and the dashboard
assistant's message search (the `pg_trgm` extension plus a GIN trigram index
on `messages.body`; migration 0013). The database role must be allowed to
`CREATE EXTENSION pg_trgm` — the migration fails loudly otherwise.

## Commands

From the repository root:

```bash
npm run setup       # production Docker setup: generate .env + start the stack
npm run backup      # production backup: PostgreSQL dump + WhatsApp session
npm run restore     # restore a backup directory (see docs/deployment.md)
npm run build       # build contracts, backend, workers, dashboard
npm run typecheck   # type-check every workspace
npm test            # unit tests for every workspace
npm run test:integration  # PostgreSQL/Redis integration suites
npm run test:e2e    # end-to-end check (starts real services)
```

Workspace examples:

```bash
npm run dev -w @summarly/backend
npm run dev -w @summarly/dashboard -- -p 3001
npm test -w @summarly/bot-worker
npm test -w @summarly/summary-worker
npm test -w @summarly/dashboard
npm run migrate -w @summarly/backend up
npm run reset-password -w @summarly/backend
```

Integration tests require a throwaway PostgreSQL database whose name ends in
`_test` (or contains `_e2e_`) and Redis. See `docs/api.md` and
`docker-compose.dev.yml` for details.

## Project layout

```text
backend/          HTTP API, auth, store, routes, migrations
bot-worker/       Baileys adapter, capture service, roster, history import
summary-worker/   queue consumer, AI adapters, summary pipeline
dashboard/        Next.js admin UI
packages/contracts/  Shared Zod schemas/types
docs/             Architecture, API, and decision records
scripts/          Provider smoke test and e2e harness
```

## Privacy and security

- `.env`, `dashboard/.env.local`, `wa-session/`, `dist/`, `.next/`, and
  `node_modules/` are gitignored. Never force-add them.
- The WhatsApp session state can link your account. Treat it as a secret and
  keep it out of logs, APIs, and unencrypted backups.
- Chat messages, member names, phone JIDs, and summaries are PII. They are
  served only on the authenticated admin API, are never logged by default, and
  are covered by the retention/purge rules.
- **Automatic message retention.** `MESSAGE_RETENTION_DAYS` deletes captured
  messages older than N days on a periodic backend pass
  (`RETENTION_INTERVAL_MS`, default one day); `0`/unset keeps them forever.
  Only messages are deleted — summaries, summary runs, groups, rosters, and
  settings are kept, so a summary's source-message references may point at
  messages that no longer exist. Backups taken earlier still contain the
  deleted messages.
- Saved AI provider API keys are encrypted at rest with AES-256-GCM; the
  browser only ever sees whether a key is saved.
- PostgreSQL and Redis are private to the Compose network/loopback in dev.
  Do not expose the dashboard to an untrusted network without deciding on the
  remote-access authentication model first.
- The dashboard proxy strips client-supplied forwarding headers before
  forwarding `/api/*` to the backend.
- **Danger zone:** `POST /api/admin/delete-all-data` (body exactly
  `{ "confirmation": "DELETE ALL" }`) permanently deletes all captured
  data — groups, messages, summary runs, summaries, rosters, and contact
  overrides — and clears the connection's last-message time. It keeps
  settings, the AI provider configuration, admin credentials/sessions,
  the WhatsApp connection row/state, and the Baileys session directory
  (the session stays linked). Backups taken earlier still contain the
  data.
- **End session / Unlink vs. Delete connection data.** `POST
  /api/connection/logout` revokes the linked device on WhatsApp first and
  then clears the local session. `POST /api/connection/reset` is the
  recovery path for a partial/invalid session: it skips the remote
  revoke, deletes only the LOCAL Baileys session data, keeps captured
  data and settings, and re-arms QR linking so a fresh QR appears.

## Limitations

- **Baileys is unofficial** and may break when WhatsApp changes its protocol.
- **History import is best-effort.** On-demand history is served by the linked
  phone, so the phone must be online. WhatsApp may return less than requested,
  nothing, or several batches. A group with no captured messages has no anchor
  for on-demand paging (`history_no_anchor`). On-demand is unreliable on some
  companion devices; `WA_HISTORY_SYNC=recent` (let the initial sync complete)
  or `full` (opt-in capture of monitored groups' initial history) are the
  supported fallbacks. `full` only applies to an already-linked session: link
  first with `off`/`recent`, then restart the worker with `full` — a fresh
  registration that requests full history is closed by WhatsApp (428) before
  any QR appears.
- **Group metadata carries only JIDs**, not names. Names come from saved
  contacts, message push names, or an admin override. LID-only members may show
  a phone number or “Unknown contact”.
- **Roster refresh is best-effort and on-demand.** Members are captured on
  discovery and on membership changes, and only for monitored groups — so a
  group discovered before it was monitored (for example after "delete all
  data", when groups are re-created unmonitored) starts with an empty roster.
  Enabling monitoring requests a refresh automatically, and the Members tab can
  request one manually (`POST /api/groups/:id/roster-sync`, migration 0016).
  The bot-worker serves it on its next session-control poll (≈3 s); WhatsApp
  may still return no metadata, in which case nothing is written (members are
  never deactivated by an empty result) and the admin can retry.
- Summaries are AI-generated. Consequential items should be verified against
  the source messages; the UI displays this warning.
- Media transcription, vector search, Kubernetes, and multi-tenant SaaS
  features are intentionally out of scope for the MVP.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system architecture and data flow
- [`docs/api.md`](docs/api.md) — HTTP API reference
- [`docs/history-import-failure-report.md`](docs/history-import-failure-report.md) — history-import failure analysis and fixes
- [`docs/decisions/`](docs/decisions/) — architecture decision records (ADRs)
- [`AGENTS.md`](AGENTS.md) — repository working rules and verification commands
- [`dashboard/README.md`](dashboard/README.md) — dashboard-specific notes

## License

MIT © 2026 Summarly Chat Bot contributors. See [`LICENSE`](LICENSE).
