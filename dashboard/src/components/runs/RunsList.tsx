"use client";

import type { Group, SummaryRun } from "@summarly/contracts";
import Link from "next/link";
import { useState } from "react";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge, RunStatusBadge } from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { api, toApiError, type ApiError } from "@/lib/api";
import { groupName, pluralize } from "@/lib/format";
import { formatDateTime, formatInterval } from "@/lib/time";

interface RunRowProps {
  run: SummaryRun;
  groups: readonly Group[];
  onUpdated: (run: SummaryRun) => void;
}

function RunRow({ run, groups, onUpdated }: RunRowProps) {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<ApiError | null>(null);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    setRetryError(null);
    try {
      const updated = await api.retryRun(run.id);
      onUpdated(updated);
    } catch (cause) {
      setRetryError(toApiError(cause));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/runs/${run.id}`}
            className="text-sm font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
          >
            {groupName(groups, run.groupId)}
          </Link>
          <RunStatusBadge status={run.status} />
          <span className="text-xs text-slate-500">
            {run.kind === "manual" ? "Manual" : "Scheduled"}
          </span>
          {run.instructions === null ? null : (
            <Badge tone="neutral">Custom instructions</Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-600">
          {formatInterval(run.interval, dateFormat)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Requested {formatDateTime(run.createdAt, timeZone, dateFormat)} · {run.attempts}{" "}
          {pluralize(run.attempts, "attempt")}
        </p>
        {run.error === null ? null : (
          <p className="mt-1 text-xs text-red-700">
            <span className="font-mono">{run.error.code}</span> — {run.error.message}
          </p>
        )}
        {retryError === null ? null : (
          <div className="mt-2">
            <Alert
              tone="error"
              title={
                retryError.code === "conflict"
                  ? "Cannot retry this run"
                  : "Retry failed"
              }
            >
              {retryError.message}
            </Alert>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <ButtonLink href={`/runs/${run.id}`} variant="secondary" size="sm">
          Details
        </ButtonLink>
        {run.status === "failed" ? (
          <Button
            size="sm"
            loading={retrying}
            onClick={() => void handleRetry()}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </li>
  );
}

interface RunsListProps {
  runs: readonly SummaryRun[];
  groups: readonly Group[];
  onUpdated: (run: SummaryRun) => void;
}

export function RunsList({ runs, groups, onUpdated }: RunsListProps) {
  return (
    <Card>
      <CardHeader
        title="Run history"
        description="Newest first. Pending and processing runs update as workers pick them up."
      />
      {runs.length === 0 ? (
        <div className="px-4 py-4 sm:px-5">
          <EmptyState
            title="No summary runs yet"
            description="Request a summary above to create the first run."
          />
        </div>
      ) : (
        <ul className="divide-y divide-slate-200">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} groups={groups} onUpdated={onUpdated} />
          ))}
        </ul>
      )}
    </Card>
  );
}
