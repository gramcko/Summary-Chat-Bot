"use client";

import type { Group } from "@summarly/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { GroupSettingsCard } from "./GroupSettingsCard";
import { MembersTab } from "./MembersTab";
import { MessagesTab } from "./MessagesTab";
import { SummariesTab } from "./SummariesTab";
import { IanaTimeZoneOptions } from "@/components/TimeZones";
import { Badge } from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tabs, type TabDefinition } from "@/components/ui/Tabs";
import { api } from "@/lib/api";
import {
  HISTORY_IMPORT_POLL_MS,
  summarizeHistoryImport,
} from "@/lib/history-import";
import { useResource } from "@/lib/hooks";

const TAB_ITEMS: readonly TabDefinition[] = [
  { id: "summaries", label: "Summaries" },
  { id: "members", label: "Members" },
  { id: "messages", label: "Messages" },
  { id: "settings", label: "Settings" },
];

/** Group detail: summaries, members, chat history, and monitoring settings. */
export function GroupDetailView({ groupId }: { groupId: string }) {
  const group = useResource(() => api.group(groupId), [groupId]);
  const [tab, setTab] = useState<string>("summaries");
  const current = group.data;
  const importSummary =
    current === null ? null : summarizeHistoryImport(current.historyImport);

  // Keep the import banner and the Settings card live while the bot-worker is
  // importing (same behavior as the groups list). Polling stops as soon as the
  // import reports done/failed, so an idle page makes no extra requests.
  const polling = importSummary?.inFlight === true;
  const reload = group.reload;
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reload, HISTORY_IMPORT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reload]);

  function handleSaved(updated: Group): void {
    group.setData(updated);
  }

  return (
    <div className="space-y-6">
      <Link
        href="/groups"
        className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-slate-500 hover:text-slate-900"
      >
        <span aria-hidden="true">←</span> All groups
      </Link>

      {current === null ? (
        group.error !== null ? (
          group.error.code === "not_found" ? (
            <EmptyState
              title="Group not found"
              description="This group does not exist. It may have been removed, or the link is incorrect."
              action={
                <ButtonLink href="/groups" variant="secondary">
                  Back to groups
                </ButtonLink>
              }
            />
          ) : (
            <ErrorState
              error={group.error}
              title="Could not load this group"
              onRetry={group.reload}
            />
          )
        ) : (
          <SkeletonCard label="Loading group…" />
        )
      ) : (
        <>
          <PageHeader
            title={current.name}
            description={
              <>
                {current.monitored ? "Monitored" : "Not monitored"} ·{" "}
                {current.timezone} ·{" "}
                {current.summaryTime === null
                  ? "no daily cutoff"
                  : `daily cutoff ${current.summaryTime}`}
                {current.chatId === null ? " · chat not linked yet" : ""}
              </>
            }
            actions={
              <>
                <Badge tone={current.monitored ? "success" : "neutral"} dot>
                  {current.monitored ? "Monitored" : "Not monitored"}
                </Badge>
                <ButtonLink
                  href={`/runs?group=${encodeURIComponent(current.id)}`}
                  size="sm"
                  variant="secondary"
                >
                  Request a summary
                </ButtonLink>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={group.reload}
                  disabled={group.loading}
                >
                  Refresh
                </Button>
              </>
            }
          />

          {importSummary === null ? null : (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <Badge
                  tone={
                    importSummary.inFlight
                      ? "info"
                      : importSummary.status === "failed"
                        ? "danger"
                        : "success"
                  }
                  dot
                >
                  {importSummary.badgeLabel}
                </Badge>
                <span>{importSummary.message}</span>
              </div>
              {importSummary.hint === null ? null : (
                <p className="text-xs font-medium text-amber-700">
                  {importSummary.hint}
                </p>
              )}
            </div>
          )}

          {/* Shared IANA suggestions for the Settings tab's time zone field. */}
          <IanaTimeZoneOptions />

          <Tabs
            tabs={TAB_ITEMS}
            activeId={tab}
            onChange={setTab}
            label="Group sections"
          >
            {tab === "summaries" ? <SummariesTab groupId={current.id} /> : null}
            {tab === "members" ? <MembersTab groupId={current.id} /> : null}
            {tab === "messages" ? (
              <MessagesTab groupId={current.id} timeZone={current.timezone} />
            ) : null}
            {tab === "settings" ? (
              <GroupSettingsCard
                group={current}
                onSaved={handleSaved}
                showHeader={false}
              />
            ) : null}
          </Tabs>
        </>
      )}
    </div>
  );
}
