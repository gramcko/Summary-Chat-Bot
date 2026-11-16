import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Wiring tests for the guarded "delete all captured data" danger zone and for
 * the desktop sidebar hover behaviour.
 *
 * The dashboard has no DOM test environment (no jsdom/testing-library), so —
 * like `ui-wiring.test.ts` — these tests read the sources and assert the parts
 * that regress silently: the API call shape, the exact confirmation literal,
 * the disabled-until-match guard, the double-submit guard, the success
 * feedback, and the absence of the old click-to-collapse sidebar state.
 */

const API_URL = new URL("../src/lib/api.ts", import.meta.url);
const APP_SHELL_URL = new URL("../src/components/AppShell.tsx", import.meta.url);
const CONFIRM_DIALOG_URL = new URL(
  "../src/components/ui/ConfirmDialog.tsx",
  import.meta.url,
);
const DELETE_CARD_URL = new URL(
  "../src/components/settings/DeleteAllDataCard.tsx",
  import.meta.url,
);
const SETTINGS_PAGE_URL = new URL(
  "../src/app/(app)/settings/page.tsx",
  import.meta.url,
);

test("api.deleteAllData posts the guarded contract to /admin/delete-all-data", async () => {
  const source = await readFile(API_URL, "utf8");

  assert.match(
    source,
    /DeleteAllDataRequest,/,
    "the request contract type is not imported",
  );
  assert.match(
    source,
    /DeleteAllDataResponse,/,
    "the response contract type is not imported",
  );
  assert.match(
    source,
    /deleteAllData\(body: DeleteAllDataRequest\): Promise<DeleteAllDataResponse>/,
    "api.deleteAllData does not use the shared contract types",
  );
  assert.match(
    source,
    /requestRaw<DeleteAllDataResponse>\(\s*"\/admin\/delete-all-data",\s*\{\s*method: "POST",\s*body,?\s*\}/,
    "deleteAllData must POST /admin/delete-all-data through requestRaw",
  );
});

test("ConfirmDialog can disable confirm independently of loading", async () => {
  const source = await readFile(CONFIRM_DIALOG_URL, "utf8");

  assert.match(
    source,
    /confirmDisabled\?: boolean;/,
    "ConfirmDialog lost its confirmDisabled prop",
  );
  assert.match(
    source,
    /confirmDisabled = false,/,
    "confirmDisabled is not defaulted",
  );
  assert.match(
    source,
    /disabled=\{alternativeLoading \|\| confirmDisabled\}/,
    "the confirm button ignores confirmDisabled (or dropped alternativeLoading)",
  );
});

test("the delete-all card requires the exact DELETE ALL confirmation", async () => {
  const source = await readFile(DELETE_CARD_URL, "utf8");

  assert.match(
    source,
    /const CONFIRMATION = "DELETE ALL";/,
    "the confirmation literal must match DeleteAllDataRequest.confirmation",
  );
  assert.match(
    source,
    /const matches = confirmation === CONFIRMATION;/,
    "the typed value is not compared with the exact literal",
  );
  assert.match(
    source,
    /confirmDisabled=\{!matches\}/,
    "the confirm button is not disabled until the literal matches",
  );
  assert.match(
    source,
    /<TextField[\s\S]*?id=\{CONFIRMATION_ID\}/,
    "the dialog has no typed confirmation field",
  );
  assert.match(
    source,
    /value=\{confirmation\}/,
    "the confirmation field is not controlled",
  );
  assert.match(source, /onChange=\{setConfirmation\}/, "typing is not captured");
  // The dialog must stay dismissible (a mistyped confirmation is not a trap).
  assert.match(source, /onCancel=\{closeDialog\}/, "the dialog has no cancel path");
});

test("the delete-all card calls the API once and reports counts", async () => {
  const source = await readFile(DELETE_CARD_URL, "utf8");

  assert.match(
    source,
    /await api\.deleteAllData\(\{ confirmation: CONFIRMATION \}\)/,
    "the API call does not send the exact confirmation literal",
  );
  assert.match(
    source,
    /if \(inFlight\.current \|\| !matches\) return;/,
    "a second confirm can start while the deletion is in flight",
  );
  assert.match(
    source,
    /loading=\{deleting\}/,
    "the dialog is not busy while deleting",
  );
  assert.match(
    source,
    /disabled=\{deleting\}/,
    "the trigger button is not disabled while deleting",
  );
  assert.match(source, /setError\(toApiError\(cause\)\.message\)/, "API failures are not surfaced");
  assert.match(source, /error=\{error\}/, "the dialog does not render the error");
  assert.match(
    source,
    /notify\(\{[\s\S]*?title: "Captured data deleted"[\s\S]*?tone: "success"/,
    "success is not announced with a toast",
  );
  assert.match(
    source,
    /describeDeletedCounts\(response\.deleted\)/,
    "the returned counts are not reported",
  );
  assert.match(
    source,
    /href: "\/groups"/,
    "the success toast does not link to the groups screen",
  );
  assert.match(
    source,
    /href="\/groups"/,
    "the inline success message has no link to /groups",
  );
  assert.match(source, /title="Danger zone"/, "the card is not labelled as a danger zone");
});

test("the settings page renders the danger zone after the date format", async () => {
  const source = await readFile(SETTINGS_PAGE_URL, "utf8");

  assert.match(
    source,
    /import \{ DeleteAllDataCard \} from "@\/components\/settings\/DeleteAllDataCard";/,
    "the settings page does not import the card",
  );
  const dateFormatAt = source.indexOf("<DefaultDateFormatForm />");
  const deleteAt = source.indexOf("<DeleteAllDataCard />");
  assert.ok(dateFormatAt >= 0, "the date format card is missing");
  assert.ok(deleteAt >= 0, "the danger zone card is not rendered");
  assert.ok(
    deleteAt > dateFormatAt,
    "the danger zone must render after the date format card",
  );
});

test("the desktop sidebar expands on hover/focus and never collapses on click", async () => {
  const source = await readFile(APP_SHELL_URL, "utf8");

  assert.equal(
    source.includes("suppressHover"),
    false,
    "the click-to-collapse suppressHover state is back",
  );
  assert.equal(
    source.includes("handleNavigate"),
    false,
    "a nav click still collapses the desktop rail",
  );
  // Pointer leave is allowed to blur focus inside the rail (so a clicked link
  // does not hold it open), but it must not reset hover/focus state itself.
  assert.equal(
    source.includes("onFocusCapture"),
    false,
    "the sidebar still resets hover state on focus",
  );

  assert.match(
    source,
    /className="group fixed inset-y-0 left-0 z-30 hidden w-\[4\.5rem\]/,
    "the desktop rail lost its `group` hover scope",
  );
  assert.match(source, /hover:w-64/, "the rail no longer expands on hover");
  assert.match(
    source,
    /focus-within:w-64/,
    "the rail no longer expands for keyboard focus",
  );
  assert.match(
    source,
    /aria-label="Summarly home"\s*className=/,
    "the logo link still collapses the rail on click",
  );
  assert.match(
    source,
    /<NavList pathname=\{pathname\} hoverExpand \/>/,
    "the desktop nav list still receives a navigate handler",
  );
});

test("the mobile drawer still closes when a nav item is clicked", async () => {
  const source = await readFile(APP_SHELL_URL, "utf8");

  assert.match(
    source,
    /<NavList\s*pathname=\{pathname\}\s*onNavigate=\{\(\) => drawerRef\.current\?\.close\(\)\}/,
    "the drawer nav list no longer closes the drawer on navigation",
  );
});
