"use client";

import type { ContactMessage } from "@summarly/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageBubble } from "@/components/messages/MessageBubble";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard, SkeletonRows } from "@/components/ui/Skeleton";
import { api, toApiError, type ApiError } from "@/lib/api";
import { contactLabel, formatPhone } from "@/lib/contacts";
import { MESSAGE_PAGE_SIZE, mergeOlderMessages } from "@/lib/group-messages";
import { useResource } from "@/lib/hooks";
import { formatDayHeading } from "@/lib/time";

/**
 * One contact across monitored groups: the groups they participate in
 * and the messages they sent (newest first, with "load older"). Contact
 * messages span groups, so timestamps use the browser's local zone.
 */
export function ContactDetailView({ contactId }: { contactId: string }) {
  const contact = useResource(() => api.contact(contactId), [contactId]);
  const current = contact.data;
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [olderError, setOlderError] = useState<ApiError | null>(null);
  const requestId = useRef(0);
  const { notify } = useNotifications();
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  async function loadFirstPage(): Promise<void> {
    requestId.current += 1;
    const id = requestId.current;
    setLoading(true);
    setError(null);
    setOlderError(null);
    try {
      const page = await api.contactMessages(contactId, {
        limit: MESSAGE_PAGE_SIZE,
      });
      if (requestId.current !== id) return;
      setMessages(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId.current !== id) return;
      setError(toApiError(cause));
      setMessages([]);
      setNextCursor(null);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }

  useEffect(() => {
    void loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function handleLoadOlder(): Promise<void> {
    if (nextCursor === null || loadingOlder) return;
    const id = requestId.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.contactMessages(contactId, {
        cursor: nextCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (requestId.current !== id) return;
      setMessages((current) => mergeOlderMessages(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requestId.current === id) setOlderError(toApiError(cause));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (current === null) return;
    const name = nameDraft.trim();
    if (name === "") {
      setNameError("Enter a display name.");
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const updated = await api.renameContact(current.id, { name });
      contact.setData(updated);
      setEditingName(false);
      void loadFirstPage();
      notify({
        title: "Contact renamed",
        description: `Now shown as “${updated.name ?? name}”.`,
        tone: "success",
      });
    } catch (cause) {
      const error = toApiError(cause);
      setNameError(error.message);
      notify({
        title: "Could not rename contact",
        description: error.message,
        tone: "error",
      });
    } finally {
      setSavingName(false);
    }
  }

  if (current === null) {
    if (contact.error !== null) {
      if (contact.error.code === "not_found") {
        return (
          <div className="space-y-6">
            <PageHeader title="Contact" />
            <EmptyState
              title="Contact not found"
              description="This contact is no longer on any monitored group's roster."
              action={
                <ButtonLink href="/contacts" variant="secondary">
                  Back to contacts
                </ButtonLink>
              }
            />
          </div>
        );
      }
      return (
        <div className="space-y-6">
          <PageHeader title="Contact" />
          <ErrorState
            error={contact.error}
            title="Could not load this contact"
            onRetry={contact.reload}
          />
        </div>
      );
    }
    return <SkeletonCard label="Loading contact…" />;
  }

  const phone = formatPhone(current.phone);
  const ordered = [...messages].reverse();

  return (
    <div className="space-y-6">
      <Link
        href="/contacts"
        className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-slate-500 hover:text-slate-900"
      >
        <span aria-hidden="true">←</span> All contacts
      </Link>

      <PageHeader
        title={contactLabel(current)}
        description={
          phone === null ? (
            "Participates in monitored groups."
          ) : (
            <>
              {phone} · participates in monitored groups.
            </>
          )
        }
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setNameDraft(current.name ?? "");
                setNameError(null);
                setEditingName(true);
              }}
            >
              Edit name
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={contact.reload}
              disabled={contact.loading}
            >
              Refresh
            </Button>
          </>
        }
      />

      {editingName ? (
        <Card>
          <CardHeader
            title="Display name"
            description="This override wins over the WhatsApp/roster name and survives automatic refreshes."
          />
          <CardBody>
            <form
              onSubmit={(event) => void handleRename(event)}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1">
                <TextField
                  id="contact-display-name"
                  label="Name"
                  value={nameDraft}
                  onChange={setNameDraft}
                  required
                  error={nameError ?? undefined}
                  disabled={savingName}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={savingName}>
                  Save name
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditingName(false)}
                  disabled={savingName}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Groups"
          description="Monitored groups where this contact is currently an active member."
        />
        <CardBody>
          {current.groups.length === 0 ? (
            <p className="text-sm text-slate-500">
              This contact is not on any monitored group&apos;s roster.
            </p>
          ) : (
            <ul className="space-y-2">
              {current.groups.map((group) => (
                <li key={group.id}>
                  <Link
                    href={`/groups/${group.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors hover:border-brand-300 hover:bg-brand-50/40"
                  >
                    <span className="min-w-0 truncate font-medium text-slate-800">
                      {group.name}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-slate-400"
                    >
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Messages"
          description={`${current.messageCount} message${
            current.messageCount === 1 ? "" : "s"
          } sent across monitored groups (including groups the contact may have left).`}
          actions={
            nextCursor === null ? undefined : (
              <Button
                variant="secondary"
                size="sm"
                loading={loadingOlder}
                onClick={() => void handleLoadOlder()}
              >
                Load older
              </Button>
            )
          }
        />
        <CardBody className="space-y-4">
          {loading && messages.length === 0 ? (
            <SkeletonRows label="Loading messages…" rows={4} />
          ) : null}

          {error === null ? null : (
            <ErrorState
              error={error}
              title="Could not load this contact's messages"
              onRetry={() => void loadFirstPage()}
            />
          )}

          {olderError === null ? null : (
            <Alert tone="error" title="Could not load older messages">
              {olderError.message}
            </Alert>
          )}

          {!loading && error === null && messages.length === 0 ? (
            <EmptyState
              title="No messages from this contact"
              description="Messages appear here when this contact sends a message in a monitored group."
            />
          ) : null}

          {ordered.length === 0 ? null : (
            <ol aria-label="Messages" className="space-y-4">
              {ordered.map((message, index) => {
                const previous = ordered[index - 1];
                const showDay =
                  previous === undefined ||
                  formatDayHeading(previous.sentAt, timeZone, dateFormat) !==
                    formatDayHeading(message.sentAt, timeZone, dateFormat);
                return (
                  <li key={message.id}>
                    {showDay ? (
                      <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
                        {formatDayHeading(message.sentAt, timeZone, dateFormat)}
                      </p>
                    ) : null}
                    <MessageBubble
                      message={message}
                      timeZone={timeZone}
                      meta={<Badge tone="neutral">{message.groupName}</Badge>}
                    />
                  </li>
                );
              })}
            </ol>
          )}

          {nextCursor === null ? null : (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={loadingOlder}
                onClick={() => void handleLoadOlder()}
              >
                Load older messages
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
