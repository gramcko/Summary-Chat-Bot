import { previousDayWindow } from "../scheduler.js";

/**
 * Period handling for the assistant's `summary` intent.
 *
 * All intervals are half-open (`start` inclusive, `end` exclusive) so
 * adjacent periods never double-count a message, and all day boundaries
 * are computed in the GROUP's IANA time zone (never the host's).
 *
 * Day math reuses the scheduler's `previousDayWindow`, which already
 * implements the DST-exact `[local midnight, next local midnight)`
 * window documented in ADR 0006 (no date library, two-pass
 * `Intl.DateTimeFormat` offset correction). Yesterday's window end IS
 * today's local midnight, so "today" needs no extra math.
 */

export const ASSISTANT_PERIODS = [
  "today",
  "yesterday",
  "last_24h",
  "last_7d",
] as const;

export type AssistantPeriod = (typeof ASSISTANT_PERIODS)[number];

/** Summaries default to a rolling day when the user names no period. */
export const DEFAULT_SUMMARY_PERIOD: AssistantPeriod = "last_24h";

export interface PeriodInterval {
  /** Inclusive instant (ISO 8601, UTC). */
  start: string;
  /** Exclusive instant (ISO 8601, UTC). */
  end: string;
  /** Effective IANA zone used for the day boundaries (UTC on fallback). */
  timezone: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Invalid zone names fall back to UTC instead of throwing: the assistant
 * must answer, and a bad `groups.timezone` value is a configuration bug
 * that the Groups page surfaces separately.
 */
function effectiveTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Resolves a user-facing period into a half-open interval.
 *
 * - `today`: [local midnight today, now)
 * - `yesterday`: previous local day, [local midnight yesterday, local
 *   midnight today) — a DST day may be 23h or 25h long.
 * - `last_24h`: rolling [now - 24h, now)
 * - `last_7d`: rolling [now - 7d, now)
 *
 * `now` is injectable for deterministic tests.
 */
export function periodToInterval(
  period: AssistantPeriod,
  timeZone: string,
  now: Date = new Date(),
): PeriodInterval {
  const timezone = effectiveTimeZone(timeZone);
  const nowMs = now.getTime();

  if (period === "last_24h") {
    return {
      start: new Date(nowMs - DAY_MS).toISOString(),
      end: new Date(nowMs).toISOString(),
      timezone,
    };
  }
  if (period === "last_7d") {
    return {
      start: new Date(nowMs - 7 * DAY_MS).toISOString(),
      end: new Date(nowMs).toISOString(),
      timezone,
    };
  }

  const yesterday = previousDayWindow(now, timezone);
  if (period === "yesterday") {
    return { start: yesterday.start, end: yesterday.end, timezone };
  }

  // today: [local midnight today, now). Exactly at local midnight the
  // window would be empty and `Interval` rejects it (end must be after
  // start), so the start is clamped one millisecond back.
  const todayStartMs = Math.min(Date.parse(yesterday.end), nowMs - 1);
  return {
    start: new Date(todayStartMs).toISOString(),
    end: new Date(nowMs).toISOString(),
    timezone,
  };
}

/** Human label used in assistant replies. */
export function describePeriod(period: AssistantPeriod): string {
  switch (period) {
    case "today":
      return "today (the current local day)";
    case "yesterday":
      return "yesterday (the previous local day)";
    case "last_24h":
      return "the last 24 hours";
    case "last_7d":
      return "the last 7 days";
  }
}
