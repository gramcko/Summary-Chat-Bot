# Summarly dashboard

Next.js (App Router) + React + TypeScript + Tailwind CSS v4 frontend for
Summarly Chat Bot.

## Backend access

The browser only talks to this app; the dashboard proxies `/api/:path*` to the
backend (architecture §4.1) so the httpOnly `summarly_session` cookie stays
same-origin and no CORS setup is needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_URL` | `http://127.0.0.1:3000` | Backend base URL used by the rewrite (server-side only) |

Copy `.env.example` to `.env.local` for local development. Never expose the
backend directly to an untrusted network, and never put API keys or session
tokens in environment variables prefixed with `NEXT_PUBLIC_`.

`BACKEND_URL` is read when the Next.js config loads. Rewrite destinations are
written into `.next/routes-manifest.json` at build time, so set the variable for
`next build` (and for `next dev`); changing it after a production build has no
effect until the app is rebuilt.

### Proxy header sanitization

The backend rate-limits login/recovery per `request.ip` and trusts
`x-forwarded-for` only from `TRUSTED_PROXIES` (loopback by default — exactly
where this proxy connects from). A client-chosen `x-forwarded-for` would
therefore let anyone pick their own rate-limit bucket or lock out an arbitrary
third-party address.

`src/proxy.ts` (Next.js 16 `proxy`, formerly middleware; Node runtime) runs
before the rewrite and deletes every client-address header — `x-forwarded-for`,
`x-real-ip`, `forwarded`, and the common CDN variants (`src/lib/forwarding-headers.ts`).
It always adds a constant `x-summarly-proxy: strip` marker: Next only applies the
header override when the resulting set is non-empty, so the marker keeps the
override unconditional (no fail-open edge) and shows that the sanitizer ran.
Cookies, bodies, status codes, and response headers (including `set-cookie`) are
untouched: the rewrite still owns the proxying.

This is the "strip" design, chosen after verification: on Next.js 16.4.3 there
is no public way to read the TCP socket address from a route handler or from
`proxy()` (`NextRequest` has no `ip`; the internal request symbol holds only
`{ cookies, nextUrl, url }`), and Next fills `x-forwarded-for` from the socket
only when the client omitted it while passing a client-supplied value through
verbatim — the two cases cannot be told apart. Stripping means the backend sees
the proxy's loopback address for everyone: one shared rate-limit bucket (no
bucket shopping, no third-party lockout). If a trustworthy client address
becomes available from Next's public API, `src/lib/forwarding-headers.ts` is the
single place to start forwarding it.

A route-handler proxy would have allowed the same sanitization, but it replaces
the `/api/:path*` rewrite, which `scripts/e2e.mjs` (owned outside this package)
asserts in `.next/routes-manifest.json`; the middleware design keeps that
contract intact.

## Commands (workspace-scoped)

```bash
npm run dev -w @summarly/dashboard        # http://localhost:3000? see note below
npm run typecheck -w @summarly/dashboard  # tsc --noEmit
npm run build -w @summarly/dashboard      # production build
npm run start -w @summarly/dashboard      # serve the production build
npm test -w @summarly/dashboard           # unit tests (node:test): api layer + helpers
npm run smoke -w @summarly/dashboard      # end-to-end smoke check, see below
```

The backend defaults to port 3000, so run the dashboard on another port for
local development, e.g. `npx next dev -p 3001` from this directory (or set
`PORT=3001`). The proxy target is controlled by `BACKEND_URL`.

## Smoke check

`npm run smoke -w @summarly/dashboard` is self-contained and reproducible: it
starts the contract test double in `scripts/smoke-stub.mjs` (no PostgreSQL,
Redis, WhatsApp, or AI provider required), rebuilds the app with `BACKEND_URL`
pointing at that stub — Next bakes the rewrite destination at build time — runs
`next start` on port 3100, drives the real HTTP surface, and tears everything
down. It exits non-zero if any check fails.

It covers the `/api` proxy for GET/POST/PATCH/PUT, the httpOnly session cookie
round-trip, error-envelope passthrough with `details[].path`, `401` handling,
`createRun`'s 201-vs-200 behaviour (including custom `instructions`),
retry conflicts, provider key write-only behaviour, the group detail endpoints
(single group, members, paged/filtered messages, past summaries), the connection
status + idempotent unlink, every page, and that neither the backend origin nor
the session cookie value leaks into the served HTML or client bundles.

It also asserts the proxy sanitization end to end: the test double records the
headers it actually received, so spoofed `x-forwarded-for`, `x-real-ip`,
`forwarded`, and CDN client-IP headers must be absent, no `x-forwarded-for` may
be invented for clients that send none, and the session cookie must still
arrive.

Environment overrides: `SMOKE_BACKEND_PORT` (default `3999`), `SMOKE_APP_PORT`
(default `3100`), `SMOKE_SKIP_BUILD=1` to reuse an existing `.next` build (it
must then have been built with the same `BACKEND_URL`).

Because the build bakes the rewrite destination, the run rebuilds `.next` for
the caller's `BACKEND_URL` — or the built-in default when the variable is unset
— **on both the success and failure paths**, then verifies the destination in
`.next/routes-manifest.json`. A later `next start` therefore never silently
proxies to the smoke stub. With `SMOKE_SKIP_BUILD=1` no build is touched, so
nothing is restored.

## Screens

The app shell is a left sidebar (Overview, Groups, Contacts, Summary runs,
Connection, Settings) with sign-out at the bottom. On desktop it is an
icon-only rail that expands on hover/focus with an animated overlay; on small
screens it becomes a focus-trapped drawer. A skip link, `<nav>`/`<main>`
landmarks, visible focus rings, and `aria-live` async states are part of the
shell. Summary-run status changes and other actions raise in-app toast
notifications.

- `/setup` — one-time administrator password + recovery codes (shown once).
- `/login`, `/recover` — session sign-in and single-use recovery code flow.
- `/` — connection health, recent summary runs, group shortcuts.
- `/connection` — live WhatsApp pairing payload (a QR code, or a typed pairing
  code when the bot worker is configured with a phone number), refreshed while
  linking with an expiry countdown, connection details, a **Test session**
  live health probe, and an **End session / Unlink** action
  (`POST /api/connection/logout`, confirmed; polling continues until the
  re-armed pairing payload appears).
- `/groups` — every captured group, with monitored/import badges, search by
  name/chat id, and an All / Monitored / Not monitored filter.
- `/groups/[id]` — tabs: **Summaries** (past summaries per group, link to the
  run), **Members** (roster with names, phone fallback, admin/left badges),
  **Messages** (read-only chat with a half-open from/to filter in the group time
  zone and “Load older” cursor paging), **Settings** (monitored toggle +
  history-import flow, time zone, daily cutoff).
- `/contacts` — people who are active members of monitored groups, searchable
  by name/phone/id and filterable by group; each row shows the groups and
  message count.
- `/contacts/[id]` — contact detail with monitored groups, cross-group messages
  (tagged with the group), and an **Edit name** override.
- `/runs` — request a manual summary (type-to-filter group picker that starts
  empty, optional custom instructions, 0–2000 characters with a counter) and
  browse run history.
- `/runs/[id]` — run status, retry, custom instructions, and tabs for the
  generated **Summary** and the **Messages used** (the run's half-open
  interval).
- `/settings` — AI provider configuration (the API key is write-only) and the
  global **Default time zone** used for new groups and the summary form.

## Notes

- The only added runtime dependency is `qrcode` (pinned `1.5.4`, plus
  `@types/qrcode`), used client-side to render the pairing ticket as an image.
  The ticket itself is a live credential: it is never logged, linked, or shown
  as text.
- Responses are typed with `@summarly/contracts`. Only types are imported, so
  the shared Zod schemas never ship to the browser bundle.
- Every API call goes through `src/lib/api.ts`, which always sends
  `credentials: "include"`, parses the standard error envelope, and redirects to
  `/login` on `401` (except on the auth screens).
- Validation mirrors the contract rules (`HH:mm`, password ≥ 12, IANA time
  zone). Server-side `error.details[].path` entries are mapped back onto the
  matching form fields.
- `src/lib/api.ts` exposes `setBrowserLocationForTests`, a narrow test seam that
  lets `tests/api.test.ts` cover the `401 → /login` rule without a DOM. It is
  only used by tests; passing `null` restores the real `window.location`.
- `src/proxy.ts` is load-bearing for security, not just plumbing: it removes
  client-address headers before the `/api` rewrite. Do not delete it.
  `tests/forwarding-headers.test.ts` covers the sanitizer, `tests/proxy-wiring.test.ts`
  guards the proxy entry point and matcher coverage with plain `npm test`, and
  `npm run smoke -w @summarly/dashboard` asserts the real proxy path end to end.
