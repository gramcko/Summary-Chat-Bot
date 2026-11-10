"use client";

import type { SummaryRun } from "@summarly/contracts";
import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { RequestRunForm } from "@/components/runs/RequestRunForm";
import { RunsList } from "@/components/runs/RunsList";

export default function RunsPage() {
  const groups = useResource(() => api.groups(), []);
  const runs = useResource(() => api.runs(), []);
  const defaultTimezone = useResource(() => api.defaultTimezone(), []);
  const [requestedGroupId, setRequestedGroupId] = useState<string | null>(null);

  // `?group=<id>` (from a group detail "Request a summary" link) preselects
  // that group. Read after mount so the static page needs no Suspense boundary.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("group");
    setRequestedGroupId(value === null || value === "" ? null : value);
  }, []);

  function handleCreated(run: SummaryRun, created: boolean): void {
    if (!created) {
      runs.reload();
      return;
    }
    runs.setData((previous) =>
      previous === null
        ? { items: [run], nextCursor: null }
        : { items: [run, ...previous.items], nextCursor: previous.nextCursor },
    );
  }

  function handleUpdated(updated: SummaryRun): void {
    runs.setData((previous) =>
      previous === null
        ? previous
        : {
            items: previous.items.map((run) =>
              run.id === updated.id ? updated : run,
            ),
            nextCursor: previous.nextCursor,
          },
    );
  }

  const groupList = groups.data;
  const initialGroupId =
    requestedGroupId !== null &&
    groupList !== null &&
    groupList.some((group) => group.id === requestedGroupId)
      ? requestedGroupId
      : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Summary runs"
        description="Request a summary for a group and period, then follow its status here. Completed runs show the generated summary."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={runs.reload}
            disabled={runs.loading}
          >
            Refresh
          </Button>
        }
      />

      {groups.error === null ? null : (
        <ErrorState
          error={groups.error}
          title="Could not load groups"
          onRetry={groups.reload}
        />
      )}

      {groups.loading && groupList === null ? (
        <SkeletonCard label="Loading groups…" />
      ) : null}

      {groupList !== null && groupList.length === 0 ? (
        <EmptyState
          title="No groups available"
          description="A summary needs a captured WhatsApp group. Groups appear once the WhatsApp connection imports them."
          action={
            <ButtonLink href="/" variant="secondary" size="sm">
              View connection status
            </ButtonLink>
          }
        />
      ) : null}

      {groupList !== null && groupList.length > 0 && !defaultTimezone.loading ? (
        <RequestRunForm
          key={initialGroupId ?? "none"}
          groups={groupList}
          defaultTimezone={defaultTimezone.data?.timezone ?? "UTC"}
          initialGroupId={initialGroupId}
          onCreated={handleCreated}
        />
      ) : null}

      {runs.loading && runs.data === null ? (
        <SkeletonCard label="Loading summary runs…" />
      ) : null}

      {runs.error === null ? null : (
        <ErrorState
          error={runs.error}
          title="Could not load summary runs"
          onRetry={runs.reload}
        />
      )}

      {runs.data === null ? null : (
        <RunsList
          runs={runs.data.items}
          groups={groupList ?? []}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
