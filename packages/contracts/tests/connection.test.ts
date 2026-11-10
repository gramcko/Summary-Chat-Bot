import { describe, expect, it } from "vitest";
import { ConnectionLinking, ConnectionStatus } from "../src/index.js";

const BASE = {
  state: "connected",
  since: "2026-11-01T09:00:00Z",
  lastMessageAt: "2026-11-01T09:15:00Z",
  linking: null,
  check: null,
};

describe("ConnectionStatus.linking (pairing ticket, ADR 0008)", () => {
  it("is null when no linking is in progress (e.g. connected)", () => {
    const parsed = ConnectionStatus.parse({ ...BASE, linking: null });
    expect(parsed.linking).toBeNull();
  });

  it("carries the QR payload and its expiry while linking", () => {
    const parsed = ConnectionStatus.parse({
      ...BASE,
      state: "connecting",
      linking: { qr: "2@abc123pairingpayload", expiresAt: "2026-11-01T09:05:00Z" },
    });
    expect(parsed.linking?.qr).toBe("2@abc123pairingpayload");
    expect(parsed.linking?.expiresAt).toBe("2026-11-01T09:05:00Z");
    // kind defaults to "qr" when not published explicitly.
    expect(parsed.linking?.kind).toBe("qr");
  });

  it("requires both fields when linking is present", () => {
    expect(
      ConnectionStatus.safeParse({
        ...BASE,
        linking: { qr: "", expiresAt: "2026-11-01T09:05:00Z" },
      }).success,
    ).toBe(false);
    expect(
      ConnectionStatus.safeParse({
        ...BASE,
        linking: { qr: "2@abc" },
      }).success,
    ).toBe(false);
    // The field itself is required-but-nullable (like every system
    // field in this API surface).
    const { linking: _linking, ...withoutLinking } = BASE;
    expect(ConnectionStatus.safeParse(withoutLinking).success).toBe(false);
  });
});

describe("ConnectionStatus.check (session health probe)", () => {
  it("accepts pending, ok, failed, and null", () => {
    const pending = ConnectionStatus.parse({
      ...BASE,
      check: {
        status: "pending",
        requestedAt: "2026-11-01T10:00:00Z",
        checkedAt: null,
        latencyMs: null,
        error: null,
      },
    });
    expect(pending.check?.status).toBe("pending");

    const ok = ConnectionStatus.parse({
      ...BASE,
      check: {
        status: "ok",
        requestedAt: "2026-11-01T10:00:00Z",
        checkedAt: "2026-11-01T10:00:01Z",
        latencyMs: 42,
        error: null,
      },
    });
    expect(ok.check?.latencyMs).toBe(42);

    const failed = ConnectionStatus.parse({
      ...BASE,
      check: {
        status: "failed",
        requestedAt: "2026-11-01T10:00:00Z",
        checkedAt: "2026-11-01T10:00:10Z",
        latencyMs: 10_000,
        error: "check_timeout",
      },
    });
    expect(failed.check?.error).toBe("check_timeout");
    expect(ConnectionStatus.parse({ ...BASE, check: null }).check).toBeNull();
  });
});

describe("ConnectionLinking.kind (pairing display, fix round A)", () => {
  it("accepts qr and pairing-code, and defaults to qr when absent", () => {
    expect(
      ConnectionLinking.parse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "pairing-code",
      }).kind,
    ).toBe("pairing-code");
    // Default behavior: QR payloads (pre-kind rows) are served as "qr".
    expect(
      ConnectionLinking.parse({
        qr: "2@abc123pairingpayload",
        expiresAt: "2026-11-01T09:05:00Z",
      }).kind,
    ).toBe("qr");
  });

  it("rejects any other kind spelling", () => {
    expect(
      ConnectionLinking.safeParse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "QR",
      }).success,
    ).toBe(false);
    expect(
      ConnectionLinking.safeParse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "pairing",
      }).success,
    ).toBe(false);
  });
});
