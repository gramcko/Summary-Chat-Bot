import { describe, expect, it } from "vitest";
import { ApiError, ProviderConfigPublic } from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

async function authedApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  const session = await login(ctx.app);
  return { ...ctx, session };
}

describe("AI provider settings", () => {
  it("404s before anything is configured", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("never returns the saved api key, only hasApiKey", async () => {
    const { app, session } = await authedApp();
    const secret = "sk-must-never-appear-in-a-response";
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: {
        provider: "openai-compatible",
        model: "test-model",
        apiKey: secret,
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    const config = ProviderConfigPublic.parse(get.json());
    expect(config.hasApiKey).toBe(true);
    expect(get.body).not.toContain(secret);
    expect(get.body).not.toContain("apiKey");
  });

  it("keeps the saved key when an update omits apiKey", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: "sk-old" },
    });
    const update = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v2" },
    });
    expect(update.statusCode).toBe(200);
    const config = ProviderConfigPublic.parse(update.json());
    expect(config.model).toBe("v2");
    expect(config.hasApiKey).toBe(true);
  });

  it("clears a saved key with an explicit null", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: "sk-old" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(ProviderConfigPublic.parse(cleared.json()).hasApiKey).toBe(false);
  });

  it("reports hasApiKey false when configured without a key", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "mock", model: "mock-1" },
    });
    const get = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    expect(ProviderConfigPublic.parse(get.json()).hasApiKey).toBe(false);
  });

  it("rejects an invalid configuration payload", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "", model: "test-model" },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
  });
});

describe("default date format settings", () => {
  it("defaults to DD/MM/YYYY and accepts a known format", async () => {
    const { app, session } = await authedApp();
    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/default-date-format",
      headers: { cookie: session },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ dateFormat: "DD/MM/YYYY" });

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/default-date-format",
      headers: { cookie: session },
      payload: { dateFormat: "YYYY-MM-DD" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ dateFormat: "YYYY-MM-DD" });

    const updated = await app.inject({
      method: "GET",
      url: "/api/settings/default-date-format",
      headers: { cookie: session },
    });
    expect(updated.json()).toEqual({ dateFormat: "YYYY-MM-DD" });
  });

  it("rejects an unknown format", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/default-date-format",
      headers: { cookie: session },
      payload: { dateFormat: "DD-MM-YY" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("default time zone settings", () => {
  it("defaults to UTC and accepts a valid IANA zone", async () => {
    const { app, session } = await authedApp();
    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/default-timezone",
      headers: { cookie: session },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ timezone: "UTC" });

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/default-timezone",
      headers: { cookie: session },
      payload: { timezone: "America/Caracas" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ timezone: "America/Caracas" });

    const updated = await app.inject({
      method: "GET",
      url: "/api/settings/default-timezone",
      headers: { cookie: session },
    });
    expect(updated.json()).toEqual({ timezone: "America/Caracas" });
  });

  it("rejects an unknown zone", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/default-timezone",
      headers: { cookie: session },
      payload: { timezone: "Mars/Olympus" },
    });
    expect(res.statusCode).toBe(400);
  });
});
