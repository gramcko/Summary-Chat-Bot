"use client";

import type { ApiMessage, Interval } from "@summarly/contracts";
import { useEffect, useRef, useState } from "react";
import { MessageBubble } from "@/components/messages/MessageBubble";
import { useAppDateFormat } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { api, toApiError, type ApiError } from "@/lib/api";
import { MESSAGE_PAGE_SIZE, mergeOlderMessages } from "@/lib/group-messages";
import { formatDayHeading, formatInterval } from "@/lib/time";

/**
 * Messages in the run's half-open interval — the source set the
 * summary-worker read for this run. Newest first, with "load older".
 */
export function RunMessagesTab({
  groupId,
  interval,
}: {
  groupId: string;
  interval: Interval;
}) {
  const dateFormat = useAppDateFormat();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [olderError, setOlderError] = useState<ApiError | null>(null);
  const requestId = useRef(0);

  async function loadFirstPage(): Promise<void> {
    requestId.current += 1;
    const id = requestId.current;
    setLoading(true);
    setError(null);
    setOlderError(null);
    try {
      const page = await api.groupMessages(groupId, {
        from: interval.start,
        to: interval.end,
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

  useEffect(() => {
    void loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, interval.start, interval.end]);

  async function handleLoadOlder(): Promise<void> {
    if (nextCursor === null || loadingOlder) return;
    const id = requestId.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.groupMessages(groupId, {
        from: interval.start,
        to: interval.end,
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

  const ordered = [...messages].reverse();

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-slate-500">
        Messages captured in {formatInterval(interval, dateFormat)} (the summary&apos;s
        half-open period, {interval.timezone}). Times are shown in the group
        time zone.
      </p>

      {loading && messages.length === 0 ? (
        <SkeletonRows label="Loading source messages…" rows={5} />
      ) : null}

      {error === null ? null : (
        <ErrorState
          error={error}
          title="Could not load the source messages"
          onRetry={() => void loadFirstPage()}
        />
      )}

      {olderError === null ? null : (
        <Alert tone="error" title="Could not load older messages">
          {olderError.message}
        </Alert>
      )}

      {!loading && error === null && messages.length === 0 ? (
        <EmptyState
          title="No messages in this period"
          description="The summary's interval contains no captured messages."
        />
      ) : null}

      {ordered.length === 0 ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p aria-live="polite" className="text-xs text-slate-500">
              {messages.length} message{messages.length === 1 ? "" : "s"} loaded ·
              newest at the bottom
            </p>
            {nextCursor === null ? (
              <span className="text-xs text-slate-400">
                Oldest messages loaded
              </span>
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

          <ol aria-label="Messages used for the summary" className="space-y-4">
            {ordered.map((message, index) => {
              const previous = ordered[index - 1];
              const showDay =
                previous === undefined ||
                formatDayHeading(previous.sentAt, interval.timezone, dateFormat) !==
                  formatDayHeading(message.sentAt, interval.timezone, dateFormat);
              return (
                <li key={message.id}>
                  {showDay ? (
                    <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {formatDayHeading(message.sentAt, interval.timezone, dateFormat)}
                    </p>
                  ) : null}
                  <MessageBubble message={message} timeZone={interval.timezone} />
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
        </>
      )}
    </div>
  );
}
