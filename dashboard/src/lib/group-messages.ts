import type { ApiMessage } from "@summarly/contracts";
// Explicit `.ts` extension: this module is also imported by `node:test` directly
// (type stripping needs a full specifier); `allowImportingTsExtensions` is on.
import { instantToWallTimeInZone, wallTimeInZoneToInstant } from "./time.ts";

/**
 * Pure helpers for the group "Messages" tab.
 *
 * The API filters a half-open instant range `[from, to)` (start inclusive, end
 * exclusive) and returns newest-first pages with a `nextCursor`. The form takes
 * `datetime-local` wall times in the group's time zone and converts them to
 * instants, exactly like a summary request.
 */

export const MESSAGE_PAGE_SIZE = 50;
export const DEFAULT_RANGE_DAYS = 7;

/**
 * Bound for the automatic page walk that locates a cited source message. A run
 * whose cited message sits deeper than this is reported as "not among the
 * loaded source messages" instead of walking the whole history.
 */
export const MAX_FOCUS_PAGE_FETCHES = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageRangeInput {
  /** `datetime-local` wall time in the group time zone. */
  from: string;
  to: string;
}

export interface ResolvedMessageRange {
  fromIso: string;
  toIso: string;
}

export interface MessageRangeResult {
  /** `null` when the input is invalid; `error` then explains why. */
  range: ResolvedMessageRange | null;
  error: string | null;
}

/**
 * Default filter window: the last seven days, as wall times in `timeZone`.
 * `to` is exclusive, so it is rounded UP to the next minute — otherwise the
 * admin's current minute would be silently excluded.
 */
export function defaultMessageRange(
  timeZone: string,
  now: Date = new Date(),
): MessageRangeInput {
  const nextMinute = new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
  const to =
    instantToWallTimeInZone(nextMinute, timeZone) ??
    instantToWallTimeInZone(nextMinute, "UTC") ??
    "";
  const from =
    instantToWallTimeInZone(new Date(now.getTime() - DEFAULT_RANGE_DAYS * DAY_MS), timeZone) ??
    "";
  return { from, to };
}

/**
 * Validates the wall-time inputs and converts them to the instants the API
 * expects. Keeps the half-open semantics explicit: `from` inclusive, `to`
 * exclusive.
 */
export function resolveMessageRange(
  input: MessageRangeInput,
  timeZone: string,
): MessageRangeResult {
  if (input.from === "" || input.to === "") {
    return { range: null, error: "Choose a start and an end date." };
  }

  const from = wallTimeInZoneToInstant(input.from, timeZone);
  const to = wallTimeInZoneToInstant(input.to, timeZone);
  if (from === null || to === null) {
    return { range: null, error: "Enter a valid date and time." };
  }
  if (to.getTime() <= from.getTime()) {
    return {
      range: null,
      error: "The end of the range must be after the start.",
    };
  }

  return {
    range: { fromIso: from.toISOString(), toIso: to.toISOString() },
    error: null,
  };
}

/**
 * Appends an older page (the API returns newest first) and drops ids that are
 * already loaded, so "Load older" is idempotent even if the cursor repeats.
 */
export function mergeOlderMessages<T extends { id: string }>(
  current: readonly T[],
  older: readonly T[],
): T[] {
  const seen = new Set(current.map((message) => message.id));
  const merged = [...current];
  for (const message of older) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

export interface MessagePageLike<T> {
  /** Newest first, like the API page. */
  items: T[];
  /** Cursor for the next older page, or `null` when exhausted. */
  nextCursor: string | null;
}

export interface MessageLookupResult<T> {
  /** True when the message is in the first page or one of the fetched pages. */
  found: boolean;
  /** Older pages fetched while looking, in fetch order (newest first). */
  pages: MessagePageLike<T>[];
  /** Cursor for the next older page after the last fetched one. */
  nextCursor: string | null;
}

/**
 * Walks older pages until `messageId` appears, or `maxPages` fetches / the end
 * of the history is reached. Used by the run view to reveal a cited source
 * message that is not on the first page. The walk is bounded so a stale or
 * foreign message id cannot page through the whole chat history.
 */
export async function findMessageInOlderPages<T extends { id: string }>(
  firstPage: MessagePageLike<T>,
  messageId: string,
  fetchOlder: (cursor: string) => Promise<MessagePageLike<T>>,
  maxPages: number = MAX_FOCUS_PAGE_FETCHES,
): Promise<MessageLookupResult<T>> {
  if (firstPage.items.some((item) => item.id === messageId)) {
    return { found: true, pages: [], nextCursor: firstPage.nextCursor };
  }

  const pages: MessagePageLike<T>[] = [];
  let cursor = firstPage.nextCursor;
  let found = false;

  while (cursor !== null && pages.length < maxPages) {
    const page = await fetchOlder(cursor);
    pages.push(page);
    cursor = page.nextCursor;
    if (page.items.some((item) => item.id === messageId)) {
      found = true;
      break;
    }
  }

  return { found, pages, nextCursor: cursor };
}

export interface MessageDayGroup<T> {
  /** Day label, also used as the React key (unique per group). */
  heading: string;
  /** Messages of that day, in the caller's order. */
  messages: T[];
}

/**
 * Splits an oldest-first list into consecutive day groups. The chat view uses
 * this to render one sticky day heading per group: a heading nested inside a
 * single message `<li>` would only stick for that message's height.
 *
 * `heading` renders the label for an instant (time zone and date format are the
 * caller's concern); messages that render the same label share a group.
 */
export function groupMessagesByDay<T extends { sentAt: string }>(
  ordered: readonly T[],
  heading: (sentAt: string) => string,
): MessageDayGroup<T>[] {
  const groups: MessageDayGroup<T>[] = [];
  for (const message of ordered) {
    const label = heading(message.sentAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.heading === label) {
      last.messages.push(message);
      continue;
    }
    groups.push({ heading: label, messages: [message] });
  }
  return groups;
}

/** Display name for a message sender (`senderName` is PII from WhatsApp). */
export function senderLabel(message: ApiMessage): string {
  return message.senderName ?? message.senderId;
}
