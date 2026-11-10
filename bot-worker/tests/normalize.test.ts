import { describe, expect, it } from "vitest";
import { isUrlOnly, normalizeMessage } from "../src/normalize.js";
import { rawMessage } from "./fakes.js";

/**
 * Normalization policy tests (ADR 0004). These encode the documented
 * capture/skip rules: text and links are captured, other content types
 * become "other" rows with the caption or an empty body, and the skip
 * list (status broadcasts, reactions, protocol/system notices, unusable
 * identity) is never persisted. Own group messages are captured.
 */

const GROUP = "111111111111-22222222@g.us";

describe("isUrlOnly (message_type 'link' heuristic)", () => {
  it("matches a single URL", () => {
    expect(isUrlOnly("https://example.com/a?b=1")).toBe(true);
  });

  it("matches several whitespace-separated URLs", () => {
    expect(isUrlOnly("https://a.example/x http://b.example/y")).toBe(true);
  });

  it("rejects URLs with surrounding text", () => {
    expect(isUrlOnly("see https://example.com please")).toBe(false);
  });

  it("rejects empty and non-URL text", () => {
    expect(isUrlOnly("")).toBe(false);
    expect(isUrlOnly("no links here")).toBe(false);
  });
});

describe("normalizeMessage: capture rules", () => {
  it("captures plain text as message_type text", () => {
    const result = normalizeMessage(
      rawMessage({ text: "hello world", kind: "text" }),
    );
    expect(result.action).toBe("capture");
    if (result.action !== "capture") throw new Error("unreachable");
    expect(result.row.messageType).toBe("text");
    expect(result.row.body).toBe("hello world");
    expect(result.row.chatJid).toBe(GROUP);
    expect(result.row.senderJid).toBe("sender@s.whatsapp.net");
    expect(result.row.sentAt.toISOString()).toBe(
      new Date(1_772_000_000 * 1000).toISOString(),
    );
  });

  it("classifies a URL-only body as link", () => {
    const result = normalizeMessage(
      rawMessage({ text: "https://example.com/doc", kind: "text" }),
    );
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("link");
    expect(result.row.body).toBe("https://example.com/doc");
  });

  it("classifies a link-preview message as link even with surrounding text", () => {
    const result = normalizeMessage(
      rawMessage({ kind: "link-preview", text: "look at this", linkPreview: true }),
    );
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("link");
  });

  it("keeps a mixed text/URL body as text", () => {
    const result = normalizeMessage(
      rawMessage({ text: "agenda: https://example.com/agenda" }),
    );
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("text");
  });

  it("captures other content types with their caption", () => {
    const result = normalizeMessage(
      rawMessage({ kind: "other", caption: "photo caption" }),
    );
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("other");
    expect(result.row.body).toBe("photo caption");
  });

  it("captures captionless other content with an empty body", () => {
    const result = normalizeMessage(rawMessage({ kind: "other", caption: null }));
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("other");
    expect(result.row.body).toBe("");
  });

  it("keeps an other row other even when the caption is only a URL", () => {
    const result = normalizeMessage(
      rawMessage({ kind: "other", caption: "https://example.com/img" }),
    );
    if (result.action !== "capture") throw new Error("expected capture");
    expect(result.row.messageType).toBe("other");
  });

  it("clamps sender names to 300 chars and maps empty to null (CR#5)", () => {
    const long = normalizeMessage(
      rawMessage({ senderName: "N".repeat(400) }),
    );
    if (long.action !== "capture") throw new Error("expected capture");
    expect(long.row.senderName).toBe("N".repeat(300));

    const short = normalizeMessage(rawMessage({ senderName: "Alice" }));
    if (short.action !== "capture") throw new Error("expected capture");
    expect(short.row.senderName).toBe("Alice");

    const empty = normalizeMessage(rawMessage({ senderName: "" }));
    if (empty.action !== "capture") throw new Error("expected capture");
    expect(empty.row.senderName).toBeNull();
  });
});

describe("normalizeMessage: skip rules (never persisted)", () => {
  it("captures own group messages and keeps their origin", () => {
    const result = normalizeMessage(
      rawMessage({ fromMe: true, text: "my own update" }),
    );
    expect(result.action).toBe("capture");
    if (result.action !== "capture") throw new Error("unreachable");
    expect(result.row.fromMe).toBe(true);
    expect(result.row.body).toBe("my own update");
  });

  it("skips own direct messages as non-group", () => {
    expect(
      normalizeMessage(
        rawMessage({ fromMe: true, chatJid: "34600111222@s.whatsapp.net" }),
      ),
    ).toEqual({ action: "skip", reason: "not-group" });
  });

  it("skips status broadcasts", () => {
    expect(
      normalizeMessage(rawMessage({ chatJid: "status@broadcast" })),
    ).toEqual({ action: "skip", reason: "status-broadcast" });
  });

  it("skips direct messages (not-group)", () => {
    expect(
      normalizeMessage(rawMessage({ chatJid: "34600111222@s.whatsapp.net" })),
    ).toEqual({ action: "skip", reason: "not-group" });
  });

  it("skips channels and newsletters (not-group)", () => {
    expect(
      normalizeMessage(rawMessage({ chatJid: "123456789@newsletter" })),
    ).toEqual({ action: "skip", reason: "not-group" });
  });

  it("skips reactions", () => {
    expect(normalizeMessage(rawMessage({ kind: "reaction" }))).toEqual({
      action: "skip",
      reason: "reaction",
    });
  });

  it("skips protocol messages (edits and deletions)", () => {
    expect(normalizeMessage(rawMessage({ kind: "protocol" }))).toEqual({
      action: "skip",
      reason: "protocol",
    });
  });

  it("skips system notices", () => {
    expect(normalizeMessage(rawMessage({ kind: "system" }))).toEqual({
      action: "skip",
      reason: "system",
    });
  });

  it("skips content-less messages as unsupported-type", () => {
    expect(normalizeMessage(rawMessage({ kind: "empty" }))).toEqual({
      action: "skip",
      reason: "unsupported-type",
    });
  });

  it("skips empty and whitespace-only text bodies (CR-m1)", () => {
    expect(normalizeMessage(rawMessage({ text: "" }))).toEqual({
      action: "skip",
      reason: "empty-body",
    });
    expect(normalizeMessage(rawMessage({ text: "   \t\n " }))).toEqual({
      action: "skip",
      reason: "empty-body",
    });
    expect(
      normalizeMessage(rawMessage({ text: "", linkPreview: true, kind: "link-preview" })),
    ).toEqual({ action: "skip", reason: "empty-body" });
  });

  it("skips messages without a message id", () => {
    expect(normalizeMessage(rawMessage({ messageId: null }))).toEqual({
      action: "skip",
      reason: "missing-id",
    });
    expect(normalizeMessage(rawMessage({ messageId: "" }))).toEqual({
      action: "skip",
      reason: "missing-id",
    });
  });

  it("skips messages without a usable timestamp", () => {
    expect(normalizeMessage(rawMessage({ timestampSec: null }))).toEqual({
      action: "skip",
      reason: "missing-timestamp",
    });
  });
});
