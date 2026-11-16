import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiMessage } from "@summarly/contracts";
import { InMemoryStore } from "../src/lib/store.js";

/**
 * Display-name precedence for members and messages (InMemoryStore).
 *
 * The admin contact override (`contact_overrides`) is the source of
 * truth: it wins over the roster name, which wins over the push name
 * captured with a message. A member whose roster row has no name must
 * still render the newest observed push name instead of a raw
 * LID/phone. The Postgres store mirrors this in SQL (see
 * postgres-store.test.ts for the integration assertions).
 */

const CHAT_ID = "120363000000000001@g.us";

function message(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: randomUUID(),
    chatId: CHAT_ID,
    sentAt: "2026-11-01T10:00:00Z",
    senderId: "111:4@s.whatsapp.net",
    senderName: "Ana Push",
    body: "hello",
    messageType: "text",
    ...overrides,
  };
}

async function seededStore(): Promise<{ store: InMemoryStore; groupId: string }> {
  const store = new InMemoryStore();
  const groupId = randomUUID();
  await store.upsertGroup({
    id: groupId,
    chatId: CHAT_ID,
    name: "Names Group",
    monitored: true,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  return { store, groupId };
}

describe("InMemoryStore display names", () => {
  it("lets a contact override win over the roster and message push names", async () => {
    const { store } = await seededStore();
    await store.upsertGroupMembers(CHAT_ID, [
      {
        userId: "111@lid",
        name: "Ana Roster",
        phone: "111@s.whatsapp.net",
        isAdmin: false,
        active: true,
      },
    ]);
    // Captured BEFORE the rename: the stored push name is stale.
    store.seedMessages([message({ senderName: "Ana Push" })]);

    // Roster name wins over the message push name (no override yet).
    expect((await store.listGroupMembers(CHAT_ID))[0]?.name).toBe("Ana Roster");
    expect(
      (await store.listGroupMessages(CHAT_ID, { limit: 50 }))[0]?.senderName,
    ).toBe("Ana Roster");

    const renamed = await store.renameContact("111@s.whatsapp.net", "Ana Renamed");
    expect(renamed?.name).toBe("Ana Renamed");

    // Members tab: the override is the display name.
    const members = await store.listGroupMembers(CHAT_ID);
    expect(members).toHaveLength(1);
    expect(members[0]?.name).toBe("Ana Renamed");
    // Group chat view: the override beats the old message push name.
    expect(
      (await store.listGroupMessages(CHAT_ID, { limit: 50 }))[0]?.senderName,
    ).toBe("Ana Renamed");
    // Contact messages and search follow the same precedence.
    expect(
      (
        await store.listContactMessages(["111@lid", "111@s.whatsapp.net"], {
          limit: 50,
        })
      )[0]?.senderName,
    ).toBe("Ana Renamed");
    expect(
      (await store.searchMessages({ text: "hello", limit: 50 }))[0]?.senderName,
    ).toBe("Ana Renamed");
  });

  it("falls back to the newest message push name for a nameless member", async () => {
    const { store } = await seededStore();
    await store.upsertGroupMembers(CHAT_ID, [
      {
        userId: "222@lid",
        name: null,
        phone: "222@s.whatsapp.net",
        isAdmin: false,
        active: true,
      },
      // Nothing known at all: stays null.
      {
        userId: "333@lid",
        name: null,
        phone: null,
        isAdmin: false,
        active: true,
      },
    ]);
    store.seedMessages([
      message({
        sentAt: "2026-11-01T09:00:00Z",
        senderId: "222:1@s.whatsapp.net",
        senderName: "Bea Old",
      }),
      // Newest observed push name wins.
      message({
        sentAt: "2026-11-01T11:00:00Z",
        senderId: "222:2@s.whatsapp.net",
        senderName: "Bea Newest",
      }),
      // A null push name never becomes the display name.
      message({
        sentAt: "2026-11-01T12:00:00Z",
        senderId: "222@s.whatsapp.net",
        senderName: null,
      }),
    ]);

    const members = await store.listGroupMembers(CHAT_ID);
    const bea = members.find((member) => member.userId === "222@lid");
    expect(bea?.name).toBe("Bea Newest");
    const unknown = members.find((member) => member.userId === "333@lid");
    expect(unknown?.name).toBeNull();
  });
});
