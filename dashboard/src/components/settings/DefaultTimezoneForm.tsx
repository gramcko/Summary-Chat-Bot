"use client";

import type { DefaultTimezoneSettings } from "@summarly/contracts";
import { useState, type FormEvent } from "react";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { IanaTimeZoneOptions, TIME_ZONE_LIST_ID } from "@/components/TimeZones";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { ErrorState } from "@/components/ui/States";
import { api, toApiError } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { validateIanaTimeZone } from "@/lib/validation";

function TimezoneEditor({
  initial,
  onSaved,
}: {
  initial: DefaultTimezoneSettings;
  onSaved: (next: DefaultTimezoneSettings) => void;
}) {
  const { notify } = useNotifications();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateIanaTimeZone(timezone);
    if (validation !== null) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateDefaultTimezone({
        timezone: timezone.trim(),
      });
      onSaved(updated);
      window.dispatchEvent(new Event("summarly:timezone-changed"));
      notify({
        title: "Default time zone saved",
        description: `New groups will use ${updated.timezone}.`,
        tone: "success",
      });
    } catch (cause) {
      const failure = toApiError(cause);
      setError(failure.message);
      notify({
        title: "Could not save the default time zone",
        description: failure.message,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Default time zone"
        description="Used for NEW groups and as the initial value in the summary request form. Existing groups keep their own time zone."
      />
      <CardBody>
        <IanaTimeZoneOptions />
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1">
            <TextField
              id="default-timezone"
              label="IANA time zone"
              value={timezone}
              onChange={setTimezone}
              list={TIME_ZONE_LIST_ID}
              required
              error={error ?? undefined}
              disabled={saving}
              spellCheck={false}
            />
          </div>
          <Button type="submit" size="sm" loading={saving}>
            Save time zone
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

/** Settings card for the global default IANA time zone. */
export function DefaultTimezoneForm() {
  const settings = useResource(() => api.defaultTimezone(), []);

  if (settings.data === null) {
    if (settings.error !== null) {
      return (
        <ErrorState
          error={settings.error}
          title="Could not load the default time zone"
          onRetry={settings.reload}
        />
      );
    }
    return null;
  }

  return (
    <TimezoneEditor
      initial={settings.data}
      onSaved={(next) => settings.setData(next)}
    />
  );
}
