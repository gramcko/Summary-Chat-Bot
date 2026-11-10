import type { FastifyInstance } from "fastify";
import {
  DefaultDateFormatSettings,
  DefaultTimezoneSettings,
  ProviderConfigPublic,
  ProviderConfigUpdate,
} from "@summarly/contracts";
import { CryptoError } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { type ProviderRecord, type Store } from "../lib/store.js";

/**
 * Reads the saved provider config, mapping a failed decryption (master
 * key rotated, or the stored value corrupted/tampered) to a clear
 * conflict instead of a generic 500 (M10). The message tells the
 * operator to re-enter the key; key material is never echoed.
 */
async function readProviderConfig(store: Store): Promise<ProviderRecord | null> {
  try {
    return await store.getProviderConfig();
  } catch (error) {
    if (error instanceof CryptoError) {
      throw new HttpError(
        409,
        "conflict",
        "The saved API key is unreadable (ENCRYPTION_KEY changed or the stored value is corrupted). Send apiKey in PUT /api/settings/ai-provider to replace it.",
      );
    }
    throw error;
  }
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/settings/ai-provider", async () => {
    const provider = await readProviderConfig(store);
    if (provider === null) {
      throw new HttpError(404, "not_found", "AI provider is not configured.");
    }
    // Parse masks by construction: no key material can leave this handler.
    return ProviderConfigPublic.parse({
      provider: provider.provider,
      model: provider.model,
      baseUrl: provider.baseUrl,
      hasApiKey: provider.apiKey !== null,
    });
  });

  app.put("/api/settings/ai-provider", async (request) => {
    const body = ProviderConfigUpdate.parse(request.body);
    // Only read the previous record when the request leaves something
    // unspecified. A fully-specified PUT (provider, model, baseUrl,
    // apiKey) must succeed even when the saved key is unreadable, so an
    // ENCRYPTION_KEY rotation never bricks the settings screen (M10).
    const needsPrevious =
      body.apiKey === undefined || body.baseUrl === undefined;
    const previous = needsPrevious ? await readProviderConfig(store) : null;
    // Omitting apiKey keeps the currently saved key.
    const apiKey =
      body.apiKey !== undefined
        ? body.apiKey
        : (previous?.apiKey ?? null);
    const stored = await store.setProviderConfig({
      provider: body.provider,
      model: body.model,
      baseUrl:
        body.baseUrl !== undefined ? body.baseUrl : (previous?.baseUrl ?? null),
      apiKey,
    });
    return ProviderConfigPublic.parse({
      provider: stored.provider,
      model: stored.model,
      baseUrl: stored.baseUrl,
      hasApiKey: apiKey !== null,
    });
  });

  /** Global default IANA time zone (new groups + summary form default). */
  app.get("/api/settings/default-timezone", async () =>
    DefaultTimezoneSettings.parse({
      timezone: await store.getDefaultTimezone(),
    }),
  );

  app.put("/api/settings/default-timezone", async (request) => {
    const body = DefaultTimezoneSettings.parse(request.body);
    const timezone = await store.setDefaultTimezone(body.timezone);
    return DefaultTimezoneSettings.parse({ timezone });
  });

  /** Global display date format for generic dashboard timestamps. */
  app.get("/api/settings/default-date-format", async () =>
    DefaultDateFormatSettings.parse({
      dateFormat: await store.getDefaultDateFormat(),
    }),
  );

  app.put("/api/settings/default-date-format", async (request) => {
    const body = DefaultDateFormatSettings.parse(request.body);
    const dateFormat = await store.setDefaultDateFormat(body.dateFormat);
    return DefaultDateFormatSettings.parse({ dateFormat });
  });
}
