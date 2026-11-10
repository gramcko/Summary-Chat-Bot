"use client";

import type { CreateRunRequest, Group, SummaryRun } from "@summarly/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { TextAreaField, TextField } from "@/components/ui/Field";
import { GroupCombobox } from "@/components/runs/GroupCombobox";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { IanaTimeZoneOptions, TIME_ZONE_LIST_ID } from "@/components/TimeZones";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import {
  INSTRUCTIONS_MAX_LENGTH,
  normalizeInstructions,
  validateInstructions,
} from "@/lib/instructions";
import {
  defaultRunWindow,
  runWindowAroundLatest,
  wallTimeInZoneToInstant,
} from "@/lib/time";
import {
  hasErrors,
  isValidIanaTimeZone,
  validateIanaTimeZone,
  type FieldErrors,
} from "@/lib/validation";

interface RequestRunFormProps {
  groups: readonly Group[];
  /** Global default IANA zone used until a group is selected. */
  defaultTimezone: string;
  /** Group to select on first render (e.g. arriving from a group detail). */
  initialGroupId?: string;
  onCreated: (run: SummaryRun, created: boolean) => void;
}

interface SubmitResult {
  run: SummaryRun;
  created: boolean;
}

export function RequestRunForm({
  groups,
  defaultTimezone,
  initialGroupId,
  onCreated,
}: RequestRunFormProps) {
  const { notify } = useNotifications();
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [instructions, setInstructions] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const lastPrefilledGroup = useRef<string | null>(null);
  // Guards the asynchronous "latest message" prefill against stale responses
  // when the user picks another group before the request finishes.
  const prefillToken = useRef(0);

  const selectedGroupId = groupId;

  // Prefill the time zone and window when the selected group changes. The
  // window starts as the rolling default day, then moves to cover the group's
  // newest captured message so a fresh request never silently covers an empty
  // period (e.g. a group whose last message was days ago).
  useEffect(() => {
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (group === undefined) return;
    if (lastPrefilledGroup.current === group.id) return;
    lastPrefilledGroup.current = group.id;
    setTimezone(group.timezone);
    const fallback = defaultRunWindow(group.timezone);
    setStart(fallback.start);
    setEnd(fallback.end);
    setResult(null);

    const token = ++prefillToken.current;
    setPrefilling(true);
    void api
      .groupMessages(group.id, { limit: 1 })
      .then((page) => {
        if (prefillToken.current !== token) return;
        const newest = page.items[0]?.sentAt;
        if (newest === undefined) return;
        const window = runWindowAroundLatest(newest, group.timezone);
        setStart(window.start);
        setEnd(window.end);
      })
      .catch(() => {
        // Keep the rolling default window; the user can still adjust it.
      })
      .finally(() => {
        if (prefillToken.current === token) setPrefilling(false);
      });
  }, [groups, selectedGroupId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);
    setResult(null);

    const errors: FieldErrors = {};
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (group === undefined) errors.groupId = "Select a group.";

    const timezoneError = validateIanaTimeZone(timezone);
    if (timezoneError !== null) errors.timezone = timezoneError;

    const instructionsError = validateInstructions(instructions);
    if (instructionsError !== null) errors.instructions = instructionsError;

    if (start === "") errors.start = "Choose a start date and time.";
    if (end === "") errors.end = "Choose an end date and time.";

    const tz = timezone.trim();
    const zoneUsable = isValidIanaTimeZone(tz);
    const startInstant =
      zoneUsable && start !== "" ? wallTimeInZoneToInstant(start, tz) : null;
    const endInstant =
      zoneUsable && end !== "" ? wallTimeInZoneToInstant(end, tz) : null;

    if (start !== "" && startInstant === null && zoneUsable) {
      errors.start = "Enter a valid start date and time.";
    }
    if (end !== "" && endInstant === null && zoneUsable) {
      errors.end = "Enter a valid end date and time.";
    }
    if (
      startInstant !== null &&
      endInstant !== null &&
      endInstant.getTime() <= startInstant.getTime()
    ) {
      errors.end = "The end must be after the start (start inclusive, end exclusive).";
    }

    setFieldErrors(errors);
    if (hasErrors(errors)) return;
    if (startInstant === null || endInstant === null) return;

    const body: CreateRunRequest = {
      groupId: selectedGroupId,
      interval: {
        start: startInstant.toISOString(),
        end: endInstant.toISOString(),
        timezone: tz,
      },
    };
    const normalizedInstructions = normalizeInstructions(instructions);
    if (normalizedInstructions !== undefined) {
      body.instructions = normalizedInstructions;
    }

    setSubmitting(true);
    try {
      const response = await api.createRun(body);
      setResult(response);
      onCreated(response.run, response.created);
      notify({
        title: response.created ? "Summary requested" : "Summary already requested",
        description: response.created
          ? "The run is queued. You will be notified when it completes."
          : "An identical run already exists for this period.",
        tone: response.created ? "success" : "info",
        href: `/runs/${response.run.id}`,
      });
    } catch (cause) {
      const error = toApiError(cause);
      const mapped = mapFieldErrors(error.details);
      const relevant: FieldErrors = {};
      for (const name of [
        "groupId",
        "timezone",
        "start",
        "end",
        "interval",
        "instructions",
      ]) {
        const message = mapped[name];
        if (message !== undefined) relevant[name] = message;
      }
      setFieldErrors(relevant);
      if (!hasErrors(relevant)) setFailure(error);
      notify({
        title: "Could not request summary",
        description: error.message,
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Request a summary"
        description="Choose a group and a half-open period (start inclusive, end exclusive). Times are interpreted in the selected time zone and sent as instants."
      />
      <CardBody className="space-y-4">
        <IanaTimeZoneOptions />
        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <GroupCombobox
            groups={groups}
            value={selectedGroupId}
            onChange={(value) => {
              setGroupId(value);
              setResult(null);
              setFieldErrors({});
            }}
            disabled={submitting}
            error={fieldErrors.groupId}
          />

          <TextField
            id="run-timezone"
            label="Time zone"
            value={timezone}
            onChange={setTimezone}
            list={TIME_ZONE_LIST_ID}
            required
            hint="IANA name. Prefilled from the selected group; change it only if this request differs."
            error={fieldErrors.timezone}
            disabled={submitting}
            spellCheck={false}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              id="run-start"
              label="Start (inclusive)"
              type="datetime-local"
              value={start}
              onChange={setStart}
              required
              error={fieldErrors.start}
              disabled={submitting}
            />
            <TextField
              id="run-end"
              label="End (exclusive)"
              type="datetime-local"
              value={end}
              onChange={setEnd}
              required
              error={fieldErrors.end}
              disabled={submitting}
            />
          </div>

          <TextAreaField
            id="run-instructions"
            label="Custom instructions (optional)"
            value={instructions}
            onChange={setInstructions}
            rows={3}
            counterMax={INSTRUCTIONS_MAX_LENGTH}
            showCounter
            placeholder="Focus on decisions and deadlines; ignore small talk."
            hint="Guidance for this summary only. It is sent to the AI provider as instructions, not as conversation content."
            error={fieldErrors.instructions}
            disabled={submitting}
          />

          {fieldErrors.interval === undefined ? null : (
            <Alert tone="error" title="Check the requested period">
              {fieldErrors.interval}
            </Alert>
          )}

          {failure === null ? null : (
            <Alert tone="error" title="Could not request the summary">
              {failure.message}
            </Alert>
          )}

          {result === null ? null : result.created ? (
            <Alert tone="success" title="Summary requested">
              <p>
                The run is queued and will move from pending to processing to
                completed.{" "}
                <Link
                  href={`/runs/${result.run.id}`}
                  className="font-medium underline"
                >
                  Open the run
                </Link>
                .
              </p>
            </Alert>
          ) : (
            <Alert tone="info" title="This period was already requested">
              <p>
                An identical run already exists for this group and period, so no
                new run was created.{" "}
                <Link
                  href={`/runs/${result.run.id}`}
                  className="font-medium underline"
                >
                  Open the existing run
                </Link>
                .
              </p>
            </Alert>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="submit" loading={submitting} disabled={prefilling}>
              Request summary
            </Button>
            <p className="text-xs text-slate-500">
              {prefilling
                ? "Adjusting the period to include the group's latest messages…"
                : "Generation runs in the background; you do not need to keep this page open."}
            </p>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
