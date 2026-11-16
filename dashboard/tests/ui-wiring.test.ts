import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Wiring tests for dashboard UX fixes that this runner cannot render — the
 * dashboard has no DOM test environment (no jsdom/testing-library), so these
 * read the sources and assert the parts that regress silently:
 *
 * 1. `ConfirmDialog` must be centered. A native `<dialog>` is centered by the
 *    UA stylesheet through `inset: 0` + `margin: auto`, and Tailwind Preflight
 *    resets `margin`, which drops the dialog in the top-left corner. The fix
 *    has to live in the dialog's className and must not leak into the mobile
 *    navigation drawer, which is intentionally left-aligned.
 * 2. `GroupDetailView` must poll while a history import is in flight, using the
 *    same interval and the same stop condition as the groups list.
 * 3. `MembersTab` must offer "Refresh members" in both the empty and the
 *    non-empty state, request a roster sync, and poll the roster afterwards so
 *    the list updates without a manual page refresh.
 */

const CONFIRM_DIALOG_URL = new URL(
  "../src/components/ui/ConfirmDialog.tsx",
  import.meta.url,
);
const APP_SHELL_URL = new URL("../src/components/AppShell.tsx", import.meta.url);
const GROUP_DETAIL_URL = new URL(
  "../src/components/groups/GroupDetailView.tsx",
  import.meta.url,
);
const MEMBERS_TAB_URL = new URL(
  "../src/components/groups/MembersTab.tsx",
  import.meta.url,
);

/**
 * End index of the JSX opening tag starting at `openAt`, i.e. the first `>` at
 * brace depth 0 and outside a string literal. Attribute values such as
 * `onClose={() => ...}` contain `>` characters, so a plain `indexOf(">")` is
 * not enough.
 */
function openingTagEnd(source: string, openAt: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openAt; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index;
  }
  return -1;
}

/** Opening tag of the element that owns `ref={refName}`. */
function elementTagWithRef(source: string, refName: string): string {
  const refAt = source.indexOf(`ref={${refName}}`);
  assert.ok(refAt >= 0, `no element uses ref={${refName}}`);
  const openAt = source.lastIndexOf("<", refAt);
  const closeAt = openAt < 0 ? -1 : openingTagEnd(source, openAt);
  assert.ok(
    openAt >= 0 && closeAt > openAt,
    `malformed opening tag for ref={${refName}}`,
  );
  return source.slice(openAt, closeAt + 1);
}

function classNames(tag: string): string[] {
  const match = /className="([^"]*)"/.exec(tag);
  assert.ok(match !== null, `element has no className attribute: ${tag}`);
  return (match[1] ?? "")
    .split(/\s+/)
    .filter((name) => name.length > 0);
}

test("ConfirmDialog is centered and stays usable on small screens", async () => {
  const source = await readFile(CONFIRM_DIALOG_URL, "utf8");
  const classes = classNames(elementTagWithRef(source, "dialogRef"));

  // Preflight resets `margin`, so both the insets and the auto margin are
  // needed for the browser to center the modal again.
  assert.ok(
    classes.includes("m-auto"),
    "ConfirmDialog lost its centering margin (Preflight resets `margin`)",
  );
  assert.ok(
    classes.includes("inset-0"),
    "ConfirmDialog needs `inset-0` so `m-auto` can center it",
  );
  assert.ok(
    classes.includes("max-h-[calc(100dvh-2rem)]"),
    "ConfirmDialog has no small-screen height cap",
  );
  assert.ok(
    classes.includes("overflow-y-auto"),
    "ConfirmDialog content cannot scroll on short screens",
  );
  assert.ok(
    classes.includes("backdrop:bg-slate-900/50"),
    "ConfirmDialog lost its backdrop styling",
  );
  assert.ok(
    !classes.includes("left-0"),
    "ConfirmDialog must stay centered, not left-aligned",
  );
});

test("the mobile navigation drawer stays left-aligned", async () => {
  const source = await readFile(APP_SHELL_URL, "utf8");
  const classes = classNames(elementTagWithRef(source, "drawerRef"));

  assert.ok(
    classes.includes("left-0"),
    "the drawer must stay anchored to the left edge",
  );
  assert.ok(classes.includes("m-0"), "the drawer must keep its zero margin");
  assert.ok(
    !classes.includes("m-auto"),
    "the drawer is intentionally left-aligned and must not be centered",
  );
});

test("GroupDetailView polls the group while a history import is in flight", async () => {
  const source = await readFile(GROUP_DETAIL_URL, "utf8");

  assert.match(
    source,
    /HISTORY_IMPORT_POLL_MS/,
    "the shared poll interval is not used",
  );
  assert.match(
    source,
    /importSummary\?\.inFlight === true/,
    "polling must be driven by the in-flight import state",
  );
  assert.match(
    source,
    /window\.setInterval\(\s*reload,\s*HISTORY_IMPORT_POLL_MS,?\s*\)/,
    "the group is never re-fetched while the import runs",
  );
  assert.match(
    source,
    /\[polling, reload\]/,
    "the poll effect must restart only when polling or reload changes",
  );
  assert.match(
    source,
    /window\.clearInterval\(interval\)/,
    "the poll interval is never cleared",
  );
  // The Settings tab must receive the freshly loaded group, not a stale copy,
  // so its import card updates without a manual refresh.
  assert.match(
    source,
    /<GroupSettingsCard[\s\S]*?group=\{current\}/,
    "the settings card does not receive the refreshed group",
  );
});

test("MembersTab requests a roster sync and polls until the roster arrives", async () => {
  const source = await readFile(MEMBERS_TAB_URL, "utf8");

  // One shared control, rendered by the empty state and by the non-empty
  // header: the definition plus two usages (`action={...}` and `{...}`).
  assert.match(
    source,
    /const refreshButton = \(\s*<Button[\s\S]*?>\s*Refresh members\s*<\/Button>/,
    "there is no reusable Refresh members button",
  );
  assert.equal(
    (source.match(/\{refreshButton\}/g) ?? []).length,
    2,
    "the refresh control is not rendered in both the empty state and the header",
  );
  assert.match(
    source,
    /description="[\s\S]*?to ask it for the current roster/,
    "the empty-state copy does not point at the refresh button",
  );

  // The click posts to the roster-sync route for this group.
  assert.match(
    source,
    /await api\.requestRosterSync\(groupId\)/,
    "the button does not request a roster sync",
  );
  assert.match(
    source,
    /Roster refresh requested\. It can take a few seconds\./,
    "the request feedback message is missing",
  );

  // ...and then polls the roster on a bounded window.
  assert.match(source, /ROSTER_REFRESH_POLL_MS = 2_000/, "poll interval changed");
  assert.match(
    source,
    /ROSTER_REFRESH_WINDOW_MS = 15_000/,
    "poll window changed",
  );
  assert.match(
    source,
    /window\.setInterval\(\(\) => \{\s*reload\(\);[\s\S]*?\}, ROSTER_REFRESH_POLL_MS\)/,
    "the roster is never re-fetched while a refresh is pending",
  );
  assert.match(
    source,
    /Date\.now\(\) >= deadline[\s\S]*?setPolling\(false\)/,
    "the poll window never closes",
  );
  assert.match(
    source,
    /window\.clearInterval\(interval\)/,
    "the poll interval is never cleared",
  );

  // Failures are surfaced inline (including the 409/unmonitored case), and the
  // existing 409 handling of the member list is untouched.
  assert.match(source, /<Alert tone="error"/, "request failures are silent");
  assert.match(
    source,
    /failure\.code === "conflict"/,
    "the unmonitored (409) case is not explained",
  );
  assert.match(
    source,
    /if \(error\.code === "conflict"\)/,
    "the member-list 409 state was removed",
  );
});
