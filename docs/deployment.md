# Deployment (Docker Compose, single host)

Summarly runs as one Docker Compose stack on a single host: PostgreSQL,
Redis, a one-shot migration job, the backend API, the two workers, the Next.js
dashboard, and Caddy as the only public entry point.

```
Internet ──► Caddy :80/:443 ──► dashboard :3000 ──/api/*──► backend :3000
                                                              │
                                          ┌───────────────────┼───────────────────┐
                                          ▼                   ▼                   ▼
                                      postgres             redis           summary-worker
                                                              │                   │
                                                              └──── BullMQ ───────┘
                                                          bot-worker ──► wa-session volume
```

Everything except Caddy is on the private Compose network: PostgreSQL, Redis,
the backend and the dashboard publish **no** host ports.

Files involved:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Production stack |
| `docker/app.Dockerfile` | One image for backend, summary-worker, bot-worker and `migrate` |
| `docker/dashboard.Dockerfile` | Next.js dashboard image |
| `docker/Caddyfile` | TLS termination + reverse proxy to the dashboard |
| `scripts/setup.mjs` | One-command setup: generates `.env` and starts the stack (`npm run setup`) |
| `scripts/backup.mjs` | Backup: database dump + WhatsApp session volume (`npm run backup`) |
| `scripts/restore.mjs` | Restore a backup directory and restart the stack (`npm run restore`) |
| `.dockerignore` | Keeps secrets, sessions, tests and build output out of images |
| `.env.example` | Every variable, with safe placeholders |

## Prerequisites

- Docker Engine 24+ with Compose v2 (`docker compose version`).
- ~2 GB free disk for images, plus room for the database and backups.
- A host with a public DNS name if you want automatic HTTPS.
- A WhatsApp account you are authorized to link (Baileys is an **unofficial**
  WhatsApp Web client and can be restricted by upstream changes).

## 1. DNS and firewall

- Point an `A`/`AAAA` record (for example `summarly.example.com`) at the host.
- Open only:
  - `80/tcp` — ACME HTTP challenge and the HTTPS redirect,
  - `443/tcp` and `443/udp` — HTTPS (HTTP/3).
- Do **not** expose 5432 (PostgreSQL), 6379 (Redis), 3000 (backend/dashboard).
  They are reachable only inside the Compose network.

For a local install without DNS, leave `DOMAIN=localhost` and skip this step.

## 2. Create `.env`

Compose reads the repository-root `.env` for interpolation (`POSTGRES_*`,
`DOMAIN`) and passes the whole file to the application services
(`env_file: .env`). The stack refuses to start without it.

### Automated (recommended)

```bash
npm run setup -- --domain summarly.example.com
```

`scripts/setup.mjs` (Node 20+, no dependencies, cross-platform) generates the
file and then starts the stack. It:

1. Refuses to touch an existing `.env` unless you pass `--force`.
2. Copies `.env.example`, keeping every comment and placeholder, and replaces
   `DOMAIN`, `POSTGRES_PASSWORD`, `ENCRYPTION_KEY` and `COOKIE_SECURE`.
   The two secrets are generated **locally** with `node:crypto`:
   - `POSTGRES_PASSWORD` = 24 random bytes, base64url (URL-safe, safe inside
     `DATABASE_URL`),
   - `ENCRYPTION_KEY` = 32 random bytes, base64 (AES-256-GCM master key).
   They are written to `.env` only — **never printed to the terminal or to
   logs**. `.env` is created with mode `0600` on POSIX (best effort on
   Windows, where NTFS ACLs are your responsibility).
3. Checks `docker compose version`; if Compose v2 is missing it prints the
   prerequisites and exits `1` without writing `.env`.
4. Runs `docker compose up -d --build --wait`. If that fails it prints
   `docker compose logs --tail=200` and exits `1`, leaving `.env` and all
   volumes intact.

| Option | Effect |
| --- | --- |
| `--domain <name>` | Public host name for Caddy and the printed URL. Also read from `$DOMAIN`. Default `localhost`; when omitted on an interactive terminal it prompts `Domain [localhost]:` |
| `--no-start` | Only create `.env`; do not call Docker Compose |
| `--force` | Overwrite an existing `.env` (generates **new** secrets) |
| `--help` | Print usage and exit `0` |

Notes:

- `--force` changes `POSTGRES_PASSWORD`. The existing `summarly_postgres-data`
  volume keeps the old password, so the stack will fail to authenticate until
  you either recreate the database or update the role's password. Read
  [Backups and restore](#backups-and-restore) first; nothing is deleted automatically.
- `--domain` accepts a bare host name; a pasted `https://…/` URL is normalized,
  and anything that is not a host name is rejected (exit `2`).
- Rerunning without `--force` is safe: it exits `1` and changes nothing, so
  `npm run setup` is never a destructive command.
- An existing *development* `.env` (from `cp .env.example .env` before this
  stack existed) usually has no `POSTGRES_PASSWORD`, and Compose refuses to
  start without it. Add one manually, or let the script generate one with
  `--force` — safe as long as no production `summarly_postgres-data` volume
  exists yet.

### Manual fallback

If you prefer to build the file by hand (or cannot run Node yet):

```bash
cp .env.example .env
```

Then set at least:

| Variable | Notes |
| --- | --- |
| `DOMAIN` | Public host name (`localhost` for a local install) |
| `POSTGRES_USER`, `POSTGRES_DB` | Database role and name (default `summarly`) |
| `POSTGRES_PASSWORD` | Long random value. Keep it URL-safe or percent-encode it — it is embedded in `DATABASE_URL` |
| `ENCRYPTION_KEY` | Base64 of exactly 32 random bytes; encrypts stored AI provider keys |
| `COOKIE_SECURE` | `true` behind Caddy's HTTPS (the `.env.example` default) |
| `TRUSTED_PROXIES` | Leave `127.0.0.1,::1`: the dashboard is the backend's only client and it strips client-supplied forwarding headers |

Generate the two secrets (they are printed here — do not paste them into
shell history on a shared host; the setup script avoids that entirely):

```bash
# ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
# POSTGRES_PASSWORD (URL-safe, no escaping needed)
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

### Applies to both paths

**Compose sets these inside the containers; do not set them for production:**

- `DATABASE_URL` → `postgres://…@postgres:5432/…` built from `POSTGRES_*`
- `REDIS_URL` → `redis://redis:6379`
- `WA_SESSION_DIR` → `/data/wa-session` (the `wa-session` volume)
- `HOST=0.0.0.0`, `PORT=3000`, `SUPERVISE_WORKERS=false`

The development values already in `.env.example` (`DATABASE_URL` on
`127.0.0.1`, `WA_SESSION_DIR=./wa-session`, `HOST=127.0.0.1`) are harmless:
they are overridden for the production stack. Never put real secrets in
`.env.example` or in any committed file.

**Leave these unset in a production `.env`:**

- `WA_SESSION_ALLOW_INSECURE` — it exists to acknowledge unsafe *development*
  session storage; with it set, the bot-worker skips verifying that the
  session directory is owner-only (`0700`).
- `LOG_FILE` — Docker captures stdout/stderr and rotates it; a file inside
  `/app` would not be writable by the non-root user anyway. Use
  `docker compose logs -f` instead.
- `NEXT_ALLOWED_DEV_ORIGINS` — development-only, ignored by `next start`.

## 3. Start the stack

`npm run setup` already does this. To start (or restart) manually:

```bash
docker compose up -d --build --wait
```

What happens, in order:

1. `postgres` and `redis` start and become healthy.
2. `migrate` runs `npx tsx scripts/migrate.ts up` against PostgreSQL and exits.
   Every other application service waits for `service_completed_successfully`.
3. `backend` starts, then becomes healthy on `GET /health`.
4. `summary-worker` and `bot-worker` start.
5. `dashboard` starts once the backend is healthy.
6. `caddy` starts once the dashboard is healthy and obtains/renews TLS.

First build takes a few minutes; later builds reuse cached layers.

## 4. First run

1. Open `https://<DOMAIN>/` (or `https://localhost/`).
2. Complete the one-time **`/setup`** screen: admin password + recovery codes.
   Keep the recovery codes somewhere safe and offline.
3. Go to **Connection** and link WhatsApp:
   - the bot-worker runs with `WA_LINKING_DISPLAY=none`, so the QR / pairing
     payload is published to PostgreSQL and rendered on this page — check the
     bot-worker logs if it does not appear;
   - QR codes are live pairing tickets: do not screenshot or share them.
4. Open **Settings** and configure the AI provider (Google Gemini, or the
   deterministic mock) and the default time zone.
5. Open **Groups**, opt a group into monitoring, optionally import history, and
   request a summary or wait for the daily schedule.

## Ports, storage and health

| Service | Host ports | Internal port | Health |
| --- | --- | --- | --- |
| `caddy` | `80`, `443`, `443/udp` | `80`, `443` | — |
| `dashboard` | none | `3000` | `GET /login` via Node `fetch` |
| `backend` | none | `3000` | `GET /health` via Node `fetch` |
| `postgres` | none | `5432` | `pg_isready` |
| `redis` | none | `6379` | `redis-cli ping` |
| `summary-worker` | none | — | restart policy only (no HTTP surface) |
| `bot-worker` | none | — | restart policy only (no HTTP surface) |
| `migrate` | none | — | one-shot, exit code |

Health checks use Node's built-in `fetch`, so the images do not need `curl`.
A container that is "Up" is not automatically ready — always rely on the
health status (`docker compose ps`).

## Volumes

| Volume | Contents | Sensitivity |
| --- | --- | --- |
| `summarly_postgres-data` | Messages, groups, runs, summaries, settings, encrypted provider keys | High — chat data |
| `summarly_redis-data` | BullMQ queue state (AOF) | Low — not a source of truth |
| `summarly_wa-session` | Baileys session credentials | **Critical** — can link the WhatsApp account |
| `summarly_caddy-data` | TLS certificates and the local CA | Medium — private key |
| `summarly_caddy-config` | Caddy runtime config | Low |

Never run `docker compose down -v` on a live install: `-v` deletes these
volumes, including the WhatsApp session and the database. `docker compose down`
alone keeps them.

## Backups and restore

Two dependency-free Node scripts (cross-platform, Node 20+) drive the
production backup and restore. Both read the repository-root `.env` for
`POSTGRES_USER` and `POSTGRES_DB` (the backup also records `DOMAIN` in
`summary.txt`), and both operate on the running Compose stack, so
`docker compose` must be available and the `postgres` service must be running
and healthy.

| Command | Effect |
| --- | --- |
| `npm run backup` | Writes a timestamped backup directory under `backups/` |
| `npm run restore -- backups/<timestamp>` | Restores that directory and restarts the stack |

### Taking a backup

```bash
npm run backup                          # database + WhatsApp session
npm run backup -- --include-env --keep 14
npm run backup -- --no-session          # database only
```

Each run creates `backups/<UTC timestamp>/` (for example
`backups/20261116-201530Z/`) containing:

| File | Contents |
| --- | --- |
| `summarly.dump` | `pg_dump -Fc` of the `postgres` service: messages, groups, runs, summaries, settings and encrypted provider keys |
| `wa-session.tar.gz` | Archive of the `wa-session` volume, taken with a one-off `bot-worker` container (skipped with `--no-session`) |
| `env.backup` | Copy of `.env` at mode `0600` (only with `--include-env`; contains secrets) |
| `summary.txt` | Timestamp, `DOMAIN`, database names and file sizes — no secrets |

| Option | Effect |
| --- | --- |
| `--include-env` | Also copy `.env`, which holds `POSTGRES_PASSWORD` and `ENCRYPTION_KEY` |
| `--no-session` | Skip `wa-session.tar.gz` |
| `--keep <n>` | After a successful run, delete older `backups/YYYYMMDD-HHMMSSZ/` directories beyond the newest `n`. Only directories matching that exact pattern are touched; manually named files or directories are left alone |
| `--help` | Print usage |

Notes:

- The dump is streamed from `pg_dump` to disk, so a large database does not
  need extra RAM. A failed or empty dump is deleted and the script exits `1`
  rather than leaving a truncated file that looks restorable.
- The script refuses to run when Compose is unavailable or `postgres` is not
  running **and healthy** (it does not treat a started container as ready).
- The dump and the session archive are taken from the live stack, not from a
  single atomic snapshot. For a perfectly consistent session copy, stop the
  writer first: `docker compose stop bot-worker`, take the backup, then
  `docker compose start bot-worker`. Messages already committed to PostgreSQL
  are always included; an in-flight WhatsApp write may not be.
- Not included: Redis (queue state only — pending runs are reconciled from
  PostgreSQL), Caddy TLS data (re-obtained automatically), and Docker
  images/configuration (keep the Git checkout and `.env`).

### `ENCRYPTION_KEY` is not in the dump

`ENCRYPTION_KEY` encrypts the AI provider API keys stored in PostgreSQL. It
lives only in `.env`, so it must be backed up separately — with
`--include-env`, in a password manager, or on an offline note.

Restoring a dump without the matching key does not lose messages or
summaries, but the saved provider keys stay unreadable: the ciphertext
remains and must be replaced by re-entering the keys in Settings. Treat the
key with the same care as the database dump.

### Protect the backups

A backup directory contains message bodies and group metadata (PII) and,
unless `--no-session` was used, WhatsApp session credentials that can link
the account. `env.backup` adds the database password and the encryption key.

- Encrypt before copying off the host, for example:
  `tar -C backups -czf - 20261116-201530Z | age -p > 20261116-201530Z.tar.gz.age`
  or `gpg -c 20261116-201530Z.tar.gz`.
- Keep `backups/` owner-only (the script creates each backup directory `0700`
  where the OS supports it) and never commit it — `.gitignore` already
  excludes it.
- Do not attach unencrypted backups to tickets, chat, or email.
- Anyone who can talk to the Docker daemon can read these volumes; restrict
  that access too.
- Delete backups you no longer need. Retention is your responsibility:
  `--keep` prunes local timestamped directories, not copies stored elsewhere.

### Restoring

```bash
npm run restore -- backups/20261116-201530Z
```

The script:

1. Validates the directory (`summarly.dump` is required) and reads `.env`.
2. Asks for the typed confirmation `RESTORE` unless `--yes` is passed.
   Non-interactive shells are refused without `--yes`.
3. Stops `backend`, `summary-worker`, `bot-worker`, `dashboard` and `caddy`.
   `postgres` and `redis` keep running — the dump is fed through the running
   server, and Redis holds only rebuildable queue state.
4. Restores the database:
   `pg_restore -U <user> -d <db> --clean --if-exists --no-owner --no-privileges`.
   This **replaces all current data** and cannot be undone.
5. With `--with-session`, clears `/data/wa-session` and extracts
   `wa-session.tar.gz` into the volume. Destructive to the current session.
6. Runs `docker compose up -d --wait`, which re-runs the idempotent `migrate`
   one-shot before the application services start.

Before restoring:

- Take a fresh backup of the current state (`npm run backup`).
- Put the matching `ENCRYPTION_KEY` into `.env` **first**. An `env.backup` in
  the directory is **not** restored automatically — copy values deliberately.
- If the dump came from a different installation, review `.env` for
  `DOMAIN`, `POSTGRES_PASSWORD` and `COOKIE_SECURE` before starting.

`--with-session` is destructive to the current session: the archived
credentials replace whatever is linked now. If WhatsApp has since invalidated
them, unlink and re-link the account from the Connection page. Without the
flag, the current session is left untouched (the database restore alone does
not require re-linking).

If a step fails, the script does not start the application services. It
prints `docker compose logs --tail=200` plus recovery steps. Fix the cause and
rerun the same command; it is safe to repeat. Never "fix" a restore with
`docker compose down -v` — that deletes the database and the WhatsApp session
volume.

### Scheduling and retention

Backups are not automatic. On a Linux host, a daily cron entry:

```cron
# Daily at 03:15, keep 14 timestamped backups, log outside the repo
15 3 * * * cd /srv/summarly && /usr/bin/npm run backup -- --keep 14 >> /var/log/summarly-backup.log 2>&1
```

Equivalent systemd units:

```ini
# /etc/systemd/system/summarly-backup.service
[Unit]
Description=Summarly backup
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/summarly
ExecStart=/usr/bin/npm run backup -- --keep 14
```

```ini
# /etc/systemd/system/summarly-backup.timer
[Unit]
Description=Daily Summarly backup

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

`--keep` only prunes directories the script itself created
(`backups/YYYYMMDD-HHMMSSZ/`). It is local retention, not disaster
protection: copy encrypted backups to another host or object store, and
verify that copies are readable. The scripts print only paths and sizes, so
scheduled logs stay free of secrets and chat contents.

### Test a restore

Restoring replaces data, so test on a scratch host or a throwaway Compose
project — never against the live stack:

1. `npm run backup -- --include-env`
2. Copy the backup directory and `.env` to the scratch host.
3. `npm run restore -- backups/<timestamp> --with-session`
4. Open the dashboard: groups, messages, summaries and settings should be
   present, and provider keys should decrypt with the same `ENCRYPTION_KEY`.
5. Send a test message in a monitored group and confirm the workers still
   ingest and summarize.
6. Check `docker compose ps`: every service should be running/healthy.

Repeat this after changing the schema or upgrading a major version, and
before relying on backups for a real incident.

## Upgrades

```bash
# Optional: keep the previous image for rollback
docker tag summarly-app:local summarly-app:previous
docker tag summarly-dashboard:local summarly-dashboard:previous

git pull
docker compose build
docker compose up -d          # reruns the `migrate` one-shot, then restarts services
docker compose logs -f migrate
```

Rules:

- Volumes are **not** touched by a normal upgrade. Do not add `-v`.
- Migrations are applied by the `migrate` service before the backend starts;
  the stack does not start if they fail.
- Run migrations explicitly when needed:
  `docker compose run --rm migrate` (or `docker compose run --rm migrate down`
  to step back one migration — read the migration first: some are destructive).
- To roll back the code: re-tag the saved images and recreate the services:

  ```bash
  docker tag summarly-app:previous summarly-app:local
  docker tag summarly-dashboard:previous summarly-dashboard:local
  docker compose up -d --no-build
  ```

  A schema that is already ahead of the old code may need the matching `down`
  migration (read it first).

## Recovery from a failed deployment

| Symptom | Check | Fix |
| --- | --- | --- |
| `npm run setup` exits 1: "`.env` already exists" | — | Expected on an existing install. Start with `docker compose up -d --build --wait`, or rerun with `--force` (new secrets) after reading [Backups and restore](#backups-and-restore) |
| `npm run setup` exits 1: "Docker Compose v2 is not available" | `docker compose version` | Install Docker Engine 24+ with the Compose v2 plugin, then rerun; no `.env` was written |
| `migrate` exits non-zero | `docker compose logs migrate` | Fix the reported error (usually `DATABASE_URL`/credentials or a failed migration) and rerun `docker compose run --rm migrate` |
| Backend unhealthy | `docker compose logs backend` | Missing `ENCRYPTION_KEY`, invalid config value, or PostgreSQL not reachable |
| Dashboard unhealthy | `docker compose logs dashboard` | Backend not healthy yet; check the baked `BACKEND_URL` (rebuild needed if it changed) |
| Caddy cannot get a certificate | `docker compose logs caddy` | DNS not pointing at the host, or 80/443 blocked |
| Bot-worker exits | `docker compose logs bot-worker` | Session directory permissions (`0700`), or `DATABASE_URL` |
| QR never appears | `docker compose logs bot-worker` + Connection page | Restart the worker; unlink/relink if the session is stale |

Never "fix" a failed deployment with `docker compose down -v` unless you
intend to delete the data and have a verified backup.

## Logs and operations

```bash
docker compose ps                       # health and state
docker compose logs -f                  # everything
docker compose logs -f backend          # one service
docker compose logs --tail=200 caddy
```

Logs are rotated by Docker (`json-file`, 10 MB × 3 per service) so a long
running stack does not fill the disk. Application logs contain identifiers and
error codes only — never message bodies, API keys or session secrets.

Restart a single service without touching the others:

```bash
docker compose restart backend
docker compose up -d --no-deps --build summary-worker
```

## Caddy and `DOMAIN=localhost`

- With a real `DOMAIN`, Caddy obtains a Let's Encrypt certificate and renews it
  automatically. Ports 80/443 must be reachable from the internet.
- With the default `DOMAIN=localhost`, Caddy uses its **local CA**. Browsers
  warn until you trust the root certificate:

  ```bash
  docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
  ```

  Then import `caddy-root.crt` into your OS/browser trust store. This is fine
  for a single machine; use a real domain for anything shared.
- `COOKIE_SECURE=true` matches the HTTPS endpoint. If you deliberately serve
  plain HTTP, set it to `false` — but do not expose an unauthenticated
  dashboard to an untrusted network either way.

## Known limitations

- Single-host only: no horizontal scaling, no Kubernetes. Redis and PostgreSQL
  are private to the Compose network. Backups are not automatic: schedule
  `npm run backup` (see [Backups and restore](#backups-and-restore)) and copy
  the encrypted results off the host.
- The bot-worker links one WhatsApp account; Baileys is unofficial and may
  break after WhatsApp Web changes. Keep the image updated deliberately.
- Provider data handling depends on the configured AI provider and its current
  policy; Summarly cannot guarantee retention behavior on the provider side.
- `BACKEND_URL` is baked into the dashboard at build time. If you change it,
  rebuild the dashboard image (`docker compose build dashboard`).
