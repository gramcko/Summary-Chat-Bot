"use client";

import type { ContactSummary } from "@summarly/contracts";
import Link from "next/link";
import { useState } from "react";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Badge } from "@/components/ui/Badges";
import { SelectField, TextField } from "@/components/ui/Field";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { contactLabel } from "@/lib/contacts";
import { useResource } from "@/lib/hooks";
import { formatDateTime } from "@/lib/time";

function ContactRow({ contact }: { contact: ContactSummary }) {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  return (
    <li>
      <Link
        href={`/contacts/${encodeURIComponent(contact.id)}`}
        className="group flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition-colors hover:border-brand-300 sm:flex-row sm:items-center sm:justify-between sm:p-5"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {contactLabel(contact)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {contact.groups.map((group) => (
              <Badge key={group.id} tone="neutral">
                {group.name}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {contact.messageCount} message
            {contact.messageCount === 1 ? "" : "s"}
            {contact.lastMessageAt === null
              ? ""
              : ` · last ${formatDateTime(contact.lastMessageAt, timeZone, dateFormat)}`}
          </p>
        </div>
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center gap-1 self-start text-sm font-medium text-brand-700 group-hover:underline sm:self-center"
        >
          Open
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </Link>
    </li>
  );
}

/** People who participate in at least one monitored group. */
export default function ContactsPage() {
  const contacts = useResource(() => api.contacts(), []);
  const { data, error, loading, reload } = contacts;
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");

  const groupsById = new Map(
    (data ?? []).flatMap((contact) =>
      contact.groups.map((group) => [group.id, group] as const),
    ),
  );
  const groupOptions = [
    { value: "all", label: "All monitored groups" },
    ...[...groupsById.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ value: group.id, label: group.name })),
  ];
  const needle = query.trim().toLowerCase();
  const filtered = (data ?? []).filter((contact) => {
    const matchesGroup =
      groupFilter === "all" ||
      contact.groups.some((group) => group.id === groupFilter);
    const matchesSearch =
      needle === "" ||
      (contact.name ?? "").toLowerCase().includes(needle) ||
      (contact.phone ?? "").toLowerCase().includes(needle) ||
      contact.id.toLowerCase().includes(needle);
    return matchesGroup && matchesSearch;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="People who participate in monitored groups. Open a contact to see the groups they are in and the messages they sent."
      />

      {data !== null && data.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
          <TextField
            id="contact-search"
            label="Search contacts"
            value={query}
            onChange={setQuery}
            placeholder="Name, phone, or id…"
            spellCheck={false}
          />
          <SelectField
            id="contact-group-filter"
            label="Group"
            value={groupFilter}
            onChange={setGroupFilter}
            options={groupOptions}
          />
        </div>
      ) : null}

      {loading && data === null ? <SkeletonCard label="Loading contacts…" /> : null}

      {error === null ? null : (
        <ErrorState
          error={error}
          title="Could not load contacts"
          onRetry={reload}
        />
      )}

      {data !== null && data.length === 0 ? (
        <EmptyState
          title="No contacts captured yet"
          description="Contacts come from the rosters of monitored groups. Monitor a group and wait for the bot worker to sync its members."
        />
      ) : null}

      {data !== null && data.length > 0 ? (
        <>
          <p aria-live="polite" className="text-xs text-slate-500">
            {filtered.length} of {data.length} contact
            {data.length === 1 ? "" : "s"} across monitored groups.
          </p>
          {filtered.length === 0 ? (
            <EmptyState
              title="No contacts match"
              description="Try a different search term or group filter."
            />
          ) : (
            <ul className="space-y-3">
              {filtered.map((contact) => (
                <ContactRow key={contact.id} contact={contact} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
