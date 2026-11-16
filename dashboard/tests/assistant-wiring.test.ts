import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Wiring tests for the dashboard assistant.
 *
 * The dashboard has no DOM test environment (no jsdom/testing-library), so —
 * like `ui-wiring.test.ts` — these tests read the sources and assert the
 * contract-facing parts that regress silently: the API call shape, the nav
 * entry, the chat behaviours (Enter/Shift+Enter, no concurrent sends, the
 * 20-turn cap), the citation links, and the `?tab=` deep link.
 */

const API_URL = new URL("../src/lib/api.ts", import.meta.url);
const APP_SHELL_URL = new URL("../src/components/AppShell.tsx", import.meta.url);
const PAGE_URL = new URL(
  "../src/app/(app)/assistant/page.tsx",
  import.meta.url,
);
const CHAT_URL = new URL(
  "../src/components/assistant/AssistantChat.tsx",
  import.meta.url,
);
const GROUP_DETAIL_URL = new URL(
  "../src/components/groups/GroupDetailView.tsx",
  import.meta.url,
);

test("api.assistantChat posts the shared contract to /assistant/chat", async () => {
  const source = await readFile(API_URL, "utf8");

  assert.match(
    source,
    /assistantChat\(body: AssistantChatRequest\): Promise<AssistantChatResponse>/,
    "api.assistantChat does not use the shared contract types",
  );
  assert.match(
    source,
    /requestRaw<AssistantChatResponse>\(\s*"\/assistant\/chat",\s*\{\s*method: "POST",\s*body,?\s*\}/,
    "assistantChat must POST /assistant/chat through requestRaw",
  );
});

test("AppShell exposes the assistant route in the primary navigation", async () => {
  const source = await readFile(APP_SHELL_URL, "utf8");

  assert.match(
    source,
    /\|\s*"assistant"/,
    "IconName does not include the assistant icon",
  );
  assert.match(source, /assistant:\s*\(\s*<>/, "the assistant icon path is missing");
  assert.match(
    source,
    /\{ href: "\/assistant", label: "Assistant", icon: "assistant" \}/,
    "the Assistant nav item is missing or points elsewhere",
  );
});

test("the assistant page renders the chat with the required header copy", async () => {
  const source = await readFile(PAGE_URL, "utf8");

  assert.match(
    source,
    /import \{ AssistantChat \} from "@\/components\/assistant\/AssistantChat";/,
    "the page does not import AssistantChat",
  );
  assert.match(source, /title="Assistant"/, "the page header title is missing");
  assert.match(
    source,
    /monitored groups[\s\S]*captured messages[\s\S]*completed summaries/,
    "the description no longer explains what the assistant answers over",
  );
  assert.match(source, /<AssistantChat \/>/, "the chat component is not rendered");
});

test("AssistantChat keeps only the newest turns and blocks concurrent sends", async () => {
  const source = await readFile(CHAT_URL, "utf8");

  assert.match(source, /const MAX_TURNS = 20;/, "the 20-turn contract cap is gone");
  assert.match(
    source,
    /conversation\.slice\(-MAX_TURNS\)/,
    "the request no longer trims the conversation to the last 20 turns",
  );
  assert.match(
    source,
    /if \(inFlight\.current\) return;/,
    "a second send can start while one is in flight",
  );
  assert.match(
    source,
    /disabled=\{sending \|\| input\.trim\(\) === ""\}/,
    "Send must be disabled while sending and for empty input",
  );
  assert.match(
    source,
    /setError\(toApiError\(cause\)\)/,
    "API failures are not surfaced as an ApiError",
  );
  assert.match(
    source,
    /<Alert tone="error" title="Could not send the message">/,
    "the API error is not shown in an Alert",
  );
  assert.match(
    source,
    /onClick=\{handleRetry\}/,
    "a failed send cannot be retried",
  );
  assert.match(source, /Clear chat/, "the clear-chat action is missing");
  assert.match(source, /setMessages\(\[\]\)/, "clear chat does not reset the transcript");
  assert.equal(
    source.includes("localStorage"),
    false,
    "the conversation must stay browser-only (no persistence)",
  );
});

test("AssistantChat sends on Enter, keeps Shift+Enter for new lines", async () => {
  const source = await readFile(CHAT_URL, "utf8");

  assert.match(
    source,
    /event\.key !== "Enter" \|\| event\.shiftKey/,
    "Enter/Shift+Enter handling changed",
  );
  assert.match(
    source,
    /event\.nativeEvent\.isComposing/,
    "IME composition Enter would send the message",
  );
  assert.match(source, /event\.preventDefault\(\);/, "Enter is not intercepted");
  assert.match(
    source,
    /role="status" aria-live="polite"/,
    "the thinking state is not announced politely",
  );
  assert.match(source, /Thinking…/, "the loading copy is missing");
  assert.match(
    source,
    /aria-label="Conversation"/,
    "the transcript list is unlabeled",
  );
  assert.match(
    source,
    /htmlFor=\{inputId\}/,
    "the message textarea has no visible label",
  );
});

test("AssistantChat offers the suggested prompts", async () => {
  const source = await readFile(CHAT_URL, "utf8");

  for (const prompt of [
    "Summarize Grupo prueba today",
    "Which groups does Carlos participate in?",
    "When did Carlos mention the invoice?",
  ]) {
    assert.ok(
      source.includes(`"${prompt}"`),
      `suggested prompt missing: ${prompt}`,
    );
  }
});

test("AssistantChat links citations and pending runs to dashboard routes", async () => {
  const source = await readFile(CHAT_URL, "utf8");

  assert.ok(
    source.includes("`/groups/${encodeURIComponent(citation.groupId)}?tab=messages`"),
    "message citations no longer deep-link to the group messages tab",
  );
  assert.ok(
    source.includes("`/groups/${encodeURIComponent(citation.groupId)}`"),
    "group citations no longer link to the group detail",
  );
  assert.ok(
    source.includes("`/runs/${encodeURIComponent(citation.runId)}`"),
    "run citations no longer link to the run detail",
  );
  assert.ok(
    source.includes("`/runs/${encodeURIComponent(message.pendingRunId)}`"),
    "pendingRunId no longer links to the run detail",
  );
  assert.match(source, /Open run/, "the pending run link label is missing");
  assert.match(
    source,
    /formatDateTime\(citation\.sentAt, timeZone, dateFormat\)/,
    "citation timestamps must use the app time zone and date format",
  );
});

test("GroupDetailView opens the tab named by ?tab= when it is a real tab", async () => {
  const source = await readFile(GROUP_DETAIL_URL, "utf8");

  assert.match(
    source,
    /new URLSearchParams\(window\.location\.search\)\.get\("tab"\)/,
    "the ?tab= query parameter is not read",
  );
  assert.match(
    source,
    /TAB_ITEMS\.some\(\(item\) => item\.id === value\)/,
    "an arbitrary ?tab= value is not validated against the tab ids",
  );
  assert.match(
    source,
    /if \(value !== null && isTabId\(value\)\) setTab\(value\);/,
    "a valid ?tab= value does not become the initial tab",
  );
});
