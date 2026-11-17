import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiMessage } from "@summarly/contracts";
import {
  MAX_FOCUS_PAGE_FETCHES,
  defaultMessageRange,
  findMessageInOlderPages,
  groupMessagesByDay,
  mergeOlderMessages,
  resolveMessageRange,
  senderLabel,
} from "../src/lib/group-messages.ts";

function message(id: string, sentAt: string): ApiMessage {
  return {
    id,
    sentAt,
    senderId: "sender-1",
    senderName: "Ana",
    body: `message ${id}`,
    messageType: "text",
  };
}

test("the default message range covers the last seven days", () => {
  const range = defaultMessageRange("UTC", new Date("2026-11-04T12:00:00.000Z"));

  assert.deepEqual(range, {
    from: "2026-10-28T12:00",
    to: "2026-11-04T12:01",
  });
});

test("the default range includes the current minute (to is exclusive)", () => {
  // 12:00:30 — an end of 12:00 would drop the whole 12:00 minute.
  const range = defaultMessageRange("UTC", new Date("2026-11-04T12:00:30.000Z"));
  assert.equal(range.to, "2026-11-04T12:01");

  // Group time zone is honoured when rounding the minute.
  const madrid = defaultMessageRange(
    "Europe/Madrid",
    new Date("2026-07-01T10:00:30.000Z"),
  );
  assert.equal(madrid.to, "2026-07-01T12:01");
});

test("converts wall times in the group zone to half-open instants", () => {
  const result = resolveMessageRange(
    { from: "2026-11-01T00:00", to: "2026-11-02T00:00" },
    "UTC",
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.range, {
    fromIso: "2026-11-01T00:00:00.000Z",
    toIso: "2026-11-02T00:00:00.000Z",
  });
});

test("honours the group time zone offset", () => {
  const result = resolveMessageRange(
    { from: "2026-01-15T10:00", to: "2026-01-15T12:00" },
    "Asia/Tokyo",
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.range, {
    fromIso: "2026-01-15T01:00:00.000Z",
    toIso: "2026-01-15T03:00:00.000Z",
  });
});

test("requires both ends of the range", () => {
  assert.match(
    String(resolveMessageRange({ from: "", to: "2026-11-02T00:00" }, "UTC").error),
    /start and an end/i,
  );
  assert.match(
    String(resolveMessageRange({ from: "2026-11-01T00:00", to: "" }, "UTC").error),
    /start and an end/i,
  );
});

test("rejects an end that is not after the start", () => {
  const same = resolveMessageRange(
    { from: "2026-11-01T00:00", to: "2026-11-01T00:00" },
    "UTC",
  );
  const backwards = resolveMessageRange(
    { from: "2026-11-02T00:00", to: "2026-11-01T00:00" },
    "UTC",
  );

  assert.equal(same.range, null);
  assert.match(String(same.error), /end of the range must be after the start/i);
  assert.equal(backwards.range, null);
  assert.match(String(backwards.error), /end of the range must be after the start/i);
});

test("rejects impossible wall times and unknown zones", () => {
  assert.match(
    String(
      resolveMessageRange(
        { from: "2026-02-31T00:00", to: "2026-03-02T00:00" },
        "UTC",
      ).error,
    ),
    /valid date and time/i,
  );
  assert.equal(
    resolveMessageRange(
      { from: "2026-11-01T00:00", to: "2026-11-02T00:00" },
      "Mars/Olympus",
    ).range,
    null,
  );
});

test("merging older pages appends without duplicating ids", () => {
  const current = [message("a", "2026-11-03T10:00:00.000Z")];
  const older = [
    message("b", "2026-11-02T10:00:00.000Z"),
    message("a", "2026-11-03T10:00:00.000Z"),
    message("c", "2026-11-01T10:00:00.000Z"),
  ];

  const merged = mergeOlderMessages(current, older);

  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.equal(mergeOlderMessages(merged, []).length, 3);
});

test("grouping keeps consecutive same-day messages in one group, in order", () => {
  const ordered = [
    message("a", "2026-11-02T09:00:00.000Z"),
    message("b", "2026-11-02T18:00:00.000Z"),
    message("c", "2026-11-03T08:00:00.000Z"),
  ];

  const groups = groupMessagesByDay(ordered, (sentAt) => sentAt.slice(0, 10));

  assert.deepEqual(
    groups.map((group) => group.heading),
    ["2026-11-02", "2026-11-03"],
  );
  assert.deepEqual(
    groups.map((group) => group.messages.map((entry) => entry.id)),
    [["a", "b"], ["c"]],
  );
  assert.deepEqual(groupMessagesByDay([], () => "unused"), []);
});

test("sender label prefers the push name", () => {
  assert.equal(senderLabel(message("a", "2026-11-03T10:00:00.000Z")), "Ana");
  assert.equal(
    senderLabel({ ...message("a", "2026-11-03T10:00:00.000Z"), senderName: null }),
    "sender-1",
  );
});

test("finding a cited message stops at the first page when it is there", async () => {
  let fetches = 0;
  const result = await findMessageInOlderPages(
    { items: [message("a", "2026-11-03T10:00:00.000Z")], nextCursor: "c1" },
    "a",
    async () => {
      fetches += 1;
      return { items: [], nextCursor: null };
    },
  );

  assert.equal(result.found, true);
  assert.deepEqual(result.pages, []);
  assert.equal(result.nextCursor, "c1");
  assert.equal(fetches, 0, "the first page must not trigger an extra fetch");
});

test("finding a cited message walks older pages and keeps the next cursor", async () => {
  const pages: Record<string, { items: ApiMessage[]; nextCursor: string | null }> = {
    c1: { items: [message("b", "2026-11-02T10:00:00.000Z")], nextCursor: "c2" },
    c2: {
      items: [
        message("c", "2026-11-01T10:00:00.000Z"),
        message("d", "2026-10-31T10:00:00.000Z"),
      ],
      nextCursor: "c3",
    },
  };
  const visited: string[] = [];

  const result = await findMessageInOlderPages(
    { items: [message("a", "2026-11-03T10:00:00.000Z")], nextCursor: "c1" },
    "c",
    async (cursor) => {
      visited.push(cursor);
      return pages[cursor] ?? { items: [], nextCursor: null };
    },
  );

  assert.equal(result.found, true);
  assert.deepEqual(visited, ["c1", "c2"]);
  assert.deepEqual(
    result.pages.map((page) => page.items.map((entry) => entry.id)),
    [["b"], ["c", "d"]],
  );
  assert.equal(result.nextCursor, "c3");
});

test("finding a cited message stops at the end of the history", async () => {
  let fetches = 0;
  const result = await findMessageInOlderPages(
    { items: [message("a", "2026-11-03T10:00:00.000Z")], nextCursor: "c1" },
    "missing",
    async () => {
      fetches += 1;
      return { items: [message("b", "2026-11-02T10:00:00.000Z")], nextCursor: null };
    },
  );

  assert.equal(result.found, false);
  assert.equal(fetches, 1);
  assert.equal(result.nextCursor, null);
});

test("finding a cited message never fetches more than the bound", async () => {
  let fetches = 0;
  const result = await findMessageInOlderPages(
    { items: [message("a", "2026-11-03T10:00:00.000Z")], nextCursor: "c1" },
    "missing",
    async (cursor) => {
      fetches += 1;
      return {
        items: [message(`older-${cursor}`, "2026-11-02T10:00:00.000Z")],
        nextCursor: `next-${cursor}`,
      };
    },
    3,
  );

  assert.equal(result.found, false);
  assert.equal(fetches, 3);
  assert.equal(result.nextCursor, "next-next-next-c1");
  assert.ok(MAX_FOCUS_PAGE_FETCHES >= 40, "the default bound must stay bounded");
});

test("finding a cited message propagates fetch failures", async () => {
  await assert.rejects(
    findMessageInOlderPages(
      { items: [], nextCursor: "c1" },
      "missing",
      async () => {
        throw new Error("network down");
      },
    ),
    /network down/,
  );
});
