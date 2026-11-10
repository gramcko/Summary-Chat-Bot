import { describe, expect, it } from "vitest";
import { ConnectionStatus } from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

describe("health and read-only status routes", () => {
  it("answers the health probe without authentication", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports the connection status", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    expect(ConnectionStatus.parse(res.json()).state).toBe("unavailable");
  });

  it("returns 404 for a summary that does not exist yet", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/summaries/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("exposes the pairing QR only while linking (M-4 gate)", async () => {
    const { app, store } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(before.json()).linking).toBeNull();

    // A valid unexpired payload is served while LINKING (connecting).
    await store.setConnectionStatus({
      state: "connecting",
      since: new Date().toISOString(),
      lastMessageAt: null,
      linking: null,
      check: null,
    });
    await store.updateConnectionLinking({
      qr: "2@abc123pairingpayload",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    const during = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(during.json()).linking).toEqual({
      kind: "qr", // default for QR payloads
      qr: "2@abc123pairingpayload",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });

    // ... and while disconnected (the other allowed linking state).
    await store.setConnectionStatus({
      state: "disconnected",
      since: new Date().toISOString(),
      lastMessageAt: null,
      linking: null,
      check: null,
    });
    const disconnected = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(
      ConnectionStatus.parse(disconnected.json()).linking?.qr,
    ).toBe("2@abc123pairingpayload");

    // M-4: once CONNECTED the ticket is never served, even though the
    // payload is still stored and unexpired.
    await store.setConnectionStatus({
      state: "connected",
      since: new Date().toISOString(),
      lastMessageAt: null,
      linking: null,
      check: null,
    });
    const connected = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(connected.json()).linking).toBeNull();

    // M-4: an EXPIRED payload is never served either.
    await store.setConnectionStatus({
      state: "connecting",
      since: new Date().toISOString(),
      lastMessageAt: null,
      linking: null,
      check: null,
    });
    await store.updateConnectionLinking({
      qr: "2@expired",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const expired = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(expired.json()).linking).toBeNull();

    // Clearing (session linked) hides it too.
    await store.updateConnectionLinking(null);
    const after = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(after.json()).linking).toBeNull();
  });

  it("serves the pairing kind published with the payload", async () => {
    const { app, store } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    await store.setConnectionStatus({
      state: "connecting",
      since: new Date().toISOString(),
      lastMessageAt: null,
      linking: null,
      check: null,
    });
    await store.updateConnectionLinking({
      kind: "pairing-code",
      qr: "12345678",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(ConnectionStatus.parse(res.json()).linking?.kind).toBe("pairing-code");
  });

  it("marks API responses no-store with Vary: Cookie (M-4)", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const connection = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(connection.headers["cache-control"]).toBe("no-store, private");
    expect(connection.headers["vary"]).toBe("Cookie");

    const groups = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(groups.headers["cache-control"]).toBe("no-store, private");
    expect(groups.headers["vary"]).toBe("Cookie");

    // The scope is /api/*: the health probe is untouched.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["cache-control"]).toBeUndefined();
    expect(health.headers["vary"]).toBeUndefined();
  });

  it("records the admin logout request (202, idempotent)", async () => {
    const { app, store } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/connection/logout",
      headers: { cookie: session },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ ok: true });

    // Requesting again while pending is a no-op that still answers 202.
    const again = await app.inject({
      method: "POST",
      url: "/api/connection/logout",
      headers: { cookie: session },
    });
    expect(again.statusCode).toBe(202);

    // The bot-worker consumes the flag.
    await store.clearLogoutRequest();
    const after = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(after.statusCode).toBe(200);
  });

  it("requests a live session check and exposes the pending state", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const request = await app.inject({
      method: "POST",
      url: "/api/connection/test",
      headers: { cookie: session },
    });
    expect(request.statusCode).toBe(202);
    expect(request.json()).toEqual({ ok: true });

    const status = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    const parsed = ConnectionStatus.parse(status.json());
    expect(parsed.check?.status).toBe("pending");
    expect(parsed.check?.requestedAt).toBeTypeOf("string");
    expect(parsed.check?.checkedAt).toBeNull();
  });
});
