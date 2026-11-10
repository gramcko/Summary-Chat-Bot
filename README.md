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
  in-app **End session / Unlink**, plus a live **Test session** health probe.
- **Group discovery and opt-in monitoring** — groups are discovered
  unmonitored; the admin opts each one in.
- **Daily and manual summaries** — scheduled or on-demand, per group, with
  IANA time zones and half-open intervals.
- **Custom summary instructions** — per-run guidance sent as a separate,
  labelled channel to the AI provider.
- **Group detail** — summaries, member roster, chat history, and settings.
- **Contacts** — people who participate in monitored groups, the groups they
  are in, and the messages they sent across those groups.
- **Contact name overrides** — admins can rename a contact; the override wins
  over WhatsApp/roster names.
- **Search and filters** — groups and contacts can be searched/filtered.
- **Live notifications** — toasts for summary requested/started/completed/
  failed, history-import requests, and contact renames.
- **Collapsible sidebar** — icon-only rail on desktop, full labels when open.
- **History import** — bounded, best-effort backfill of older messages for a
  monitored group (WhatsApp decides what history is available).
- **Default time zone setting** — used for new groups, as the initial value
  in the summary request form, and for generic dashboard timestamps.
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
5. Request a summary from **Summary runs** (or wait for the daily schedule).
6. Use **Contacts** to see who participates in monitored groups and their
   cross-group messages.

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
| `DEFAULT_GROUP_TIMEZONE` | Fallback IANA zone for new groups |
| `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`, `DEFAULT_SUMMARY_TIME` | Daily scheduler |
| `HISTORY_IMPORT_*` | Bounded history-import budgets |

The **AI provider** and the **default time zone** are configured in the
dashboard's **Settings** page.

## Database migrations

```bash
npm run migrate -w @summarly/backend up
npm run migrate -w @summarly/backend down
```

Migrations include the group roster (`group_members`), message sender names,
history-import state, session control, contact name overrides
(`contact_overrides`), and global settings (`app_settings`).

## Commands

From the repository root:

```bash
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
- Saved AI provider API keys are encrypted at rest with AES-256-GCM; the
  browser only ever sees whether a key is saved.
- PostgreSQL and Redis are private to the Compose network/loopback in dev.
  Do not expose the dashboard to an untrusted network without deciding on the
  remote-access authentication model first.
- The dashboard proxy strips client-supplied forwarding headers before
  forwarding `/api/*` to the backend.

## Limitations

- **Baileys is unofficial** and may break when WhatsApp changes its protocol.
- **History import is best-effort.** On-demand history is served by the linked
  phone, so the phone must be online. WhatsApp may return less than requested,
  nothing, or several batches. A group with no captured messages has no anchor
  for on-demand paging (`history_no_anchor`).
- **Group metadata carries only JIDs**, not names. Names come from saved
  contacts, message push names, or an admin override. LID-only members may show
  a phone number or “Unknown contact”.
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
