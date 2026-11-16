"use client";

import type { GroupMember } from "@summarly/contracts";
import { useEffect, useState } from "react";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { api, toApiError } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { formatDateTime } from "@/lib/time";

/** How often the roster is re-fetched while a refresh request is in flight. */
const ROSTER_REFRESH_POLL_MS = 2_000;
/**
 * Upper bound for the polling window: the bot worker may be disconnected or
 * WhatsApp may not answer, and the tab must not poll forever.
 */
const ROSTER_REFRESH_WINDOW_MS = 15_000;

function formatPhone(phone: string | null): string | null {
  if (phone === null) return null;
  // `phone` is the PN JID (`123@s.whatsapp.net`); show the digits only.
  const digits = phone.split("@")[0]?.split(":")[0] ?? "";
  return digits === "" ? phone : `+${digits}`;
}

function displayName(member: GroupMember): string {
  return member.name ?? formatPhone(member.phone) ?? "Unknown member";
}

function initials(member: GroupMember): string {
  // No name means no meaningful initials — never derive them from the
  // opaque LID/phone identifier.
  const source = member.name ?? "";
  if (source === "") return "?";
  const parts = source.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join("");
  return letters.length === 0 ? "?" : letters.toUpperCase();
}

/**
 * Best-effort roster snapshot (ADR 0008). WhatsApp does not replay membership
 * history, so this is what the bot worker has observed; members who left are
 * kept and marked instead of disappearing.
 */
export function MembersTab({ groupId }: { groupId: string }) {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const members = useResource(() => api.groupMembers(groupId), [groupId]);
  const { data, error, loading, reload } = members;

  /** `POST /groups/:id/roster-sync` is in flight. */
  const [requesting, setRequesting] = useState(false);
  /** The poll window that follows a successful request. */
  const [polling, setPolling] = useState(false);
  /** Whether the roster was empty when the refresh was requested. */
  const [awaitingFirstRoster, setAwaitingFirstRoster] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  // The sync itself runs in the bot worker, so the tab observes the result:
  // re-fetch every couple of seconds until the window closes.
  useEffect(() => {
    if (!polling) return;
    const deadline = Date.now() + ROSTER_REFRESH_WINDOW_MS;
    const interval = window.setInterval(() => {
      reload();
      if (Date.now() >= deadline) setPolling(false);
    }, ROSTER_REFRESH_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reload]);

  // An empty roster fills in as soon as the sync lands — stop early then.
  useEffect(() => {
    if (!polling || !awaitingFirstRoster) return;
    if (data !== null && data.length > 0) {
      setPolling(false);
      setFeedback("Roster updated.");
    }
  }, [polling, awaitingFirstRoster, data]);

  async function refreshMembers(): Promise<void> {
    if (requesting || polling) return;
    setRequesting(true);
    setRequestError(null);
    setFeedback(null);
    setAwaitingFirstRoster((data ?? []).length === 0);
    try {
      await api.requestRosterSync(groupId);
      setFeedback("Roster refresh requested. It can take a few seconds.");
      setPolling(true);
    } catch (cause) {
      const failure = toApiError(cause);
      setRequestError(
        failure.code === "conflict"
          ? "This group is not monitored, so its roster cannot be refreshed. Turn monitoring on in the Settings tab."
          : failure.message,
      );
    } finally {
      setRequesting(false);
    }
  }

  if (loading && data === null) {
    return <SkeletonRows label="Loading members…" rows={4} />;
  }

  if (error !== null) {
    // 409: the API serves member rosters only for monitored groups.
    if (error.code === "conflict") {
      return (
        <EmptyState
          title="Turn monitoring on to see members"
          description="The member roster is only served for monitored groups. Enable monitoring in the Settings tab, then open this tab again."
        />
      );
    }
    return (
      <ErrorState
        error={error}
        title="Could not load the member list"
        onRetry={reload}
      />
    );
  }

  if (data === null) return null;

  const active = data.filter((member) => member.active);
  const left = data.length - active.length;

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      loading={requesting || polling}
      onClick={() => void refreshMembers()}
      className="shrink-0"
    >
      Refresh members
    </Button>
  );

  const refreshFeedback = (
    <>
      {feedback === null ? null : <Alert tone="success">{feedback}</Alert>}
      {requestError === null ? null : (
        <Alert tone="error" title="Could not refresh the member list">
          {requestError}
        </Alert>
      )}
    </>
  );

  if (data.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          title="No members captured yet"
          description="The bot worker records the group roster from WhatsApp. Use “Refresh members” to ask it for the current roster; it appears here once the sync completes. WhatsApp does not replay membership history."
          action={refreshButton}
        />
        {refreshFeedback}
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return displayName(a).localeCompare(displayName(b));
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-xs text-slate-500">
          {active.length} active · {left} left the group. Names come from the
          WhatsApp contacts and message push names observed by the bot worker;
          members without a known name show their phone number when available.
        </p>
        {refreshButton}
      </div>
      {refreshFeedback}
      <Card>
        <ul className="divide-y divide-slate-100">
          {sorted.map((member) => (
            <li
              key={member.userId}
              className={`flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 ${
                member.active ? "" : "opacity-60"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600"
              >
                {initials(member)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {displayName(member)}
                  </p>
                  {member.isAdmin ? <Badge tone="info">Admin</Badge> : null}
                  {member.active ? null : <Badge tone="neutral">Left</Badge>}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  <span className="text-slate-400">ID </span>
                  <span className="font-mono">{member.userId}</span>
                  {" · updated "}
                  <time dateTime={member.updatedAt}>
                    {formatDateTime(member.updatedAt, timeZone, dateFormat)}
                  </time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
