import { z } from "zod";
import { IanaTimeZone } from "./common.js";

/**
 * Provider base-URL validation (audit E-2). The URL addresses a
 * CREDENTIAL-BEARING endpoint: the saved API key is sent as a header,
 * so a hostile or mistaken base URL can exfiltrate it.
 *
 * Schema-level rules (always enforced):
 * - https only;
 * - best-effort rejection of obvious internal targets (localhost,
 *   loopback, RFC1918, link-local, *.internal, *.local). This is
 *   defense in depth, not a security boundary — SSRF protection is the
 *   deployment's job.
 *
 * Runtime-level rule (see the summary-worker's resolve-provider): a
 * custom (non-Google) host is honored only when the operator sets
 * AI_ALLOW_CUSTOM_BASE_URL=yes (privileged; documented in ADR 0005).
 */
const INTERNAL_HOST_RE =
  /^(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|\[::1\]|.*\.(internal|local))$/i;

export const ProviderBaseUrl = z
  .url()
  .max(500)
  .refine(
    (url) => new URL(url).protocol === "https:",
    "must be an https URL",
  )
  .refine(
    (url) => !INTERNAL_HOST_RE.test(new URL(url).hostname),
    "must not target an internal host",
  );

/**
 * Provider configuration as returned to the browser.
 * Deliberately contains no key field of any kind: saved credentials are
 * masked by construction and cannot leak through this type. Reads only
 * report whether a key is saved.
 */
export const ProviderConfigPublic = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  baseUrl: ProviderBaseUrl.nullable(),
  hasApiKey: z.boolean(),
});

/**
 * Write shape for provider configuration. Omit `apiKey` to keep the
 * currently saved key; a string replaces it; explicit null clears it.
 */
export const ProviderConfigUpdate = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  baseUrl: ProviderBaseUrl.nullable().optional(),
  apiKey: z.string().min(1).max(500).nullable().optional(),
});

export type ProviderConfigPublic = z.infer<typeof ProviderConfigPublic>;
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdate>;

/**
 * Global default IANA time zone for NEW groups and as the initial value
 * of the summary request form. Existing groups keep their own zone.
 */
export const DefaultTimezoneSettings = z.object({
  timezone: IanaTimeZone,
});

export type DefaultTimezoneSettings = z.infer<typeof DefaultTimezoneSettings>;

/**
 * Display date formats offered in Settings. Stored as explicit pattern
 * strings so the value is self-describing and stable regardless of the
 * browser locale. Keep `dashboard/src/lib/time.ts` in sync.
 */
export const DATE_FORMATS = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
  "DD MMM YYYY",
] as const;

export const DateFormat = z.enum(DATE_FORMATS);
export type DateFormat = z.infer<typeof DateFormat>;

/** Global date format used by generic dashboard timestamps. */
export const DefaultDateFormatSettings = z.object({
  dateFormat: DateFormat,
});

export type DefaultDateFormatSettings = z.infer<
  typeof DefaultDateFormatSettings
>;
