import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Wiring tests for the internally scrolling message lists (the dashboard has no
 * DOM test environment — no jsdom/testing-library — so, like
 * `ui-wiring.test.ts`, these read the sources and assert the parts that
 * regress silently):
 *
 * 1. The `<ol>` of each chat view sits in a bounded scroll container that
 *    keyboard users can focus and scroll, while the message count and both
 *    "Load older" buttons stay outside it.
 * 2. Day headings are sticky inside that container. They only stay visible
 *    while scrolling if each heading heads a whole day group (a heading nested
 *    in a single message `<li>` would stop sticking with that message).
 * 3. The list pins the newest message on the first page and restores the scroll
 *    offset when "Load older" prepends a page.
 */

const FILES = [
  {
    component: "MessagesTab",
    url: new URL("../src/components/groups/MessagesTab.tsx", import.meta.url),
    ariaLabel: "Group message history",
  },
  {
    component: "RunMessagesTab",
    url: new URL("../src/components/runs/RunMessagesTab.tsx", import.meta.url),
    ariaLabel: "Summary source message history",
  },
] as const;

/**
 * End index of the JSX opening tag starting at `openAt`, i.e. the first `>` at
 * brace depth 0 and outside a string literal. Attribute values such as
 * `onClick={() => ...}` contain `>` characters, so a plain `indexOf(">")` is
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

/** Source of the `<div>` starting at `openAt`, including its closing tag. */
function elementBlock(source: string, openAt: number): string {
  assert.ok(source.startsWith("<div", openAt), "expected a <div> at openAt");
  let depth = 0;
  let index = openAt;
  while (index < source.length) {
    if (source.startsWith("<div", index)) {
      const end = openingTagEnd(source, index);
      if (end < 0) break;
      depth += 1;
      index = end + 1;
      continue;
    }
    if (source.startsWith("</div>", index)) {
      depth -= 1;
      index += "</div>".length;
      if (depth === 0) return source.slice(openAt, index);
      continue;
    }
    index += 1;
  }
  return source.slice(openAt);
}

function classNames(tag: string): string[] {
  const match = /className="([^"]*)"/.exec(tag);
  assert.ok(match !== null, `element has no className attribute: ${tag}`);
  return (match[1] ?? "")
    .split(/\s+/)
    .filter((name) => name.length > 0);
}

for (const file of FILES) {
  test(`${file.component} keeps the message list in a bounded scroll region`, async () => {
    const source = await readFile(file.url, "utf8");
    const tag = elementTagWithRef(source, "listRef");
    const classes = classNames(tag);

    for (const required of [
      "max-h-[60vh]",
      "overflow-y-auto",
      "overscroll-contain",
      "rounded-xl",
      "bg-slate-50/60",
    ]) {
      assert.ok(
        classes.includes(required),
        `${file.component} scroll container is missing \`${required}\``,
      );
    }
    assert.match(
      tag,
      /tabIndex=\{0\}/,
      "keyboard users cannot focus and scroll the message list",
    );
    assert.match(
      tag,
      /role="region"/,
      "the labelled scroll container is not exposed as a region",
    );
    assert.match(
      tag,
      new RegExp(`aria-label="${file.ariaLabel}"`),
      "the scroll container has no accessible name",
    );
  });

  test(`${file.component} keeps sticky day headings inside the scroller only`, async () => {
    const source = await readFile(file.url, "utf8");
    const refAt = source.indexOf("ref={listRef}");
    const openAt = source.lastIndexOf("<", refAt);
    const block = elementBlock(source, openAt);

    assert.match(
      block,
      /<ol/,
      "the scroll container does not wrap the message list",
    );
    assert.match(
      block,
      /className="sticky top-0 z-10[^"]*"/,
      "day headings are not sticky inside the scroll container",
    );
    assert.match(
      block,
      /sticky top-0 z-10[^"]*bg-slate-50\b/,
      "sticky day headings need an opaque background matching the container",
    );
    assert.match(
      source,
      /groupMessagesByDay/,
      "day headings are not grouped per day, so they stop sticking with one message",
    );

    // Count/status header and both "Load older" buttons must stay outside the
    // scroller so they never scroll away with the messages.
    assert.equal(
      block.includes('aria-live="polite"'),
      false,
      "the message count header must stay outside the scroll container",
    );
    assert.equal(
      block.includes("Load older"),
      false,
      "the Load older buttons must stay outside the scroll container",
    );
  });

  test(`${file.component} pins the newest message and holds the place on "Load older"`, async () => {
    const source = await readFile(file.url, "utf8");

    assert.match(
      source,
      /const listRef = useRef<HTMLDivElement \| null>\(null\)/,
      "the message list has no scroll ref",
    );
    assert.match(
      source,
      /const pinToBottom = useRef\(true\)/,
      "the first-page bottom pin is missing",
    );
    assert.match(
      source,
      /olderAnchor = useRef<\{ scrollHeight: number; scrollTop: number \} \| null>/,
      "the scroll anchor for prepended pages is missing",
    );
    assert.match(
      source,
      /pinToBottom\.current = true/,
      "a new first page never re-pins the view to the newest message",
    );
    assert.match(
      source,
      /element\.scrollTop = element\.scrollHeight;/,
      "the first page is not scrolled to the newest (bottom) message",
    );
    assert.match(
      source,
      /element\.scrollTop =\s*element\.scrollHeight - anchor\.scrollHeight \+ anchor\.scrollTop;/,
      "prepending older messages does not restore the scroll offset",
    );
    assert.match(
      source,
      /\}, \[messages\]\);/,
      "the scroll adjustment must run when the loaded messages change",
    );

    const captureAt = source.indexOf("olderAnchor.current =");
    const updateAt = source.indexOf(
      "setMessages((current) => mergeOlderMessages",
    );
    assert.ok(
      captureAt >= 0 && updateAt > captureAt,
      "scroll metrics must be captured before the older page is merged",
    );
  });
}
