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
import {
  MAX_FOCUS_PAGE_FETCHES,
  MESSAGE_PAGE_SIZE,
  findMessageInOlderPages,
  groupMessagesByDay,
  mergeOlderMessages,
} from "@/lib/group-messages";
import { formatDayHeading, formatInterval } from "@/lib/time";

/** How long a revealed source message stays highlighted. */
const FOCUS_HIGHLIGHT_MS = 4_000;

/**
 * Messages in the run's half-open interval — the source set the
 * summary-worker read for this run. Rendered oldest first (newest at the
 * bottom), with "load older".
 *
 * `focusMessageId` (from a summary source link) reveals one cited message: it
 * walks older pages until the message is loaded, scrolls it into view inside
 * the list, and highlights it briefly.
 */
export function RunMessagesTab({
  groupId,
  interval,
  focusMessageId = null,
}: {
  groupId: string;
  interval: Interval;
  /** Cited message to reveal (the run page's `?message=` param). */
  focusMessageId?: string | null;
}) {
  const dateFormat = useAppDateFormat();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [olderError, setOlderError] = useState<ApiError | null>(null);
  // Bumped after every successful first-page load, so the focus effect below
  // knows when `messages`/`nextCursor` are in sync with the current interval.
  const [pageVersion, setPageVersion] = useState(0);
  const [focusMissingId, setFocusMissingId] = useState<string | null>(null);
  const [focusError, setFocusError] = useState<ApiError | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [pendingRevealId, setPendingRevealId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const requestId = useRef(0);
  const focusRequestId = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef(new Map<string, HTMLLIElement>());
  const highlightTimer = useRef<number | null>(null);
  // After a first page renders, pin the view to the newest (bottom) message.
  const pinToBottom = useRef(true);
  // Scroll metrics captured before "Load older" prepends a page.
  const olderAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  );

  async function loadFirstPage(): Promise<void> {
    requestId.current += 1;
    const id = requestId.current;
    pinToBottom.current = true;
    olderAnchor.current = null;
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
      setPageVersion((version) => version + 1);
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
      const element = listRef.current;
      olderAnchor.current =
        element === null
          ? null
          : { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
      setMessages((current) => mergeOlderMessages(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId.current === id) setOlderError(toApiError(cause));
    } finally {
      setLoadingOlder(false);
    }
  }

  // The list is oldest-first, so the newest message is at the bottom: pin the
  // view there on the first page, and hold the reader's place when "Load older"
  // prepends a page (the anchor keeps the visible message under the cursor).
  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const anchor = olderAnchor.current;
    if (anchor !== null) {
      olderAnchor.current = null;
      element.scrollTop =
        element.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      return;
    }
    if (!pinToBottom.current) return;
    pinToBottom.current = false;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  // Reveal a cited source message. The first page has already been applied when
  // `pageVersion` changes, so `messages`/`nextCursor` are current here. If the
  // message is not loaded, walk older pages (bounded) until it is found or the
  // history/bound ends. A request id cancels the walk when the target or page
  // changes, and on unmount.
  useEffect(() => {
    const target = focusMessageId ?? null;
    if (target === null) {
      focusRequestId.current += 1;
      setFocusMissingId(null);
      setFocusError(null);
      setFocusLoading(false);
      setPendingRevealId(null);
      return;
    }
    if (loading || error !== null) return;

    if (messages.some((message) => message.id === target)) {
      focusRequestId.current += 1;
      setFocusMissingId(null);
      setFocusError(null);
      setFocusLoading(false);
      setPendingRevealId(target);
      return;
    }

    if (nextCursor === null) {
      setFocusMissingId(target);
      setFocusError(null);
      setFocusLoading(false);
      return;
    }

    const request = focusRequestId.current + 1;
    focusRequestId.current = request;
    setFocusMissingId(null);
    setFocusError(null);
    setFocusLoading(true);

    void (async () => {
      try {
        const result = await findMessageInOlderPages(
          { items: messages, nextCursor },
          target,
          (cursor) =>
            api.groupMessages(groupId, {
              from: interval.start,
              to: interval.end,
              cursor,
              limit: MESSAGE_PAGE_SIZE,
            }),
          MAX_FOCUS_PAGE_FETCHES,
        );
        if (focusRequestId.current !== request) return;
        if (result.pages.length > 0) {
          setMessages((current) =>
            result.pages.reduce(
              (accumulated, page) => mergeOlderMessages(accumulated, page.items),
              current,
            ),
          );
          setNextCursor(result.nextCursor);
        }
        if (result.found) {
          setPendingRevealId(target);
        } else {
          setFocusMissingId(target);
        }
      } catch (cause) {
        if (focusRequestId.current !== request) return;
        setFocusError(toApiError(cause));
      } finally {
        if (focusRequestId.current === request) setFocusLoading(false);
      }
    })();

    return () => {
      focusRequestId.current += 1;
    };
    // `messages`/`nextCursor` are deliberately omitted: the walk starts once per
    // first page (`pageVersion`) or focus target, never on its own page merges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focusMessageId,
    pageVersion,
    groupId,
    interval.start,
    interval.end,
    loading,
    error,
  ]);

  // Scroll the revealed message to the middle of the list and highlight it.
  // Runs after the message list has rendered the target.
  useEffect(() => {
    if (pendingRevealId === null) return;
    if (!messages.some((message) => message.id === pendingRevealId)) return;

    const element = messageRefs.current.get(pendingRevealId);
    const container = listRef.current;
    if (element !== undefined && container !== null) {
      // Measure against the scroll container's viewport, not `offsetTop`
      // (which is relative to the nearest positioned ancestor).
      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      container.scrollTop = Math.max(
        0,
        container.scrollTop +
          elementRect.top -
          containerRect.top -
          container.clientHeight / 2 +
          elementRect.height / 2,
      );
    }

    setHighlightedId(pendingRevealId);
    setPendingRevealId(null);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => {
      highlightTimer.current = null;
      setHighlightedId(null);
    }, FOCUS_HIGHLIGHT_MS);
  }, [pendingRevealId, messages]);

  // Never leave a highlight timer running after the tab unmounts.
  useEffect(() => {
    return () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
      }
    };
  }, []);

  const ordered = [...messages].reverse();
  const dayGroups = groupMessagesByDay(ordered, (sentAt) =>
    formatDayHeading(sentAt, interval.timezone, dateFormat),
  );

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

      {focusLoading ? (
        <p role="status" className="text-xs text-slate-500">
          Loading older messages to find the cited message…
        </p>
      ) : null}

      {focusMissingId === null ? null : (
        <Alert tone="warning" title="Cited message not found">
          The cited message is not among the loaded source messages. It may fall
          outside this run&apos;s period, or it may have been removed.
        </Alert>
      )}

      {focusError === null ? null : (
        <Alert tone="error" title="Could not load the cited message">
          {focusError.message}
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

          <div
            ref={listRef}
            role="region"
            aria-label="Summary source message history"
            tabIndex={0}
            className="relative max-h-[60vh] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-slate-50/60 p-4 pr-2"
          >
            <div className="space-y-4">
              {dayGroups.map((group) => (
                <div key={group.heading}>
                  <p className="sticky top-0 z-10 mb-3 bg-slate-50 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
                    {group.heading}
                  </p>
                  <ol className="space-y-4">
                    {group.messages.map((message) => (
                      <li
                        key={message.id}
                        ref={(element) => {
                          if (element === null) {
                            messageRefs.current.delete(message.id);
                          } else {
                            messageRefs.current.set(message.id, element);
                          }
                        }}
                        data-message-id={message.id}
                        className={`rounded-xl transition-shadow ${
                          message.id === highlightedId
                            ? "bg-amber-50/70 ring-2 ring-amber-400 ring-offset-2 ring-offset-slate-50"
                            : ""
                        }`}
                      >
                        <MessageBubble
                          message={message}
                          timeZone={interval.timezone}
                        />
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>

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
