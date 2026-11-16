import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Wiring tests for two changes this runner cannot render (the dashboard has no
 * DOM test environment — no jsdom/testing-library — so, like
 * `ui-wiring.test.ts`, these read the sources and assert the parts that
 * regress silently):
 *
 * 1. The desktop sidebar must collapse when the pointer leaves it, even after a
 *    nav link was clicked: the clicked link keeps focus, so `focus-within`
 *    would otherwise hold the rail open. The fix blurs the focused element on
 *    `onMouseLeave` — hover/focus expansion itself must stay (keyboard users)
 *    and the old click-to-collapse `suppressHover` state must not come back.
 * 2. The connection screen's "Delete WhatsApp connection data" danger zone
 *    (`POST /api/connection/reset`) must stay distinct from the unlink action
 *    (`POST /api/connection/logout`) and must re-arm the pairing poll.
 */

const API_URL = new URL("../src/lib/api.ts", import.meta.url);
const APP_SHELL_URL = new URL("../src/components/AppShell.tsx", import.meta.url);
const CONNECTION_PAGE_URL = new URL(
  "../src/app/(app)/connection/page.tsx",
  import.meta.url,
);

test("api.resetConnection posts /connection/reset", async () => {
  const source = await readFile(API_URL, "utf8");

  assert.match(
    source,
    /resetConnection\(\): Promise<OkResponse>/,
    "api.resetConnection does not return the shared OkResponse contract",
  );
  assert.match(
    source,
    /requestRaw<OkResponse>\("\/connection\/reset", \{ method: "POST" \}\)/,
    "resetConnection must POST /connection/reset through requestRaw",
  );
  // Unlink is a remote logout and must stay a separate call.
  assert.match(
    source,
    /requestRaw<OkResponse>\("\/connection\/logout", \{ method: "POST" \}\)/,
    "the unlink call was renamed or repointed at the reset endpoint",
  );
});

test("the desktop sidebar blurs focus inside itself when the pointer leaves", async () => {
  const source = await readFile(APP_SHELL_URL, "utf8");

  assert.equal(
    source.includes("suppressHover"),
    false,
    "the click-to-collapse suppressHover state is back",
  );

  assert.match(
    source,
    /onMouseLeave=\{\(event\) => \{[\s\S]*?document\.activeElement[\s\S]*?event\.currentTarget\.contains\(active\)[\s\S]*?active\.blur\(\);[\s\S]*?\}\}/,
    "pointer leave does not blur a focused element inside the sidebar",
  );

  // Only the desktop rail may blur on pointer leave; the mobile drawer closes
  // through its own native dialog and must not gain this handler.
  const asideAt = source.indexOf('className="group fixed inset-y-0 left-0');
  const mobileHeaderAt = source.indexOf("Mobile header");
  const mouseLeaveAt = source.indexOf("onMouseLeave");
  assert.ok(asideAt >= 0, "the desktop rail is missing");
  assert.ok(mobileHeaderAt > asideAt, "the mobile header marker moved");
  assert.ok(
    mouseLeaveAt > asideAt && mouseLeaveAt < mobileHeaderAt,
    "onMouseLeave must live on the desktop <aside>, not the mobile drawer",
  );
  assert.equal(
    source.match(/onMouseLeave/g)?.length,
    1,
    "the blur handler is attached more than once",
  );

  // Hover/focus expansion stays: keyboard users still get the labels.
  assert.match(source, /hover:w-64/, "the rail no longer expands on hover");
  assert.match(
    source,
    /focus-within:w-64/,
    "the rail no longer expands for keyboard focus",
  );
});

test("the connection page offers a danger zone that resets connection data", async () => {
  const source = await readFile(CONNECTION_PAGE_URL, "utf8");

  assert.match(source, /title="Danger zone"/, "the danger zone card is missing");
  assert.match(
    source,
    /Delete WhatsApp connection data/,
    "the danger zone action is missing",
  );
  assert.match(
    source,
    /Use this when the session is partial or invalid and no QR code/,
    "the danger zone does not explain when to use it",
  );
  assert.match(
    source,
    /Keeps:[\s\S]*?captured groups, messages, summaries/,
    "the danger zone does not say captured data is kept",
  );
  assert.match(
    source,
    /Linked devices/,
    "the danger zone does not explain the phone-side linked device",
  );

  // The card sits below the existing session/link cards.
  const dangerAt = source.indexOf('title="Danger zone"');
  const linkedCardAt = source.indexOf('"Linked device"');
  assert.ok(linkedCardAt >= 0, "the link/linked card is missing");
  assert.ok(
    dangerAt > linkedCardAt,
    "the danger zone must render below the session/link cards",
  );
});

test("the reset flow is confirmed, guarded, and forces a pairing poll", async () => {
  const source = await readFile(CONNECTION_PAGE_URL, "utf8");

  assert.match(
    source,
    /const \[resetOpen, setResetOpen\] = useState\(false\)/,
    "the reset dialog state is missing",
  );
  assert.match(
    source,
    /const \[resetting, setResetting\] = useState\(false\)/,
    "the reset loading state is missing",
  );
  assert.match(
    source,
    /const \[resetError, setResetError\] = useState<string \| null>\(null\)/,
    "the reset error state is missing",
  );
  assert.match(
    source,
    /const \[resetFeedback, setResetFeedback\] = useState<string \| null>\(null\)/,
    "the reset feedback state is missing",
  );

  assert.match(
    source,
    /await api\.resetConnection\(\)/,
    "the confirm action never calls api.resetConnection",
  );
  assert.match(
    source,
    /if \(resetInFlight\.current\) return;/,
    "a second confirm can start while the reset is in flight",
  );
  assert.match(
    source,
    /<ConfirmDialog\s*open=\{resetOpen\}/,
    "the reset action is not behind a confirmation dialog",
  );
  assert.match(
    source,
    /loading=\{resetting\}/,
    "the reset dialog is not busy while resetting",
  );
  assert.match(
    source,
    /error=\{resetError\}/,
    "the reset dialog does not render its error",
  );
  assert.match(
    source,
    /confirmLabel="Delete connection data"/,
    "the reset confirm label is missing",
  );

  // Success: close, announce, and keep polling until the fresh QR shows up.
  assert.match(
    source,
    /await api\.resetConnection\(\);[\s\S]*?setResetOpen\(false\);[\s\S]*?setRefreshAfterUnlink\(true\);/,
    "a successful reset does not re-arm the pairing poll",
  );
  assert.match(
    source,
    /title: "Connection data deleted"/,
    "success is not announced with a toast",
  );
  assert.match(
    source,
    /setResetFeedback\(/,
    "success is not shown inline",
  );

  // Both entry points (danger zone + "no code after a while?" callout) open
  // the same confirmation.
  assert.equal(
    source.match(/onClick=\{openResetDialog\}/g)?.length,
    2,
    "the troubleshooting callout and the danger zone must open the same confirm",
  );
});

test("the unlink action stays separate from the local reset", async () => {
  const source = await readFile(CONNECTION_PAGE_URL, "utf8");

  assert.match(
    source,
    /await api\.logoutConnection\(\)/,
    "the existing unlink action was removed or repointed",
  );
  assert.match(
    source,
    /End session \/ Unlink/,
    "the unlink action label changed",
  );
  assert.match(
    source,
    /remote logout/,
    "the copy does not distinguish unlink (remote logout) from the local reset",
  );
});
