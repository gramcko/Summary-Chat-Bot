# 0009 — Dashboard assistant (MVP)

- **Status:** Accepted (2026-11-16) — MVP round 1 (contracts, backend,
  dashboard) is in the tree. Round 2 added an OPTIONAL, planner-only
  Gemini integration: the model classifies the question, the
  deterministic service still builds every reply. Round 3 adds an
  optional Gemini answer COMPOSER: the model may rewrite the
  deterministic reply text, while tools, citations, runs, and the
  fallback stay deterministic.

## Context

The dashboard already exposes monitored groups, captured messages,
contacts, and summary runs, but the admin has to know which screen and
filter to use. Admins asked for a natural-language entry point: "do a
summary on Equipo Ventas today", "which groups does Ana participate
in?", "when did Ana talk about the launch?". The MVP has to answer those
questions without widening the privacy boundary, adding an AI cost
surface, or giving the browser a way to reach data it cannot already
read.

Questions to settle here: what the assistant may do, how intents and
entities are resolved, where conversations live, how summary creation
and message search are executed, and which limits are honest to state.

## Decision

### Dashboard-only, authenticated admin surface

`POST /api/assistant/chat` is part of the authenticated admin API, used
by the dashboard's `/assistant` screen (AppShell navigation, between
Overview and Groups). It accepts 1..20 conversation turns (oldest first)
and returns a reply, citations, and an optional `pendingRunId`. There is
no bot-worker or WhatsApp path, no public/unauthenticated route, and no
new service: the assistant is a backend use case plus a dashboard
screen. The deterministic path calls no AI provider; the optional
Gemini planner and answer composer described below are the only AI
surface, and both operate strictly on deterministic output.

### Deterministic intent parser (the safety net)

Intents are matched by keywords (English and Spanish), and entity names
are resolved case/accent-insensitively against the data the admin can
already see. The same request against the same data produces the same
reply — there is no hidden prompt in this path. The parser reads only
the **last user turn**; the turn-array shape is kept so a future planner
can use context without a contract change.

Tools (intents) are deliberately limited to:

| Tool | What it does |
| --- | --- |
| `summary` | Creates or finds a manual summary run for a named group over `today`, `yesterday`, `last 24 hours` (default), or `last 7 days`, and enqueues it. |
| `contact_groups` | Lists the monitored groups a named contact participates in. |
| `search_messages` | Searches captured messages from a named contact, optionally scoped to a named group and topic. |
| `help` / `clarify` | Explains what the assistant can do, or asks which group/contact was meant. |

The client never sends an entity id: groups and contacts are resolved
by name server-side, so an unmonitored group cannot be summarized or
searched even by crafting a request.

### Optional Gemini integration: planner and answer composer

`createGeminiPlanner` (`backend/src/lib/assistant/gemini-planner.ts`)
implements the `AssistantPlanner` interface and is passed to
`AssistantService` by the route. It is a **classifier only**: its output
is a validated plan `{ intent, groupName, contactName, query, period }`
(Zod `AssistantPlan`), and the deterministic service/tools still build
the reply, citations, and summary runs. No planner output ever becomes
reply text; the optional composer below may rewrite that text, but it
cannot add facts, citations, or runs.

Activation and configuration:

- The planner runs only when `store.getProviderConfig()` reports
  `provider === "google-gemini"` **and** a non-empty decrypted
  `apiKey`. A `mock` provider, an unconfigured install, or an unreadable
  key (decryption failure) returns `null` without a provider call, so
  the parser answers.
- The endpoint is always the official
  `https://generativelanguage.googleapis.com/v1beta`; a saved custom
  `baseUrl` is **not** honored for the assistant (the key must only go
  to Google).
- The model is the saved config's `model` (a `models/` prefix is
  stripped), falling back to `DEFAULT_GEMINI_MODEL`.

Exactly what is sent (the complete list):

- the admin's question text,
- the names of **monitored** groups,
- the names of contacts derived from monitored rosters (named contacts
  only; nameless contacts cannot be addressed and are not offered).

Message bodies, sender ids/JIDs, phone numbers, summaries, run records,
connection/session data, and the API key (which travels only in the
`x-goog-api-key` header) are never part of the prompt. The service
filters to monitored groups before calling the planner, and
`plannerCandidateNames` re-checks `monitored` as defense in depth.

Prompt-injection posture: the system instruction is a fixed constant;
the question and names are passed as a delimited JSON block and are
untrusted data by construction. The instruction states that the data is
never an instruction, that names must be copied exactly from the offered
lists, and that the response must be JSON only.

Request shape: `POST {base}/models/{model}:generateContent` with
`temperature: 0`, `maxOutputTokens: 512`, `responseMimeType:
"application/json"`, a `responseSchema` for the plan, and `store: false`
(the same request-level logging opt-out as the summary adapter; it is a
request, not a retention guarantee). The call is bounded to **10
seconds** with an `AbortController`; redirects are refused.

Validation and fallback (never a thrown error, never a guess):

- The response text must parse as JSON and satisfy `AssistantPlan`;
  otherwise the planner returns `null`.
- A valid plan is resolved by **exact case-insensitive name** against
  the same monitored groups/contacts. `summary` requires a group and
  defaults the period to `last_24h`; `contact_groups` requires a
  contact; `search_messages` requires a contact and treats a named group
  as an exact scope (an unknown scope is not silently widened); `help`
  answers with the help text.
- A missing, unknown, or ambiguous name (zero or several exact matches)
  discards the plan and runs `parseAssistantMessage`, which may ask a
  clarification.
- Timeouts, non-2xx responses, malformed bodies, invalid plans, planner
  errors, and config problems all degrade to the parser.

Logging: `assistant_chat` now carries `plannerSource: "gemini" |
"heuristic"` alongside the existing intent/citation/duration fields.
Failures log `assistant_planner_failed` with a fixed reason code
(`config`, `timeout`, `unavailable`, `http_error`, `malformed_response`,
`invalid_plan`) and, for HTTP errors, the status code. The prompt,
response text, names, question text, and key are never logged.

Answer composition is **not** part of the planner: the planner cannot
paraphrase, reason across messages, or write the reply. It is a separate,
optional step described next.

### Optional Gemini answer composer

`createGeminiAnswerComposer`
(`backend/src/lib/assistant/gemini-answer-composer.ts`) implements the
`AssistantAnswerComposer` interface and is passed to `AssistantService`
alongside the planner. The service calls it only for the data-backed
intents (`summary`, `contact_groups`, `search_messages`) and only after
the deterministic reply exists. `help` and `clarify` are never composed:
their exact wording, questions, and candidate names are part of the
contract.

Activation and configuration are identical to the planner:

- The composer runs only when `store.getProviderConfig()` reports
  `provider === "google-gemini"` **and** a non-empty decrypted `apiKey`.
  A `mock` provider, an unconfigured install, or an unreadable key
  (decryption failure) returns `null` without a provider call, so the
  template reply is served.
- The endpoint is always the official
  `https://generativelanguage.googleapis.com/v1beta`; a saved custom
  `baseUrl` is **not** honored (the key must only go to Google).
- The model is the saved config's `model` (a `models/` prefix is
  stripped), falling back to `DEFAULT_GEMINI_MODEL`.

Exactly what is sent (the complete list):

- the admin's question text,
- the deterministic draft reply (which may quote short message
  excerpts — that is the intended data for this phase),
- citation metadata: `kind`, `groupName`, and `sentAt` only.

Message ids, chat ids/JIDs, phone numbers, run records, sender ids,
session data, and the API key (which travels only in the
`x-goog-api-key` header) are never part of the prompt. The service
passes citations through `answerCitationMetadata`, which drops every id
before serialization.

Prompt-injection posture: the system instruction is a fixed constant and
states that the question and draft are untrusted data, that only facts
present in the draft may be used, that no group, person, date, message,
decision, or citation may be added, that "no data found" statements must
be preserved, and that the reply must be plain text. The question, draft,
and citation metadata travel as one delimited JSON block.

Request shape: `POST {base}/models/{model}:generateContent` with
`temperature: 0.2`, `maxOutputTokens: 600`, and `store: false` (the same
request-level logging opt-out as the planner). The call is bounded to
**10 seconds** with an `AbortController`; redirects are refused.

Validation and fallback (never a thrown error, never invented evidence):

- The composed text is taken from `candidates[0].content.parts[].text`,
  trimmed, and must be **1..8000 characters** (the published reply cap);
  empty or over-long text returns `null`.
- A null result, a thrown error, empty text, or over-long text keeps the
  deterministic reply unchanged.
- A `summary` reply always keeps its run link: if the composed text does
  not contain `/runs/<pendingRunId>`, the service appends
  `Open the run: /runs/<pendingRunId>`.
- Citations and `pendingRunId` are copied from the deterministic draft,
  never from the model.

Logging: every composed turn logs `assistant_answer` with
`source: "gemini" | "template"`, `durationMs`, and a safe
`fallbackReason` (`unavailable`, `empty`, `invalid`, or the thrown
error's type; `null` on success). Composer failures log
`assistant_answer_failed` with a fixed reason code (`config`, `timeout`,
`unavailable`, `http_error`, `malformed_response`) and, for HTTP errors,
the status code. The question, draft, composed text, names, and key are
never logged.

Cost: at most **two** bounded (≤10 s) Gemini calls per chat turn — one
classifier and one composer. With the mock provider or no key, zero
calls are made.

### Privacy and security boundary

- **Monitored data only.** The service filters groups to
  `monitored = true` before parsing, contacts come from monitored
  rosters, and the search SQL joins `groups.monitored = true`. A group
  the admin has not opted in is not a candidate, and its messages are
  never read.
- **No SQL generation.** Intents map to fixed store methods with
  parameterized queries. User text never becomes SQL, a table name, or
  a column.
- **No chat persistence.** The conversation lives in browser state and
  is sent back with each request; there is no assistant table, no
  transcript log, and no server-side history. Closing the page discards
  it.
- **Rate limit.** The route is guarded by an in-memory, per-IP,
  fixed-window limiter at **20 requests/minute** (`429`,
  `rate_limited`, `Retry-After`). It is an operational guard, not
  business data, and it resets on restart.
- **Citations.** Every message, group, or run an answer relies on is
  returned as a citation (`group` | `message` | `run`, capped at 20),
  and the dashboard links them to the group, the group's messages tab,
  or the run.
- **Logs.** Only intent names, the planner source (`gemini`/`heuristic`),
  the answer source (`gemini`/`template`), citation counts, durations,
  and safe planner/composer failure reasons are logged — never message
  bodies, names, JIDs, question text, prompts, or reply text.

### Summary creation reuses `summary_runs` and the existing queue

The `summary` intent is not a second pipeline. It calls the same
`createOrFindRun` (kind `manual`, interval from the group's IANA zone
and a half-open window) and the same `SummaryEnqueuer` as
`POST /api/runs`. Run identity is unchanged, so repeating the same
request returns the same run instead of creating a duplicate.

Durability order matches the rest of the API: the run row is written
**first**, then enqueued **best-effort**. A queue outage leaves the run
`pending`, logs `assistant_enqueue_failed`, and the reply says the run
will be retried; reconciliation re-enqueues it. The assistant never
reports a summary as queued when no durable run exists.

### Message search: `pg_trgm` plus a GIN index

`search_messages` matches message bodies two ways: substring
(`ILIKE '%term%'`) and fuzzy trigram similarity
(`similarity(body, term) > 0.15`). Migration 0013 installs the
`pg_trgm` extension and a GIN trigram index on `messages.body`
(`messages_body_trgm_idx`), so the leading-wildcard `ILIKE` is
index-supported instead of a sequential scan. The index is read-only
plumbing and does not change the monitored-only predicate.

User text is handled literally: `%`, `_`, and `\` are escaped for
`ILIKE` (`ESCAPE '\'`) so they cannot act as wildcards, and the term is
passed unescaped to `pg_trgm` `similarity` so ordinary text keeps using
the index. `similarity()` itself is evaluated per candidate row (only
the `%` operator is index-backed); acceptable at MVP scale, with the
documented switch to `body % term` if volume grows. Results are bounded
to **10 hits**, quoted with the group's local time, and returned as
`message` citations.

`pg_trgm` ships with PostgreSQL as a trusted extension, but the
database role must be allowed to `CREATE EXTENSION`; if it is not, the
migration fails loudly rather than leaving search slow or broken.

## Consequences and limits

- **No follow-ups.** The parser reads one user turn. "And the second
  one?" or "summarize that group" cannot resolve a previous answer's
  candidates; the reply asks for a name instead.
- **Answer composition is optional and bounded.** Without Gemini,
  replies are fixed templates filled from store data. With Gemini, the
  planner selects the tool and the composer may rewrite the reply text;
  the model still cannot add facts, citations, or runs, reason across
  messages, or answer questions outside the three tools — those fall
  back to `help`. When Gemini is configured, each chat turn costs at
  most two bounded (≤10 s) calls; a provider outage silently degrades to
  the deterministic planner and/or template reply.
- **Search is bounded** to 10 hits and one literal/fuzzy term per
  request; it is a lookup aid, not a full-text or vector search.
- **Contact aliases are word-level.** A contact matches on their full
  stored name or on single words of it (length ≥ 3,
  accent-insensitive), so "Carlos" can resolve "Carlos Luis Gramcko".
  If several contacts share that word, the reply asks for a
  clarification instead of guessing. Groups match by full name only, so
  a generic word from a group name never selects a group.
- **Ambiguity is surfaced, never guessed.** Equal-quality matches ask
  which one was meant and list the candidates (group candidates are
  cited).
- **The dashboard is the only client.** There is no WhatsApp self-chat
  entry point, and the only write action is creating a summary run.
- **Planner selection is single-turn.** The planner receives only the
  last user turn (plus names), so follow-ups still fall back to the
  parser; the plan never carries conversation history.

## Future work

- Multi-turn planner context ("the second one", "that group"), keeping
  the same data boundary.
- Streaming replies and multi-turn follow-up resolution ("the second
  one").
- A WhatsApp self-chat entry point (bot-worker), reusing the same
  service and the same monitored-only boundary.
- Write actions (monitor/unmonitor, rename a contact, retry a run) with
  explicit confirmation.
- Index-backed fuzzy search (`body % term` with a tuned
  `pg_trgm.similarity_threshold`) if message volume warrants it.
