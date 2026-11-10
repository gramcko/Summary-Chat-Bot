import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultRunWindow,
  formatDateTime,
  formatInterval,
  instantToWallTimeInZone,
  runWindowAroundLatest,
  wallTimeInZoneToInstant,
} from "../src/lib/time.ts";

test("interprets a wall time in a fixed-offset zone", () => {
  const instant = wallTimeInZoneToInstant("2026-01-15T09:30", "Asia/Tokyo");
  assert.ok(instant instanceof Date);
  assert.equal(instant.toISOString(), "2026-01-15T00:30:00.000Z");
});

test("interprets UTC wall times as-is", () => {
  const instant = wallTimeInZoneToInstant("2026-03-01T00:00", "UTC");
  assert.ok(instant instanceof Date);
  assert.equal(instant.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("accounts for daylight saving time in a DST zone", () => {
  const summer = wallTimeInZoneToInstant("2026-07-01T12:00", "Europe/Madrid");
  const winter = wallTimeInZoneToInstant("2026-01-15T12:00", "Europe/Madrid");
  assert.ok(summer instanceof Date);
  assert.ok(winter instanceof Date);
  // CEST is UTC+2, CET is UTC+1.
  assert.equal(summer.toISOString(), "2026-07-01T10:00:00.000Z");
  assert.equal(winter.toISOString(), "2026-01-15T11:00:00.000Z");
});

test("round-trips an instant through a wall time in a zone", () => {
  const wall = instantToWallTimeInZone(
    new Date("2026-07-01T10:00:00Z"),
    "Europe/Madrid",
  );
  assert.equal(wall, "2026-07-01T12:00");
  const back = wallTimeInZoneToInstant(wall ?? "", "Europe/Madrid");
  assert.ok(back instanceof Date);
  assert.equal(back.toISOString(), "2026-07-01T10:00:00.000Z");
});

test("rejects malformed values, impossible dates, and unknown zones", () => {
  assert.equal(wallTimeInZoneToInstant("", "UTC"), null);
  assert.equal(wallTimeInZoneToInstant("not-a-date", "UTC"), null);
  assert.equal(wallTimeInZoneToInstant("2026-02-31T10:00", "UTC"), null);
  assert.equal(wallTimeInZoneToInstant("2026-02-01T25:00", "UTC"), null);
  assert.equal(wallTimeInZoneToInstant("2026-02-01T10:00", "Mars/Olympus"), null);
  assert.equal(instantToWallTimeInZone(new Date(), "Mars/Olympus"), null);
});

test("builds a default 24 hour window in the group zone", () => {
  const now = new Date("2026-07-01T10:00:00Z");
  const window = defaultRunWindow("Europe/Madrid", now);
  assert.equal(window.end, "2026-07-01T12:00");
  assert.equal(window.start, "2026-06-30T12:00");

  const start = wallTimeInZoneToInstant(window.start, "Europe/Madrid");
  const end = wallTimeInZoneToInstant(window.end, "Europe/Madrid");
  assert.ok(start instanceof Date);
  assert.ok(end instanceof Date);
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
});

test("builds a window around the newest captured message", () => {
  const window = runWindowAroundLatest(
    "2026-11-02T21:50:42.000Z",
    "Europe/Madrid",
  );
  // Madrid is UTC+1 in November: 21:50:42Z is 22:50 wall time.
  assert.equal(window.end, "2026-11-02T22:51");
  assert.equal(window.start, "2026-11-01T22:50");

  const start = wallTimeInZoneToInstant(window.start, "Europe/Madrid");
  const end = wallTimeInZoneToInstant(window.end, "Europe/Madrid");
  assert.ok(start instanceof Date);
  assert.ok(end instanceof Date);
  assert.equal(
    end.getTime() - start.getTime(),
    24 * 60 * 60 * 1000 + 60 * 1000,
  );
});

test("falls back to the default window for an unusable timestamp", () => {
  const window = runWindowAroundLatest("not-a-timestamp", "Europe/Madrid");
  const start = wallTimeInZoneToInstant(window.start, "Europe/Madrid");
  const end = wallTimeInZoneToInstant(window.end, "Europe/Madrid");
  assert.ok(start instanceof Date);
  assert.ok(end instanceof Date);
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
});

test("formats intervals in the run time zone", () => {
  const formatted = formatInterval({
    start: "2026-07-01T10:00:00.000Z",
    end: "2026-07-02T10:00:00.000Z",
    timezone: "Europe/Madrid",
  });
  assert.match(formatted, /\(Europe\/Madrid\)$/);
  assert.ok(formatted.includes("→"));
});

test("falls back to the raw value for unparsable timestamps", () => {
  assert.equal(formatDateTime("not-a-timestamp"), "not-a-timestamp");
});
