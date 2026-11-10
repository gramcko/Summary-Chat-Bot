import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const ConnectionState = z.enum([
  "connected",
  "connecting",
  "disconnected",
  "unavailable",
]);

/**
 * The pairing QR / pairing payload currently displayed by the
 * bot-worker, with its expiry and its KIND: `qr` renders as a QR code,
 * `pairing-code` is the typed pairing-code flow (WA_PHONE_NUMBER). The
 * bot-worker publishes the kind alongside the payload; a stored payload
 * without a kind (rows written before the column existed) is served as
 * `qr` — the documented default for QR payloads.
 * `qr` is a LIVE PAIRING TICKET: it is only ever served on the
 * authenticated API and must never be logged (same class of secret as
 * WhatsApp session state, ADR 0004/0008).
 */
export const ConnectionLinking = z.object({
  kind: z.enum(["qr", "pairing-code"]).default("qr"),
  qr: z.string().min(1),
  expiresAt: IsoDateTime,
});

/**
 * Result of an on-demand session health check. `pending` means the admin
 * requested a check and the bot-worker has not answered yet; `ok`/`failed`
 * include the measured latency and a safe error code.
 */
export const ConnectionCheck = z.object({
  status: z.enum(["pending", "ok", "failed"]),
  requestedAt: IsoDateTime,
  checkedAt: IsoDateTime.nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  error: z.string().max(200).nullable(),
});

/**
 * Non-secret connection status. Never includes authentication
 * material. `linking` is non-null only while the session is being
 * linked (QR/pairing payload available); it is null once connected (or
 * when no linking is in progress). `check` is the latest session health
 * probe result, or null when no check was ever requested.
 */
export const ConnectionStatus = z.object({
  state: ConnectionState,
  since: IsoDateTime,
  lastMessageAt: IsoDateTime.nullable(),
  linking: ConnectionLinking.nullable(),
  check: ConnectionCheck.nullable(),
});

export type ConnectionState = z.infer<typeof ConnectionState>;
export type ConnectionLinking = z.infer<typeof ConnectionLinking>;
export type ConnectionCheck = z.infer<typeof ConnectionCheck>;
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
