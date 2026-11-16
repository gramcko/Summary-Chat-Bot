"use client";

import type { ConnectionStatus } from "@summarly/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PairingDetails } from "@/components/connection/PairingDetails";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { ConnectionBadge, connectionHint } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api, toApiError, type ApiError } from "@/lib/api";
import {
  CONNECTION_POLL_MS,
  isLinkingExpired,
  secondsUntil,
  shouldPollConnection,
} from "@/lib/connection";
import { useResource } from "@/lib/hooks";
import { formatDateTime } from "@/lib/time";

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

function LinkedPanel({ status }: { status: ConnectionStatus }) {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700"
      >
        ✓
      </span>
      <p className="text-base font-semibold text-emerald-900">
        This device is linked
      </p>
      <p className="max-w-sm text-sm text-emerald-800">
        Messages from monitored groups are captured and can be summarised. The
        bot worker reconnects automatically if the link drops.
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-3 text-left sm:grid-cols-2">
        <Detail label="Connected since">
          <time dateTime={status.since}>
            {formatDateTime(status.since, timeZone, dateFormat)}
          </time>
        </Detail>
        <Detail label="Last captured message">
          {status.lastMessageAt === null ? (
            <span className="text-slate-500">No messages captured yet.</span>
          ) : (
            <time dateTime={status.lastMessageAt}>
              {formatDateTime(status.lastMessageAt, timeZone, dateFormat)}
            </time>
          )}
        </Detail>
      </dl>
    </div>
  );
}

function SessionCheckView({
  check,
}: {
  check: ConnectionStatus["check"];
}) {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  if (check === null) {
    return (
      <p className="text-xs text-slate-500">
        No session test has been run yet.
      </p>
    );
  }
  if (check.status === "pending") {
    return (
      <p role="status" className="text-xs font-medium text-slate-600">
        Testing the WhatsApp session…
      </p>
    );
  }
  const ok = check.status === "ok";
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-red-200 bg-red-50 text-red-900"
      }`}
    >
      <p className="font-medium">
        {ok ? "Session is working" : "Session test failed"}
      </p>
      <p className="mt-0.5 text-xs">
        {ok
          ? `Latency ${check.latencyMs ?? "?"} ms`
          : (check.error ?? "No response from the session.")}
        {check.checkedAt === null
          ? ""
          : ` · ${formatDateTime(check.checkedAt, timeZone, dateFormat)}`}
      </p>
    </div>
  );
}

export default function ConnectionPage() {
  const connection = useResource(() => api.connection(), []);
  const status = connection.data;
  const { notify } = useNotifications();
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  /**
   * After an unlink or a local connection-data reset the bot worker re-arms
   * pairing within seconds. The status can still read "connected" for a moment
   * (the request is asynchronous), so keep polling until a non-connected state
   * is observed — then the normal rule takes over. Without this the screen
   * would stop polling right before the new QR / pairing code appears.
   */
  const [refreshAfterUnlink, setRefreshAfterUnlink] = useState(false);
  const [refreshAfterTest, setRefreshAfterTest] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const checkPending = status?.check?.status === "pending";
  const polling =
    refreshAfterUnlink ||
    refreshAfterTest ||
    checkPending ||
    shouldPollConnection(status);
  const reload = connection.reload;

  const [now, setNow] = useState(() => Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  // Local connection-data reset (Danger zone): distinct from the unlink above.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const resetInFlight = useRef(false);

  // Poll for a live QR / pairing code while pairing; stop once connected.
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reload, CONNECTION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reload]);

  // One-second tick for the countdown while pairing.
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [polling]);

  // The forced watch after an unlink ends as soon as the worker reports the
  // session is no longer connected (normal polling continues from there).
  useEffect(() => {
    if (refreshAfterUnlink && status !== null && status.state !== "connected") {
      setRefreshAfterUnlink(false);
    }
  }, [refreshAfterUnlink, status]);

  // Finish a requested session test: stop the forced polling and announce
  // the result once the worker writes ok/failed.
  useEffect(() => {
    if (!refreshAfterTest) return;
    const check = status?.check;
    if (check === undefined || check === null || check.status === "pending") {
      return;
    }
    setRefreshAfterTest(false);
    if (check.status === "ok") {
      notify({
        title: "WhatsApp session is working",
        description: `Live probe succeeded${
          check.latencyMs === null ? "" : ` in ${check.latencyMs} ms`
        }.`,
        tone: "success",
      });
    } else {
      notify({
        title: "WhatsApp session test failed",
        description: check.error ?? "The session did not respond.",
        tone: "error",
      });
    }
  }, [refreshAfterTest, status, notify]);

  async function handleTestSession(): Promise<void> {
    setTesting(true);
    setTestError(null);
    try {
      await api.testConnection();
      setRefreshAfterTest(true);
      reload();
    } catch (cause) {
      setTestError(toApiError(cause).message);
      notify({
        title: "Could not start the session test",
        description: toApiError(cause).message,
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleUnlink(): Promise<void> {
    setUnlinking(true);
    setUnlinkError(null);
    setActionError(null);
    try {
      await api.logoutConnection();
      setConfirmOpen(false);
      // Watch for the re-armed pairing payload the bot worker publishes.
      setRefreshAfterUnlink(true);
      setFeedback(
        "Unlink requested. The bot worker will end the session; a fresh QR code or pairing code will appear here automatically.",
      );
      reload();
    } catch (cause) {
      setUnlinkError(toApiError(cause).message);
    } finally {
      setUnlinking(false);
    }
  }

  /**
   * Danger zone: delete the *local* session credentials and linking state
   * (`POST /api/connection/reset`). No remote logout is sent; captured data
   * and settings are kept. The bot worker re-arms pairing, so force polling
   * until the new QR / pairing code shows up.
   */
  async function handleResetConnection(): Promise<void> {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setResetting(true);
    setResetError(null);
    try {
      await api.resetConnection();
      setResetOpen(false);
      setRefreshAfterUnlink(true);
      setResetFeedback(
        "Connection data deleted. The bot worker will issue a fresh QR code or pairing code here automatically. If this device still appears in WhatsApp → Linked devices, remove it on the phone.",
      );
      notify({
        title: "Connection data deleted",
        description:
          "A fresh QR code or pairing code will appear here automatically.",
        tone: "success",
      });
      reload();
    } catch (cause) {
      setResetError(toApiError(cause).message);
    } finally {
      resetInFlight.current = false;
      setResetting(false);
    }
  }

  /** Opens the local connection-data reset dialog from either entry point. */
  function openResetDialog(): void {
    setResetError(null);
    setResetOpen(true);
  }

  const linking = status?.linking ?? null;
  const expired = linking !== null && isLinkingExpired(linking, now);
  const seconds = linking === null ? 0 : secondsUntil(linking.expiresAt, now);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connection"
        description="Link this installation to WhatsApp, watch the session state, and end the session when needed."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={reload}
            disabled={connection.loading}
          >
            Refresh
          </Button>
        }
      />

      {connection.error === null ? null : (
        <ErrorState
          error={connection.error}
          title="Could not load the connection status"
          onRetry={reload}
        />
      )}

      {status === null ? (
        connection.error === null ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <SkeletonCard label="Loading connection status…" />
            <SkeletonCard label="Loading pairing state…" />
          </div>
        ) : null
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <Card>
              <CardHeader
                title="WhatsApp session"
                description={connectionHint(status.state)}
                actions={<ConnectionBadge state={status.state} />}
              />
              <CardBody>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Detail label="State since">
                    <time dateTime={status.since}>
                      {formatDateTime(status.since, timeZone, dateFormat)}
                    </time>
                  </Detail>
                  <Detail label="Last captured message">
                    {status.lastMessageAt === null ? (
                      <span className="text-slate-500">No messages captured yet.</span>
                    ) : (
                      <time dateTime={status.lastMessageAt}>
                        {formatDateTime(status.lastMessageAt, timeZone, dateFormat)}
                      </time>
                    )}
                  </Detail>
                </dl>

                <div className="mt-5 border-t border-slate-200 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        Session health
                      </p>
                      <p className="text-xs text-slate-500">
                        Run a live probe to confirm the linked session can still
                        reach WhatsApp.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={testing || checkPending}
                      onClick={() => void handleTestSession()}
                      disabled={testing || checkPending}
                    >
                      Test session
                    </Button>
                  </div>
                  <div className="mt-3">
                    <SessionCheckView check={status.check} />
                  </div>
                  {testError === null ? null : (
                    <p
                      role="alert"
                      className="mt-2 text-xs font-medium text-red-700"
                    >
                      {testError}
                    </p>
                  )}
                </div>

                <div className="mt-5 border-t border-slate-200 pt-4">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setUnlinkError(null);
                      setConfirmOpen(true);
                    }}
                    disabled={unlinking}
                  >
                    End session / Unlink
                  </Button>
                  <p className="mt-2 text-xs text-slate-500">
                    Ends the linked WhatsApp session with a remote logout, so
                    the device is removed from WhatsApp → Linked devices.
                    Captured messages and summaries stay in the database; the
                    bot worker stops capturing until you link a device again.
                    If the stored session is broken and no QR code appears, use
                    Delete connection data in the Danger zone below instead.
                  </p>
                </div>
              </CardBody>
            </Card>

            <Alert tone="info" title="Pairing codes are live credentials">
              The QR code or pairing code below is a one-time ticket served only
              on this authenticated page. Do not share screenshots of it. If it
              expires, a new one appears automatically.
            </Alert>
          </div>

          <Card>
            <CardHeader
              title={status.state === "connected" ? "Linked device" : "Link a device"}
              description={
                status.state === "connected"
                  ? "The session is active."
                  : "Scan the QR code or enter the pairing code in WhatsApp."
              }
            />
            <CardBody>
              {status.state === "connected" ? (
                <LinkedPanel status={status} />
              ) : linking === null ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center">
                  <span
                    aria-hidden="true"
                    className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
                  />
                  <p role="status" className="text-sm font-medium text-slate-800">
                    Waiting for a QR code or pairing code…
                  </p>
                  <p className="max-w-xs text-xs text-slate-500">
                    The bot worker publishes a QR code or pairing code while it
                    is linking. This page checks every few seconds.
                  </p>
                  <div
                    role="note"
                    aria-label="Troubleshooting a missing link code"
                    className="mt-1 w-full max-w-sm rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left"
                  >
                    <p className="text-xs font-semibold text-amber-900">
                      No code after a while?
                    </p>
                    <p className="mt-1 text-xs text-amber-800">
                      The stored session may be invalid. The bot worker can get
                      stuck reconnecting with stale credentials and never
                      publish a new code. Deleting the local connection data
                      clears those credentials so a fresh link can be issued;
                      ending the session also logs the device out of WhatsApp.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setUnlinkError(null);
                          setConfirmOpen(true);
                        }}
                        disabled={unlinking}
                      >
                        End session / Unlink
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={openResetDialog}
                        disabled={resetting}
                      >
                        Delete connection data
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-amber-800">
                      Pairing-code linking requires{" "}
                      <code className="font-mono">WA_PHONE_NUMBER</code> on the
                      bot-worker; without it WhatsApp shows a QR code instead.
                    </p>
                  </div>
                </div>
              ) : (
                <PairingDetails
                  linking={linking}
                  remainingSeconds={seconds}
                  expired={expired}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {status === null ? null : (
        <Card className="border-red-200/90">
          <CardHeader
            title="Danger zone"
            description="Reset the local WhatsApp connection data when the stored session is partial or invalid."
          />
          <CardBody className="space-y-4">
            <div className="space-y-2 text-sm leading-6 text-slate-700">
              <p>
                <strong>Deletes:</strong> the local WhatsApp session
                credentials and linking state stored on this server.
              </p>
              <p>
                <strong>Keeps:</strong> captured groups, messages, summaries,
                and settings.
              </p>
              <p>
                Use this when the session is partial or invalid and no QR code
                appears. Unlike <em>End session / Unlink</em>, no remote logout
                is sent: if the device still appears in{" "}
                <em>WhatsApp → Linked devices</em>, remove it on the phone.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                variant="danger"
                onClick={openResetDialog}
                disabled={resetting}
              >
                Delete WhatsApp connection data
              </Button>
              <p className="text-xs leading-5 text-slate-500">
                You will be asked to confirm. A fresh QR code or pairing code
                appears right after.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {actionError === null ? null : (
        <Alert tone="error" title="Could not request the unlink">
          {actionError.message}
        </Alert>
      )}

      <div aria-live="polite">
        {feedback === null ? null : (
          <Alert tone="success" title="Unlink requested">
            {feedback}
          </Alert>
        )}
      </div>

      <div aria-live="polite">
        {resetFeedback === null ? null : (
          <Alert tone="success" title="Connection data deleted">
            {resetFeedback}
          </Alert>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="End the WhatsApp session?"
        description={
          <p>
            The bot worker will log out and stop capturing messages until you
            link a device again. Captured messages, imported history, and
            summaries are kept.
          </p>
        }
        confirmLabel="End session"
        loading={unlinking}
        error={unlinkError}
        onConfirm={() => void handleUnlink()}
        onCancel={() => {
          setConfirmOpen(false);
          setUnlinkError(null);
        }}
      />

      <ConfirmDialog
        open={resetOpen}
        title="Delete the WhatsApp connection data?"
        description={
          <div className="space-y-2">
            <p>
              The local WhatsApp session credentials and linking state are
              deleted, and a fresh QR code or pairing code is issued. Captured
              messages, summaries, and settings are kept.
            </p>
            <p className="text-xs text-slate-500">
              No remote logout is sent. If the device still appears in
              WhatsApp → Linked devices, remove it on the phone.
            </p>
          </div>
        }
        confirmLabel="Delete connection data"
        loading={resetting}
        error={resetError}
        onConfirm={() => void handleResetConnection()}
        onCancel={() => {
          if (resetting) return;
          setResetOpen(false);
          setResetError(null);
        }}
      />
    </div>
  );
}
