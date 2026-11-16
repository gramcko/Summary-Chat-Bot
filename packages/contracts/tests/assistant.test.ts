import { describe, expect, it } from "vitest";
import {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantCitation,
} from "../src/assistant.js";

const GROUP_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

const MESSAGE_CITATION = {
  kind: "message",
  groupId: GROUP_ID,
  groupName: "Team",
  messageId: "wa-123",
  runId: null,
  sentAt: "2026-11-01T10:00:00Z",
};

const RESPONSE = {
  reply: "Found 1 message.",
  citations: [MESSAGE_CITATION],
  pendingRunId: null,
};

describe("AssistantChatRequest", () => {
  it("parses a conversation of user and assistant turns", () => {
    const request = {
      messages: [
        { role: "user", content: "summarize Team today" },
        { role: "assistant", content: "Queued a summary." },
        { role: "user", content: "thanks" },
      ],
    };
    expect(AssistantChatRequest.parse(request)).toEqual(request);
  });

  it("requires at least one and at most 20 turns", () => {
    expect(AssistantChatRequest.safeParse({ messages: [] }).success).toBe(false);
    expect(
      AssistantChatRequest.safeParse({
        messages: Array.from({ length: 21 }, () => ({
          role: "user",
          content: "hi",
        })),
      }).success,
    ).toBe(false);
    expect(
      AssistantChatRequest.safeParse({
        messages: Array.from({ length: 20 }, () => ({
          role: "user",
          content: "hi",
        })),
      }).success,
    ).toBe(true);
  });

  it("bounds turn content to 1..4000 characters and rejects unknown roles", () => {
    expect(
      AssistantChatRequest.safeParse({ messages: [{ role: "user", content: "" }] })
        .success,
    ).toBe(false);
    expect(
      AssistantChatRequest.safeParse({
        messages: [{ role: "user", content: "x".repeat(4001) }],
      }).success,
    ).toBe(false);
    expect(
      AssistantChatRequest.safeParse({
        messages: [{ role: "system", content: "hi" }],
      }).success,
    ).toBe(false);
  });
});

describe("AssistantCitation", () => {
  it("parses each kind with its nullable fields", () => {
    const group = {
      kind: "group",
      groupId: GROUP_ID,
      groupName: "Team",
      messageId: null,
      runId: null,
      sentAt: null,
    };
    const run = {
      kind: "run",
      groupId: GROUP_ID,
      groupName: "Team",
      messageId: null,
      runId: RUN_ID,
      sentAt: null,
    };
    expect(AssistantCitation.parse(group).kind).toBe("group");
    expect(AssistantCitation.parse(run).runId).toBe(RUN_ID);
    expect(AssistantCitation.parse(MESSAGE_CITATION).sentAt).toBe(
      "2026-11-01T10:00:00Z",
    );
  });

  it("rejects unknown kinds, empty names, and non-uuid group ids", () => {
    expect(
      AssistantCitation.safeParse({ ...MESSAGE_CITATION, kind: "contact" }).success,
    ).toBe(false);
    expect(
      AssistantCitation.safeParse({ ...MESSAGE_CITATION, groupName: "" }).success,
    ).toBe(false);
    expect(
      AssistantCitation.safeParse({ ...MESSAGE_CITATION, groupId: "Team" }).success,
    ).toBe(false);
  });
});

describe("AssistantChatResponse", () => {
  it("parses a reply with citations and a pending run", () => {
    const parsed = AssistantChatResponse.parse({
      ...RESPONSE,
      pendingRunId: RUN_ID,
    });
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.pendingRunId).toBe(RUN_ID);
  });

  it("requires a non-empty reply and caps citations at 20", () => {
    expect(
      AssistantChatResponse.safeParse({ ...RESPONSE, reply: "" }).success,
    ).toBe(false);
    expect(
      AssistantChatResponse.safeParse({
        ...RESPONSE,
        citations: Array.from({ length: 21 }, () => MESSAGE_CITATION),
      }).success,
    ).toBe(false);
    expect(
      AssistantChatResponse.safeParse({
        ...RESPONSE,
        citations: Array.from({ length: 20 }, () => MESSAGE_CITATION),
      }).success,
    ).toBe(true);
  });
});
