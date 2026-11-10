"use client";

import { DefaultDateFormatForm } from "@/components/settings/DefaultDateFormatForm";
import { DefaultTimezoneForm } from "@/components/settings/DefaultTimezoneForm";
import { ProviderForm } from "@/components/settings/ProviderForm";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingBlock, PageHeader } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useResource } from "@/lib/hooks";

export default function SettingsPage() {
  // `null` data with no error means "not configured yet" (backend 404).
  const config = useResource(() => api.providerConfig(), []);
  const loaded = !config.loading && config.error === null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="AI provider configuration for summary generation, plus the default time zone and date format for the dashboard. Credentials are stored server-side and never shown again."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={config.reload}
            disabled={config.loading}
          >
            Refresh
          </Button>
        }
      />

      {config.loading && config.data === null ? (
        <LoadingBlock label="Loading provider settings…" />
      ) : null}

      {config.error === null ? null : (
        <ErrorState
          error={config.error}
          title="Could not load provider settings"
          onRetry={config.reload}
        />
      )}

      {loaded ? (
        <ProviderForm
          initial={config.data}
          onSaved={(updated) => config.setData(updated)}
        />
      ) : null}

      <DefaultTimezoneForm />

      <DefaultDateFormatForm />

      <p className="text-xs leading-5 text-slate-500">
        WhatsApp session credentials are never available through the dashboard.
        Connection status is read-only and reports no authentication material.
      </p>
    </div>
  );
}
