"use client";

import type { DeleteAllDataCounts } from "@summarly/contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TextField } from "@/components/ui/Field";
import { api, toApiError } from "@/lib/api";

/**
 * Exact literal required by the backend schema (`DeleteAllDataRequest`): any
 * other value is a `400 validation_error`, so the confirm button stays
 * disabled until the admin types it verbatim.
 */
const CONFIRMATION = "DELETE ALL";

const CONFIRMATION_ID = "delete-all-data-confirmation";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Human-readable row counts. Numbers only — the API never returns content. */
function describeDeletedCounts(deleted: DeleteAllDataCounts): string {
  return [
    plural(deleted.groups, "group", "groups"),
    plural(deleted.messages, "message", "messages"),
    plural(deleted.summaryRuns, "summary run", "summary runs"),
    plural(deleted.summaries, "summary", "summaries"),
    plural(deleted.groupMembers, "group member", "group members"),
    plural(deleted.contactOverrides, "contact override", "contact overrides"),
  ].join(", ");
}

/**
 * Settings "danger zone": the guarded `POST /api/admin/delete-all-data`
 * action. Captured conversation artifacts are removed; administrative state
 * (admin login, app settings, AI provider key, WhatsApp connection/session,
 * the database itself) is deliberately kept by the backend.
 *
 * Guard rails: the action is behind a confirmation dialog that requires the
 * exact `DELETE ALL` literal, the button is disabled until it matches, the
 * dialog cannot be dismissed while the request is in flight, and a ref guards
 * against a double submit.
 */
export function DeleteAllDataCard() {
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<DeleteAllDataCounts | null>(null);
  const inFlight = useRef(false);

  const matches = confirmation === CONFIRMATION;

  function closeDialog(): void {
    if (deleting) return;
    setOpen(false);
    setConfirmation("");
    setError(null);
  }

  async function handleConfirm(): Promise<void> {
    if (inFlight.current || !matches) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);
    try {
      const response = await api.deleteAllData({ confirmation: CONFIRMATION });
      setDeleted(response.deleted);
      setOpen(false);
      setConfirmation("");
      notify({
        title: "Captured data deleted",
        description: describeDeletedCounts(response.deleted),
        tone: "success",
        href: "/groups",
      });
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  }

  return (
    <Card className="border-red-200/90">
      <CardHeader
        title="Danger zone"
        description="Irreversible deletion of the conversation data Summarly captured. Configuration is kept, so summaries can resume once new messages arrive."
      />
      <CardBody className="space-y-4">
        <div className="space-y-2 text-sm leading-6 text-slate-700">
          <p>
            <strong>Deletes:</strong> captured groups, messages, summary runs,
            completed summaries, group members, and contact overrides.
          </p>
          <p>
            <strong>Keeps:</strong> the admin login, app settings (default time
            zone and date format), the AI provider key, the WhatsApp
            connection/session, and the database itself.
          </p>
        </div>

        {deleted === null ? null : (
          <Alert tone="success" title="Captured data deleted">
            <p>{describeDeletedCounts(deleted)} removed.</p>
            <p className="mt-1">
              Nothing is captured until new WhatsApp messages arrive.{" "}
              <Link href="/groups" className="font-medium underline">
                Go to groups
              </Link>
            </p>
          </Alert>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="danger"
            onClick={() => setOpen(true)}
            disabled={deleting}
          >
            Delete all captured data
          </Button>
          <p className="text-xs leading-5 text-slate-500">
            You must type{" "}
            <span className="font-mono font-medium">{CONFIRMATION}</span> to
            confirm.
          </p>
        </div>
      </CardBody>

      <ConfirmDialog
        open={open}
        title="Delete all captured data?"
        description={
          <div className="space-y-3">
            <p>
              Captured groups, messages, summary runs, summaries, group members,
              and contact overrides are permanently removed. This cannot be
              undone.
            </p>
            <p className="text-xs text-slate-500">
              The admin login, app settings, AI provider key, WhatsApp
              connection/session, and the database are kept.
            </p>
            <TextField
              id={CONFIRMATION_ID}
              label={
                <>
                  Type <span className="font-mono">{CONFIRMATION}</span> to
                  confirm
                </>
              }
              value={confirmation}
              onChange={setConfirmation}
              placeholder={CONFIRMATION}
              hint="The confirmation must match exactly (uppercase, single space)."
              autoComplete="off"
              spellCheck={false}
              disabled={deleting}
              mono
            />
          </div>
        }
        confirmLabel="Delete everything"
        loading={deleting}
        confirmDisabled={!matches}
        error={error}
        onConfirm={() => void handleConfirm()}
        onCancel={closeDialog}
      />
    </Card>
  );
}
