import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { sourceMessageHref } from "../src/lib/format.ts";

/**
 * Wiring tests for clickable summary source references. The dashboard has no
 * DOM test environment (no jsdom/testing-library), so — like
 * `ui-wiring.test.ts` — these read the sources and assert the parts that
 * regress silently:
 *
 * 1. A source reference links to `/runs/<runId>?tab=messages&message=<id>`,
 *    and the non-link display stays when no `runId` is threaded through.
 * 2. `RunDetailView` reads `tab`/`message` from the URL, switches to the
 *    Messages tab on a search-param change, and forwards `runId`/`message`.
 * 3. `RunMessagesTab` walks older pages (bounded) to find the cited message,
 *    scrolls it inside the list, highlights it briefly, and reports a message
 *    it could not find instead of crashing.
 */

const SUMMARY_VIEW_URL = new URL(
  "../src/components/SummaryView.tsx",
  import.meta.url,
);
const RUN_DETAIL_URL = new URL(
  "../src/components/runs/RunDetailView.tsx",
  import.meta.url,
);
const RUN_MESSAGES_URL = new URL(
  "../src/components/runs/RunMessagesTab.tsx",
  import.meta.url,
);

test("source references use the run/messages URL shape", () => {
  assert.equal(
    sourceMessageHref("run-1", "msg-1"),
    "/runs/run-1?tab=messages&message=msg-1",
  );
  // Both segments are URL-encoded, so an id with `&` cannot break the query.
  assert.equal(
    sourceMessageHref("run 1", "a&b"),
    "/runs/run%201?tab=messages&message=a%26b",
  );
});

test("SummaryView links cited messages to the run's Messages tab", async () => {
  const source = await readFile(SUMMARY_VIEW_URL, "utf8");

  assert.match(
    source,
    /import Link from "next\/link";/,
    "source references are not rendered as links",
  );
  assert.match(
    source,
    /import \{ pluralize, sourceMessageHref \} from "@\/lib\/format";/,
    "the shared source-message URL helper is not used",
  );
  assert.match(
    source,
    /href=\{sourceMessageHref\(runId, ref\.messageId\)\}/,
    "a source reference does not link to its message id",
  );
  assert.match(
    source,
    /aria-label=\{`Open source message in Messages used: \$\{ref\.messageId\}`\}/,
    "the source link has no accessible name",
  );
  for (const className of [
    "hover:bg-brand-50",
    "focus-visible:outline-2",
    "focus-visible:outline-brand-600",
  ]) {
    assert.ok(
      source.includes(className),
      `the source link is missing \`${className}\``,
    );
  }
  assert.match(
    source,
    /runId === undefined \?/,
    "the non-link display must stay when no run id is available",
  );
  assert.match(
    source,
    /sent \{formatDateTime\(sourceRef\.sentAt, timeZone, dateFormat\)\}/,
    "the `sent ...` timestamp text was lost",
  );

  // `runId` is threaded through SummaryView → ClaimList/TaskList → SourceRefList.
  const threaded = source.match(/\brunId=\{runId\}/g) ?? [];
  assert.ok(
    threaded.length >= 6,
    `runId is not threaded through every source-ref list (found ${threaded.length} usages)`,
  );
  assert.match(
    source,
    /interface SummaryViewProps \{[\s\S]*?runId\?: string;/,
    "SummaryView does not accept an optional runId",
  );
});

test("RunDetailView reads tab/message search params and forwards them", async () => {
  const source = await readFile(RUN_DETAIL_URL, "utf8");

  assert.match(
    source,
    /import \{ useSearchParams \} from "next\/navigation";/,
    "the run page does not read URL search params",
  );
  assert.match(
    source,
    /const searchParams = useSearchParams\(\);/,
    "the search params hook is not used",
  );
  assert.match(
    source,
    /searchParams\.get\("tab"\)/,
    "the tab search param is not read",
  );
  assert.match(
    source,
    /searchParams\.get\("message"\)/,
    "the message search param is not read",
  );
  assert.match(
    source,
    /requestedTab === "messages" \? "messages" : "summary"/,
    "the initial tab ignores ?tab=messages",
  );
  // The effect must react to both params, not only the first render, so a
  // source link clicked on the same run page still switches to Messages.
  assert.match(
    source,
    /\}, \[requestedTab, focusMessageId\]\);/,
    "a search-param change does not re-select the Messages tab",
  );
  assert.match(
    source,
    /<SummaryView[\s\S]*?runId=\{runId\}/,
    "SummaryView does not receive the run id",
  );
  assert.match(
    source,
    /<RunMessagesTab[\s\S]*?focusMessageId=\{focusMessageId\}/,
    "RunMessagesTab does not receive the cited message id",
  );
});

test("RunMessagesTab walks older pages to reveal a cited message", async () => {
  const source = await readFile(RUN_MESSAGES_URL, "utf8");

  assert.match(
    source,
    /focusMessageId\?: string \| null;/,
    "RunMessagesTab has no optional focusMessageId prop",
  );
  assert.match(
    source,
    /findMessageInOlderPages,/,
    "the bounded page walk is not used",
  );
  assert.match(
    source,
    /MAX_FOCUS_PAGE_FETCHES,/,
    "the page walk has no page bound",
  );
  assert.match(
    source,
    /cursor,\s*\n\s*limit: MESSAGE_PAGE_SIZE,/,
    "the walk does not reuse the existing page size/cursor pagination",
  );
  assert.match(
    source,
    /focusMessageId,\s*\n\s*pageVersion,/,
    "the reveal effect does not run for a new focus target/page",
  );
  // The normal first-page loader must not re-run for a focus change.
  assert.match(
    source,
    /\}, \[groupId, interval\.start, interval\.end\]\);/,
    "focusing a message must not refetch the first page",
  );
  assert.equal(
    (source.match(/focusRequestId\.current !== request/g) ?? []).length >= 2,
    true,
    "stale page walks are not cancelled",
  );
  assert.match(
    source,
    /return \(\) => \{\s*\n\s*focusRequestId\.current \+= 1;/,
    "the page walk is not cancelled when the target changes or on unmount",
  );
});

test("RunMessagesTab scrolls, highlights and reports the cited message", async () => {
  const source = await readFile(RUN_MESSAGES_URL, "utf8");

  assert.match(
    source,
    /data-message-id=\{message\.id\}/,
    "message rows are not addressable by id",
  );
  assert.match(
    source,
    /messageRefs\.current\.get\(pendingRevealId\)/,
    "the cited message element is not looked up",
  );
  assert.match(
    source,
    /container\.scrollTop = Math\.max\(/,
    "the cited message is not scrolled inside the list container",
  );
  assert.match(
    source,
    /ring-amber-400/,
    "the revealed message is not highlighted",
  );
  assert.match(
    source,
    /FOCUS_HIGHLIGHT_MS/,
    "the highlight has no timeout",
  );
  assert.match(
    source,
    /window\.setTimeout\(/,
    "the highlight is never cleared",
  );
  assert.match(
    source,
    /window\.clearTimeout\(highlightTimer\.current\)/,
    "highlight timers are not cleaned up",
  );
  assert.match(
    source,
    /not among the loaded source messages/,
    "a cited message that cannot be found has no inline explanation",
  );
  assert.match(
    source,
    /<Alert tone="warning" title="Cited message not found">/,
    "the not-found state is not surfaced as an Alert",
  );
});
