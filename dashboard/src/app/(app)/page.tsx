"use client";

import type { ConnectionStatus, Group, SummaryRun } from "@summarly/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import {
  Badge,
  ConnectionBadge,
  RunStatusBadge,
  connectionHint,
} from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { isLinkingExpired } from "@/lib/connection";
import { groupName } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { formatDateTime, formatInterval } from "@/lib/time";

interface OverviewData {
  connection: ConnectionStatus;
  groups: Group[];
  runs: SummaryRun[];
}

const RECENT_RUN_COUNT = 5;
const GROUP_PREVIEW_COUNT = 4;

async function loadOverview(): Promise<OverviewData> {
  const [connection, groups, runs] = await Promise.all([
    api.connection(),
    api.groups(),
    api.runs(),
  ]);
  return {
    connection,
    groups,
    runs: runs.items.slice(0, RECENT_RUN_COUNT),
  };
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export default function OverviewPage() {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const overview = useResource(loadOverview, []);
  const { data, error, loading, reload } = overview;

  const monitoredCount = data?.groups.filter((group) => group.monitored).length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Connection health, recent summary runs, and a shortcut into each monitored group."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
              Refresh
            </Button>
            <ButtonLink href="/runs" size="sm">
              Request a summary
            </ButtonLink>
          </>
        }
      />

      {loading && data === null ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <SkeletonCard label="Loading connection status…" />
            <SkeletonCard label="Loading recent runs…" />
          </div>
          <SkeletonCard label="Loading groups…" />
        </div>
      ) : null}

      {error === null ? null : (
        <ErrorState
          error={error}
          title="Could not load the overview"
          onRetry={reload}
        />
      )}

      {data === null ? null : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader
                title="WhatsApp connection"
                description={connectionHint(data.connection.state)}
                actions={<ConnectionBadge state={data.connection.state} />}
              />
              <CardBody>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Detail label="State since">
                    <time dateTime={data.connection.since}>
                      {formatDateTime(data.connection.since, timeZone, dateFormat)}
                    </time>
                  </Detail>
                  <Detail label="Last captured message">
                    {data.connection.lastMessageAt === null ? (
                      <span className="text-slate-500">No messages captured yet.</span>
                    ) : (
                      <time dateTime={data.connection.lastMessageAt}>
                        {formatDateTime(data.connection.lastMessageAt, timeZone, dateFormat)}
                      </time>
                    )}
                  </Detail>
                </dl>
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <ButtonLink href="/connection" variant="secondary" size="sm">
                    Open connection
                  </ButtonLink>
                </div>
              </CardBody>
            </Card>

            {data.connection.linking === null ||
            isLinkingExpired(data.connection.linking) ? null : (
              <Alert tone="info" title="WhatsApp is waiting to be linked">
                The bot worker published a QR code or pairing code.{" "}
                <Link href="/connection" className="font-medium underline">
                  Open the connection screen
                </Link>{" "}
                to scan it or enter the code.
              </Alert>
            )}

            <Card>
              <CardHeader
                title="Recent summary runs"
                description="Newest first. Open a run for its status and summary."
                actions={
                  <ButtonLink href="/runs" variant="secondary" size="sm">
                    View all runs
                  </ButtonLink>
                }
              />
              {data.runs.length === 0 ? (
                <div className="px-5 py-4">
                  <EmptyState
                    title="No summary runs yet"
                    description="Request a summary for a group and time period, or wait for the daily schedule."
                    action={
                      <ButtonLink href="/runs" variant="secondary" size="sm">
                        Request a summary
                      </ButtonLink>
                    }
                  />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/runs/${run.id}`}
                        className="flex flex-col gap-2 px-5 py-3 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {groupName(data.groups, run.groupId)}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-600">
                            {formatInterval(run.interval, dateFormat)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-3">
                          <span className="text-xs text-slate-500">
                            {formatDateTime(run.createdAt, timeZone, dateFormat)}
                          </span>
                          <RunStatusBadge status={run.status} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <aside className="space-y-6" aria-label="Shortcuts">
            <Card>
              <CardHeader title="Groups" description={`${monitoredCount} monitored`} />
              {data.groups.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-slate-600">
                    No groups captured yet. Link WhatsApp to start.
                  </p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.groups.slice(0, GROUP_PREVIEW_COUNT).map((group) => (
                    <li key={group.id}>
                      <Link
                        href={`/groups/${group.id}`}
                        className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm transition-colors hover:bg-slate-50"
                      >
                        <span className="truncate text-slate-800">{group.name}</span>
                        <Badge tone={group.monitored ? "success" : "neutral"} dot>
                          {group.monitored ? "On" : "Off"}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-slate-100 px-5 py-3">
                <ButtonLink href="/groups" variant="secondary" size="sm">
                  All groups
                </ButtonLink>
              </div>
            </Card>

            <Card>
              <CardHeader title="Quick actions" />
              <ul className="divide-y divide-slate-100">
                {[
                  { href: "/runs", label: "Request a summary" },
                  { href: "/groups", label: "Browse groups" },
                  { href: "/connection", label: "Manage the connection" },
                  { href: "/settings", label: "AI provider settings" },
                ].map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm text-slate-800 transition-colors hover:bg-slate-50"
                    >
                      {item.label}
                      <span aria-hidden="true" className="text-slate-400">
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}
