import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionStatus } from "@summarly/contracts";
import {
  formatCountdown,
  isLinkingExpired,
  secondsUntil,
  shouldPollConnection,
} from "../src/lib/connection.ts";

function status(state: ConnectionStatus["state"]): ConnectionStatus {
  return {
    state,
    since: "2026-11-04T09:00:00.000Z",
    lastMessageAt: null,
    linking: null,
    check: null,
  };
}

test("polls until the session is connected", () => {
  assert.equal(shouldPollConnection(null), true);
  assert.equal(shouldPollConnection(undefined), true);
  assert.equal(shouldPollConnection(status("connecting")), true);
  assert.equal(shouldPollConnection(status("disconnected")), true);
  assert.equal(shouldPollConnection(status("unavailable")), true);
  assert.equal(shouldPollConnection(status("connected")), false);
});

test("counts down whole seconds, floored at zero", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(secondsUntil("2026-11-04T12:01:30.000Z", now), 90);
  assert.equal(secondsUntil("2026-11-04T12:00:00.000Z", now), 0);
  assert.equal(secondsUntil("2026-11-04T11:59:00.000Z", now), 0);
  assert.equal(secondsUntil("not-a-date", now), 0);
});

test("detects expired pairing codes", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(isLinkingExpired(null, now), false);
  assert.equal(
    isLinkingExpired(
      { kind: "qr", qr: "ticket", expiresAt: "2026-11-04T12:00:30.000Z" },
      now,
    ),
    false,
  );
  assert.equal(
    isLinkingExpired(
      { kind: "pairing-code", qr: "12345678", expiresAt: "2026-11-04T11:59:30.000Z" },
      now,
    ),
    true,
  );
  assert.equal(
    isLinkingExpired({ kind: "qr", qr: "ticket", expiresAt: "garbage" }, now),
    true,
  );
});

test("formats a mm:ss countdown", () => {
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(9), "0:09");
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatCountdown(3599), "59:59");
  assert.equal(formatCountdown(-5), "0:00");
});
