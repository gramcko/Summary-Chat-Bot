"use client";

import type { DateFormat, DefaultDateFormatSettings } from "@summarly/contracts";
import { useState, type FormEvent } from "react";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { SelectField, type SelectOption } from "@/components/ui/Field";
import { ErrorState } from "@/components/ui/States";
import { api, toApiError } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { DATE_FORMATS } from "@/lib/time";

const FORMAT_LABELS: Record<DateFormat, string> = {
  "DD/MM/YYYY": "31/12/2026 (day/month/year)",
  "MM/DD/YYYY": "12/31/2026 (month/day/year)",
  "YYYY-MM-DD": "2026-12-31 (ISO)",
  "DD MMM YYYY": "31 Dec 2026",
};

const OPTIONS: readonly SelectOption[] = DATE_FORMATS.map((value) => ({
  value,
  label: FORMAT_LABELS[value] ?? value,
}));

function DateFormatEditor({
  initial,
  onSaved,
}: {
  initial: DefaultDateFormatSettings;
  onSaved: (next: DefaultDateFormatSettings) => void;
}) {
  const { notify } = useNotifications();
  const [dateFormat, setDateFormat] = useState<DateFormat>(initial.dateFormat);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateDefaultDateFormat({ dateFormat });
      onSaved(updated);
      window.dispatchEvent(new Event("summarly:date-format-changed"));
      notify({
        title: "Default date format saved",
        description: `Dashboard dates will use ${updated.dateFormat}.`,
        tone: "success",
      });
    } catch (cause) {
      const failure = toApiError(cause);
      setError(failure.message);
      notify({
        title: "Could not save the default date format",
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
        title="Default date format"
        description="Used for dates across the dashboard (runs, connection, contacts, roster updates). Times still use your browser locale."
      />
      <CardBody>
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1">
            <SelectField
              id="default-date-format"
              label="Date format"
              value={dateFormat}
              onChange={(value) => {
                if (DATE_FORMATS.includes(value as DateFormat)) {
                  setDateFormat(value as DateFormat);
                }
              }}
              options={OPTIONS}
              error={error ?? undefined}
              disabled={saving}
            />
          </div>
          <Button type="submit" size="sm" loading={saving}>
            Save date format
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

/** Settings card for the global display date format. */
export function DefaultDateFormatForm() {
  const settings = useResource(() => api.defaultDateFormat(), []);

  if (settings.data === null) {
    if (settings.error !== null) {
      return (
        <ErrorState
          error={settings.error}
          title="Could not load the default date format"
          onRetry={settings.reload}
        />
      );
    }
    return null;
  }

  return (
    <DateFormatEditor
      initial={settings.data}
      onSaved={(next) => settings.setData(next)}
    />
  );
}
