/**
 * Time-zone aware conversions for the manual summary request form.
 *
 * The backend compares instants and requires an explicit IANA time zone
 * (architecture §5.3, half-open `[start, end)` intervals). `<input
 * type="datetime-local">` only yields a wall-clock string, so we interpret that
 * wall time in the selected group time zone and send ISO instants.
 *
 * No date library is used: `Intl.DateTimeFormat` exposes the zone offset for a
 * given instant. DST gaps/overlaps are resolved with two passes (the stable
 * interpretation of an ambiguous wall time is not defined by the platform).
 */

const WALL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone,
    hourCycle: "h23",
  });
}

function partsToRecord(
  parts: Intl.DateTimeFormatPart[],
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") record[part.type] = part.value;
  }
  return record;
}

/**
 * Offset of `timeZone` at `date`, in milliseconds (zone time minus UTC).
 * Returns `null` for an unknown time zone.
 */
export function timeZoneOffsetMs(date: Date, timeZone: string): number | null {
  try {
    const record = partsToRecord(
      formatter(timeZone, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(date),
    );
    const year = Number(record.year);
    const month = Number(record.month);
    const day = Number(record.day);
    const hour = Number(record.hour);
    const minute = Number(record.minute);
    const second = Number(record.second);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(second)
    ) {
      return null;
    }
    const asUtc = Date.UTC(year, month - 1, day, hour % 24, minute, second);
    const secondAligned = Math.floor(date.getTime() / 1000) * 1000;
    return asUtc - secondAligned;
  } catch {
    return null;
  }
}

/**
 * Converts a `datetime-local` wall time (`YYYY-MM-DDTHH:mm`) in `timeZone`
 * into the corresponding instant. Returns `null` for malformed input, an
 * unknown zone, or an impossible calendar date.
 */
export function wallTimeInZoneToInstant(
  wallTime: string,
  timeZone: string,
): Date | null {
  const match = WALL_TIME_PATTERN.exec(wallTime.trim());
  if (match === null) return null;

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match;
  if (
    rawYear === undefined ||
    rawMonth === undefined ||
    rawDay === undefined ||
    rawHour === undefined ||
    rawMinute === undefined
  ) {
    return null;
  }

  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = rawSecond === undefined ? 0 : Number(rawSecond);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(naiveUtc)) return null;

  // Reject values that the Date constructor silently rolls over (e.g. 31 Feb).
  const check = new Date(naiveUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  const firstOffset = timeZoneOffsetMs(new Date(naiveUtc), timeZone);
  if (firstOffset === null) return null;

  let instantMs = naiveUtc - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(instantMs), timeZone);
  if (secondOffset === null) return null;
  if (secondOffset !== firstOffset) instantMs = naiveUtc - secondOffset;

  return new Date(instantMs);
}

/**
 * Formats an instant as a `datetime-local` value (`YYYY-MM-DDTHH:mm`) in
 * `timeZone`. Returns `null` for an unknown zone.
 */
export function instantToWallTimeInZone(
  instant: Date,
  timeZone: string,
): string | null {
  try {
    const record = partsToRecord(
      formatter(timeZone, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(instant),
    );
    const { year, month, day, hour, minute } = record;
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined
    ) {
      return null;
    }
    const normalizedHour = hour === "24" ? "00" : hour;
    return `${year}-${month}-${day}T${normalizedHour}:${minute}`;
  } catch {
    return null;
  }
}

/**
 * Default manual request window: the last 24 hours, expressed as wall time in
 * the group time zone.
 */
export function defaultRunWindow(
  timeZone: string,
  now: Date = new Date(),
): { start: string; end: string } {
  const end =
    instantToWallTimeInZone(now, timeZone) ??
    instantToWallTimeInZone(now, "UTC") ??
    "";
  const start =
    instantToWallTimeInZone(new Date(now.getTime() - DAY_MS), timeZone) ?? "";
  return { start, end };
}

/**
 * Default manual-request window for a group whose newest captured message
 * is `iso`: a rolling 24 hours ending one minute after that message. This
 * makes a fresh request actually include the group's latest messages even
 * when they are older than the current day.
 */
export function runWindowAroundLatest(
  iso: string,
  timeZone: string,
): { start: string; end: string } {
  const newest = new Date(iso);
  if (Number.isNaN(newest.getTime())) return defaultRunWindow(timeZone);
  const start = instantToWallTimeInZone(
    new Date(newest.getTime() - DAY_MS),
    timeZone,
  );
  const end = instantToWallTimeInZone(
    new Date(newest.getTime() + 60_000),
    timeZone,
  );
  if (start === null || end === null) return defaultRunWindow(timeZone);
  return { start, end };
}

/** Formats an ISO instant for display, optionally in a specific time zone. */
export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };

  try {
    return new Intl.DateTimeFormat(
      undefined,
      timeZone === undefined ? options : { ...options, timeZone },
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

/** Day heading for the chat view (`Mon, 3 Nov 2026`), optionally in a zone. */
export function formatDayHeading(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  };
  try {
    return new Intl.DateTimeFormat(
      undefined,
      timeZone === undefined ? options : { ...options, timeZone },
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

/** Clock time (`14:05`), optionally in a zone, for chat timestamps. */
export function formatTimeOnly(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = { timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat(
      undefined,
      timeZone === undefined ? options : { ...options, timeZone },
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

/** Human readable half-open interval, rendered in the run's own time zone. */
export function formatInterval(interval: {
  start: string;
  end: string;
  timezone: string;
}): string {
  return `${formatDateTime(interval.start, interval.timezone)} → ${formatDateTime(
    interval.end,
    interval.timezone,
  )} (${interval.timezone})`;
}

/** ISO date (`YYYY-MM-DD`) for a `TaskItem.dueDate`, or a fallback label. */
export function formatDueDate(dueDate: string | null): string {
  if (dueDate === null) return "not specified";
  const date = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dueDate;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}
