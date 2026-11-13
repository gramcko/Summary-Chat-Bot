"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** Spinner/disable state for the confirm action. */
  loading?: boolean;
  /**
   * Optional third choice rendered between "Cancel" and the confirm action
   * (for example "Monitor only" next to "Monitor & import history").
   */
  alternativeLabel?: string;
  onAlternative?: () => void;
  alternativeLoading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog. Uses a native `<dialog>` so focus trapping, `Escape`,
 * and the backdrop come from the platform.
 *
 * While an action is submitting (`loading`/`alternativeLoading`) the dialog
 * cannot be dismissed: the cancel button is disabled, backdrop clicks are
 * ignored, and the native `cancel` event (Escape) is prevented — this prevents
 * a request from being fired twice or its error being lost with the dialog.
 *
 * Centering: the UA stylesheet centers a modal dialog with `inset: 0` plus
 * `margin: auto`, but Tailwind Preflight resets `margin` to 0, which leaves the
 * dialog in the top-left corner. `inset-0 m-auto` restores that centering
 * explicitly, and `max-h`/`overflow-y-auto` keep tall dialogs usable on small
 * screens instead of overflowing the viewport.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  alternativeLabel,
  onAlternative,
  alternativeLoading = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openRef = useRef(open);
  const titleId = useId();
  const descriptionId = useId();
  const busy = loading || alternativeLoading;

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handleClose = () => {
      if (openRef.current) onCancel();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onCancel]);

  // Escape while submitting must not dismiss (and lose) the in-flight action.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handleCancelEvent = (event: Event) => {
      if (busy) event.preventDefault();
    };
    dialog.addEventListener("cancel", handleCancelEvent);
    return () => dialog.removeEventListener("cancel", handleCancelEvent);
  }, [busy]);

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current && !busy) onCancel();
    },
    [busy, onCancel],
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={handleBackdropClick}
      className="inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[min(92vw,28rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/50"
    >
      <div className="px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div id={descriptionId} className="mt-2 text-sm text-slate-600">
          {description}
        </div>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          {alternativeLabel === undefined || onAlternative === undefined ? null : (
            <Button
              variant="secondary"
              onClick={onAlternative}
              disabled={loading}
              loading={alternativeLoading}
            >
              {alternativeLabel}
            </Button>
          )}
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
            disabled={alternativeLoading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
