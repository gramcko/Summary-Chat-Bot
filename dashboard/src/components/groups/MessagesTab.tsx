"use client";

import type { ApiMessage } from "@summarly/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDateFormat } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { MessageBubble } from "@/components/messages/MessageBubble";
import { api, toApiError, type ApiError } from "@/lib/api";
import {
  MESSAGE_PAGE_SIZE,
  defaultMessageRange,
  mergeOlderMessages,
  resolveMessageRange,
  type MessageRangeInput,
} from "@/lib/group-messages";
import { formatDayHeading } from "@/lib/time";

interface AppliedRange {
  fromIso: string;
  toIso: string;
}

/**
 * Read-only chat view of the group's captured messages with a half-open date
 * filter and cursor pagination ("Load older"). Times are shown in the admin's
 * local time zone; the filter is interpreted in the group's time zone.
 */
export function MessagesTab({
  groupId,
  timeZone,
}: {
  groupId: string;
  timeZone: string;
}) {
  const dateFormat = useAppDateFormat();
  const [initialRange] = useState<MessageRangeInput>(() =>
    defaultMessageRange(timeZone),
  );
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedRange | null>(null);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [olderError, setOlderError] = useState<ApiError | null>(null);
  const requestId = useRef(0);

  async function loadFirstPage(range: AppliedRange): Promise<void> {
    requestId.current += 1;
    const id = requestId.current;
    setLoading(true);
    setError(null);
    setOlderError(null);
    try {
      const page = await api.groupMessages(groupId, {
        ...range,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (requestId.current !== id) return;
      setMessages(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId.current !== id) return;
      setError(toApiError(cause));
      setMessages([]);
      setNextCursor(null);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }

  // First page for the default range; later loads come from the filter form.
  useEffect(() => {
    const resolved = resolveMessageRange(initialRange, timeZone);
    if (resolved.range === null) {
      setRangeError(resolved.error);
      setLoading(false);
      return;
    }
    setApplied(resolved.range);
    void loadFirstPage(resolved.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  function handleApply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const resolved = resolveMessageRange({ from, to }, timeZone);
    if (resolved.range === null) {
      setRangeError(resolved.error);
      return;
    }
    setRangeError(null);
    setApplied(resolved.range);
    void loadFirstPage(resolved.range);
  }

  function handleReset(): void {
    const range = defaultMessageRange(timeZone);
    setFrom(range.from);
    setTo(range.to);
    const resolved = resolveMessageRange(range, timeZone);
    if (resolved.range === null) {
      setRangeError(resolved.error);
      return;
    }
    setRangeError(null);
    setApplied(resolved.range);
    void loadFirstPage(resolved.range);
  }

  async function handleLoadOlder(): Promise<void> {
    if (applied === null || nextCursor === null || loadingOlder) return;
    const id = requestId.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.groupMessages(groupId, {
        ...applied,
        cursor: nextCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (requestId.current !== id) return;
      setMessages((current) => mergeOlderMessages(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId.current === id) setOlderError(toApiError(cause));
    } finally {
      setLoadingOlder(false);
    }
  }

  // The API returns newest first; a chat reads oldest first.
  const ordered = [...messages].reverse();
  const count = messages.length;

  return (
    <div className="space-y-4">
      <form
        noValidate
        onSubmit={handleApply}
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            id="messages-from"
            label="From (inclusive)"
            type="datetime-local"
            value={from}
            onChange={setFrom}
            required
            disabled={loading}
          />
          <TextField
            id="messages-to"
            label="To (exclusive)"
            type="datetime-local"
            value={to}
            onChange={setTo}
            required
            disabled={loading}
          />
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Times are interpreted in <strong>{timeZone}</strong>. The range is
          half-open: it includes the start instant and excludes the end instant,
          so adjacent ranges never overlap.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={loading}>
            Apply range
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleReset}
            disabled={loading}
          >
            Last 7 days
          </Button>
        </div>
      </form>

      {rangeError === null ? null : (
        <Alert tone="error" title="Check the date range">
          {rangeError}
        </Alert>
      )}

      {loading && messages.length === 0 ? (
        <SkeletonRows label="Loading messages…" rows={5} />
      ) : null}

      {error === null ? null : (
        <ErrorState
          error={error}
          title="Could not load messages"
          onRetry={applied === null ? undefined : () => void loadFirstPage(applied)}
        />
      )}

      {error === null && !loading && messages.length === 0 ? (
        <EmptyState
          title="No messages in this range"
          description={
            rangeError === null
              ? "Nothing was captured between these instants. Try widening the range, or check the Connection screen if WhatsApp is not linked."
              : undefined
          }
          action={
            <Button variant="secondary" size="sm" onClick={handleReset}>
              Reset to the last 7 days
            </Button>
          }
        />
      ) : null}

      {messages.length === 0 ? null : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p aria-live="polite" className="text-xs text-slate-500">
              {count} message{count === 1 ? "" : "s"} loaded · newest at the
              bottom
            </p>
            {nextCursor === null ? (
              <span className="text-xs text-slate-400">Oldest messages loaded</span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={loadingOlder}
                onClick={() => void handleLoadOlder()}
              >
                Load older
              </Button>
            )}
          </div>

          {olderError === null ? null : (
            <Alert tone="error" title="Could not load older messages">
              {olderError.message}
            </Alert>
          )}

          <ol aria-label="Messages" className="space-y-4">
            {ordered.map((message, index) => {
              const previous = ordered[index - 1];
              const showDay =
                previous === undefined ||
                formatDayHeading(previous.sentAt, timeZone, dateFormat) !==
                  formatDayHeading(message.sentAt, timeZone, dateFormat);
              return (
                <li key={message.id}>
                  {showDay ? (
                    <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {formatDayHeading(message.sentAt, timeZone, dateFormat)}
                    </p>
                  ) : null}
                  <MessageBubble message={message} timeZone={timeZone} />
                </li>
              );
            })}
          </ol>

          {nextCursor === null ? null : (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={loadingOlder}
                onClick={() => void handleLoadOlder()}
              >
                Load older messages
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
