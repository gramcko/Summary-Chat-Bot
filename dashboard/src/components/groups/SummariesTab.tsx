"use client";

import { useAppTimeZone } from "@/components/TimeZoneProvider";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { formatDateTime, formatInterval } from "@/lib/time";

/**
 * Past summaries of the group (newest first), each linking to the run that
 * produced it. The list shows a short overview excerpt only; the full summary
 * (and the AI-generated notice) is on the run detail page.
 */
export function SummariesTab({ groupId }: { groupId: string }) {
  const timeZone = useAppTimeZone();
  const summaries = useResource(() => api.groupSummaries(groupId), [groupId]);
  const { data, error, loading, reload } = summaries;

  if (loading && data === null) {
    return (
      <div className="space-y-3">
        <SkeletonCard label="Loading summaries…" />
        <SkeletonCard label="Loading summaries…" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <ErrorState
        error={error}
        title="Could not load the group's summaries"
        onRetry={reload}
      />
    );
  }

  if (data === null) return null;

  if (data.length === 0) {
    return (
      <EmptyState
        title="No summaries yet"
        description="Completed summary runs for this group appear here. Request one for a group and period, or wait for the daily schedule."
        action={
          <ButtonLink href={`/runs?group=${encodeURIComponent(groupId)}`}>
            Request a summary
          </ButtonLink>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        AI-generated summaries — verify consequential items against the source
        messages before acting on them.
      </p>
      <ul className="space-y-3">
        {data.map((summary) => (
          <li
            key={summary.id}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  {formatInterval(summary.interval)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {summary.provider} · {summary.model} · generated{" "}
                  {formatDateTime(summary.createdAt, timeZone)}
                </p>
              </div>
              <ButtonLink
                href={`/runs/${summary.runId}`}
                variant="secondary"
                size="sm"
              >
                View run
              </ButtonLink>
            </div>
            <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-700">
              {summary.result.overview}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
