"use client";

import type { RunStatus } from "@summarly/contracts";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { SummaryView } from "@/components/SummaryView";
import { RunMessagesTab } from "@/components/runs/RunMessagesTab";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { RunStatusBadge, runStatusHint } from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/States";
import { Tabs, type TabDefinition } from "@/components/ui/Tabs";
import { api, toApiError, type ApiError } from "@/lib/api";
import { isRunInProgress, shortId } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { formatDateTime, formatInterval } from "@/lib/time";

const POLL_MS = 5_000;

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-slate-900">{children}</dd>
    </div>
  );
}

const EMPTY_SUMMARY_COPY: Record<RunStatus, string> = {
  pending:
    "This run is queued. The summary appears here once a summary worker processes it; the page refreshes automatically.",
  processing:
    "The summary is being generated. The page refreshes automatically; this can take a while for long conversations.",
  completed: "The run is marked completed, but no summary was found.",
  failed:
    "This run failed, so no summary was produced. Retry the run to try again.",
};

const RUN_TABS: readonly TabDefinition[] = [
  { id: "summary", label: "Summary" },
  { id: "messages", label: "Messages used" },
];

export function RunDetailView({ runId }: { runId: string }) {
  const [tab, setTab] = useState<string>("summary");
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const run = useResource(() => api.run(runId), [runId]);
  const groups = useResource(() => api.groups(), []);
  const current = run.data;
  const latestMessage = useResource(
    () =>
      current === null
        ? Promise.resolve(null)
        : api.groupMessages(current.groupId, { limit: 1 }),
    [current?.groupId],
  );
  const lastMessageAt = latestMessage.data?.items[0]?.sentAt ?? null;
  const summary = useResource(
    () =>
      current?.status === "completed"
        ? api.runSummary(runId)
        : Promise.resolve(null),
    [runId, current?.status],
  );
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<ApiError | null>(null);

  const polling = isRunInProgress(current);
  const reloadRun = run.reload;

  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reloadRun, POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reloadRun]);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    setRetryFailure(null);
    try {
      const updated = await api.retryRun(runId);
      run.setData(updated);
    } catch (cause) {
      setRetryFailure(toApiError(cause));
    } finally {
      setRetrying(false);
    }
  }

  if (current === null) {
    if (run.error !== null) {
      if (run.error.code === "not_found") {
        return (
          <div className="space-y-6">
            <PageHeader title="Summary run" />
            <EmptyState
              title="Summary run not found"
              description="This run does not exist. It may have been removed, or the link is incorrect."
              action={
                <ButtonLink href="/runs" variant="secondary">
                  Back to summary runs
                </ButtonLink>
              }
            />
          </div>
        );
      }
      return (
        <div className="space-y-6">
          <PageHeader title="Summary run" />
          <ErrorState
            error={run.error}
            title="Could not load this run"
            onRetry={run.reload}
          />
        </div>
      );
    }
    return <LoadingBlock label="Loading run…" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Summary run ${shortId(current.id)}`}
        description={
          <>
            Requested {formatDateTime(current.createdAt, timeZone, dateFormat)} ·{" "}
            {current.kind === "manual" ? "manual request" : "scheduled"}{" "}
            {polling ? "· refreshing automatically" : null}
          </>
        }
        actions={
          <>
            <RunStatusBadge status={current.status} />
            <ButtonLink href="/runs" variant="secondary" size="sm">
              All runs
            </ButtonLink>
          </>
        }
      />

      <Card>
        <CardHeader
          title="Run details"
          description={runStatusHint(current.status)}
          actions={
            current.status === "failed" ? (
              <Button
                size="sm"
                loading={retrying}
                onClick={() => void handleRetry()}
              >
                Retry run
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DetailItem label="Group">
              <Link
                href={`/groups/${current.groupId}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {groups.data?.find((group) => group.id === current.groupId)?.name ??
                  current.groupId}
              </Link>
            </DetailItem>
            <DetailItem label="Kind">
              {current.kind === "manual" ? "Manual request" : "Scheduled"}
            </DetailItem>
            <DetailItem label="Interval">
              {formatInterval(current.interval, dateFormat)}
            </DetailItem>
            <DetailItem label="Interval time zone">
              {current.interval.timezone}
            </DetailItem>
            <DetailItem label="Attempts">{current.attempts}</DetailItem>
            <DetailItem label="Run updated">
              <time dateTime={current.updatedAt}>
                {formatDateTime(current.updatedAt, timeZone, dateFormat)}
              </time>
            </DetailItem>
            <DetailItem label="Group messages updated">
              {lastMessageAt === null ? (
                <span className="text-slate-500">No messages captured yet.</span>
              ) : (
                <time dateTime={lastMessageAt}>
                  {formatDateTime(lastMessageAt, timeZone, dateFormat)}
                </time>
              )}
            </DetailItem>
          </dl>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            “Run updated” is when this run record last changed (status,
            attempts, or error). “Group messages updated” is the newest
            captured message in the group.
          </p>
        </CardBody>
      </Card>

      {current.error === null ? null : (
        <Alert tone="error" title="The run failed">
          <p>
            <span className="font-mono text-xs">{current.error.code}</span> —{" "}
            {current.error.message}
          </p>
        </Alert>
      )}

      {current.instructions === null ? null : (
        <Card>
          <CardHeader
            title="Custom instructions"
            description="Requested for this run and passed to the AI provider as instructions, never merged into the conversation content."
          />
          <CardBody>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
              {current.instructions}
            </p>
          </CardBody>
        </Card>
      )}

      {retryFailure === null ? null : (
        <Alert
          tone="error"
          title={
            retryFailure.code === "conflict"
              ? "Cannot retry this run"
              : "Retry failed"
          }
        >
          {retryFailure.message}
        </Alert>
      )}

      <Tabs tabs={RUN_TABS} activeId={tab} onChange={setTab} label="Run sections">
        {tab === "summary" ? (
          <div className="space-y-4">
            {summary.loading ? (
              <span role="status" className="text-xs text-slate-500">
                Refreshing summary…
              </span>
            ) : null}

            {summary.error === null ? null : (
              <ErrorState
                error={summary.error}
                title="Could not load the summary"
                onRetry={summary.reload}
              />
            )}

            {summary.data === null ? (
              summary.error === null && !summary.loading ? (
                <EmptyState
                  title="Summary not generated yet"
                  description={EMPTY_SUMMARY_COPY[current.status]}
                />
              ) : null
            ) : (
              <SummaryView
                summary={summary.data}
                timeZone={current.interval.timezone}
                dateFormat={dateFormat}
              />
            )}
          </div>
        ) : null}
        {tab === "messages" ? (
          <RunMessagesTab
            groupId={current.groupId}
            interval={current.interval}
          />
        ) : null}
      </Tabs>
    </div>
  );
}
