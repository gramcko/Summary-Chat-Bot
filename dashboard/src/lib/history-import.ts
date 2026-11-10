import type {
  Group,
  GroupHistoryImport,
  HistoryImportStatus,
} from "@summarly/contracts";

/**
 * Pure helpers for the WhatsApp history import (ADR 0007).
 *
 * The import is opt-in per monitored group: switching a group to monitored asks
 * whether to retrieve older messages, and the group card shows the
 * system-managed `historyImport` state the backend/bot-worker maintain.
 */

/** How often the groups list is polled while an import is in flight. */
export const HISTORY_IMPORT_POLL_MS = 5_000;

/**
 * A `pending` import older than this probably means the bot worker is not
 * polling (it owns the WhatsApp session and performs the import), so the card
 * shows a "check that it is running" hint. No new endpoint: derived locally
 * from `requestedAt`.
 */
export const HISTORY_IMPORT_STALL_MS = 10 * 60 * 1000;

export interface HistoryImportSummary {
  status: HistoryImportStatus;
  /** True for `pending`/`running` (the UI polls and shows a spinner). */
  inFlight: boolean;
  badgeLabel: string;
  /** Primary line, including the exact copy required for done/failed. */
  message: string;
  /** Secondary line (progress count, safe error text), if any. */
  detail: string | null;
  /** Extra caution line for a stuck `pending` import, if any. */
  hint: string | null;
  /** True when a failed import can be requested again. */
  showRetry: boolean;
}

/**
 * Turning monitoring ON is the moment to ask about old messages. Turning it
 * off, or a no-op change, needs no prompt.
 */
export function requiresHistoryImportPrompt(
  currentlyMonitored: boolean,
  nextMonitored: boolean,
): boolean {
  return !currentlyMonitored && nextMonitored;
}

export function historyImportInFlight(
  state: GroupHistoryImport | null,
): boolean {
  return state?.status === "pending" || state?.status === "running";
}

/** True while any group has an import pending/running (drives polling). */
export function anyHistoryImportInFlight(
  groups: readonly Group[] | null | undefined,
): boolean {
  return (groups ?? []).some((group) => historyImportInFlight(group.historyImport));
}

/**
 * A `pending` import that has not started for a while is most likely waiting on
 * a bot worker that is not running (the worker performs the import). Uses only
 * `requestedAt`, so it needs no new API surface.
 */
export function isHistoryImportStalled(
  state: GroupHistoryImport | null,
  now: number = Date.now(),
): boolean {
  if (state === null || state.status !== "pending") return false;
  const requestedAt = Date.parse(state.requestedAt);
  if (!Number.isFinite(requestedAt)) return false;
  return now - requestedAt > HISTORY_IMPORT_STALL_MS;
}

function importedMessages(count: number): string {
  return `${count} old message${count === 1 ? "" : "s"}`;
}

/** Friendly detail text for the safe error codes the worker stores. */
const IMPORT_ERROR_TEXT: Record<string, string> = {
  history_timeout:
    "No response from the linked phone. Keep WhatsApp online and retry. Some linked devices do not answer on-demand history; if this keeps failing, enable WA_HISTORY_SYNC=recent or full on the bot-worker and re-link the WhatsApp session.",
  history_unavailable: "WhatsApp could not provide history for this chat.",
  history_no_anchor:
    "There are no captured messages to page back from yet. Wait for a live message in this group, then retry.",
  history_phone_offline:
    "The linked phone is offline. Open WhatsApp on the phone, keep it connected, and retry.",
  history_declined: "The linked phone declined to share this chat's history.",
  history_expired: "The history request expired before the phone answered.",
  history_internal: "The import stopped on an internal error.",
  group_unmonitored: "The group is no longer monitored.",
};

/**
 * Maps the system-managed import state to display copy. `null` means the import
 * was never requested (the card offers to request it later). `now` is injectable
 * so the "stuck pending" hint is testable.
 */
export function summarizeHistoryImport(
  state: GroupHistoryImport | null,
  now: number = Date.now(),
): HistoryImportSummary | null {
  if (state === null) return null;

  switch (state.status) {
    case "pending":
      return {
        status: state.status,
        inFlight: true,
        badgeLabel: "Importing",
        message: "Importing old messages…",
        detail:
          state.importedCount > 0
            ? `${state.importedCount} imported so far`
            : "Waiting for the bot worker to start the import.",
        hint: isHistoryImportStalled(state, now)
          ? "Still waiting for the bot worker — check that it is running."
          : null,
        showRetry: false,
      };
    case "running":
      return {
        status: state.status,
        inFlight: true,
        badgeLabel: "Importing",
        message: "Importing old messages…",
        detail:
          state.importedCount > 0
            ? `${state.importedCount} imported so far`
            : "Reading the history WhatsApp makes available.",
        hint: null,
        showRetry: false,
      };
    case "done":
      return {
        status: state.status,
        inFlight: false,
        badgeLabel: "Imported",
        // 0 inserted can also mean "everything was already imported" or "all
        // skipped", so keep the copy neutral rather than implying WhatsApp had
        // no history.
        message:
          state.importedCount === 0
            ? "No new older messages were imported."
            : `Imported ${importedMessages(state.importedCount)}`,
        detail: null,
        hint: null,
        showRetry: false,
      };
    case "failed":
      return {
        status: state.status,
        inFlight: false,
        badgeLabel: "Import failed",
        message: "History import failed",
        detail:
          state.error === null
            ? "The import did not finish."
            : (IMPORT_ERROR_TEXT[state.error] ?? state.error),
        hint: null,
        showRetry: true,
      };
  }
}
