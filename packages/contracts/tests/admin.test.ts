import { describe, expect, it } from "vitest";
import {
  DeleteAllDataCounts,
  DeleteAllDataRequest,
  DeleteAllDataResponse,
} from "../src/index.js";

describe("DeleteAllDataRequest (guarded confirmation)", () => {
  it("accepts the exact DELETE ALL confirmation", () => {
    expect(DeleteAllDataRequest.parse({ confirmation: "DELETE ALL" })).toEqual({
      confirmation: "DELETE ALL",
    });
  });

  it("rejects any other confirmation", () => {
    for (const confirmation of [
      "DELETE",
      "delete all",
      " DELETE ALL",
      "DELETE ALL ",
      "DELETE ALL DATA",
      "",
      null,
      42,
    ]) {
      expect(
        DeleteAllDataRequest.safeParse({ confirmation }).success,
        String(confirmation),
      ).toBe(false);
    }
  });

  it("rejects a missing body or missing confirmation", () => {
    expect(DeleteAllDataRequest.safeParse(undefined).success).toBe(false);
    expect(DeleteAllDataRequest.safeParse({}).success).toBe(false);
  });
});

describe("DeleteAllDataCounts", () => {
  const counts = {
    groups: 1,
    messages: 10,
    summaryRuns: 2,
    summaries: 2,
    groupMembers: 4,
    contactOverrides: 1,
  };

  it("accepts non-negative integer counts", () => {
    expect(DeleteAllDataCounts.parse(counts)).toEqual(counts);
    expect(
      DeleteAllDataCounts.parse({
        groups: 0,
        messages: 0,
        summaryRuns: 0,
        summaries: 0,
        groupMembers: 0,
        contactOverrides: 0,
      }),
    ).toEqual({
      groups: 0,
      messages: 0,
      summaryRuns: 0,
      summaries: 0,
      groupMembers: 0,
      contactOverrides: 0,
    });
  });

  it("rejects negative, fractional, or missing counts", () => {
    expect(
      DeleteAllDataCounts.safeParse({ ...counts, messages: -1 }).success,
    ).toBe(false);
    expect(
      DeleteAllDataCounts.safeParse({ ...counts, groups: 1.5 }).success,
    ).toBe(false);
    const { groups: _groups, ...withoutGroups } = counts;
    expect(DeleteAllDataCounts.safeParse(withoutGroups).success).toBe(false);
  });
});

describe("DeleteAllDataResponse", () => {
  it("parses ok:true with the deletion counts", () => {
    const parsed = DeleteAllDataResponse.parse({
      ok: true,
      deleted: {
        groups: 2,
        messages: 7,
        summaryRuns: 3,
        summaries: 3,
        groupMembers: 9,
        contactOverrides: 0,
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.messages).toBe(7);
  });

  it("requires ok to be literally true", () => {
    const deleted = {
      groups: 0,
      messages: 0,
      summaryRuns: 0,
      summaries: 0,
      groupMembers: 0,
      contactOverrides: 0,
    };
    expect(DeleteAllDataResponse.safeParse({ ok: false, deleted }).success).toBe(
      false,
    );
    expect(DeleteAllDataResponse.safeParse({ deleted }).success).toBe(false);
  });
});
