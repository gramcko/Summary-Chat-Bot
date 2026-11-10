import type {
  DateFormat,
  DecisionItem,
  LinkItem,
  SourceRef,
  Summary,
  TaskItem,
} from "@summarly/contracts";
import type { ReactNode } from "react";
import { pluralize } from "@/lib/format";
import {
  DEFAULT_DATE_FORMAT,
  formatDateTime,
  formatDueDate,
} from "@/lib/time";
import { Alert } from "./ui/Alert";
import { Card, CardBody, CardHeader } from "./ui/Card";

/** Mandatory notice: summaries are AI output and must be verified. */
export function AiSummaryNotice() {
  return (
    <Alert
      tone="warning"
      title="AI-generated summary — verify consequential items against source messages"
    >
      <p>
        This content was produced by an AI model from captured messages. Check
        decisions, deadlines, owners, and tasks against the original conversation
        before acting on them.
      </p>
    </Alert>
  );
}

function NotSpecified() {
  return <span className="italic text-slate-500">not specified</span>;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface SourceRefListProps {
  refs: readonly SourceRef[];
  timeZone?: string;
  dateFormat: DateFormat;
}

function SourceRefList({ refs, timeZone, dateFormat }: SourceRefListProps) {
  if (refs.length === 0) {
    return (
      <p className="mt-1 text-xs text-slate-500">No source messages cited.</p>
    );
  }

  return (
    <details className="mt-1 text-xs text-slate-600">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        {refs.length} source {pluralize(refs.length, "message")}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {refs.map((ref, index) => (
          <li key={`${ref.messageId}-${index}`} className="flex flex-wrap gap-x-2">
            <code className="break-all font-mono text-[11px] text-slate-700">
              {ref.messageId}
            </code>
            <span className="text-slate-500">
              sent {formatDateTime(ref.sentAt, timeZone, dateFormat)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

interface ClaimListProps {
  items: readonly DecisionItem[];
  emptyLabel: string;
  timeZone?: string;
  dateFormat: DateFormat;
}

function ClaimList({
  items,
  emptyLabel,
  timeZone,
  dateFormat,
}: ClaimListProps) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${index}-${item.text.slice(0, 24)}`}
          className="rounded-lg border border-slate-200 px-3 py-2"
        >
          <p className="text-sm leading-6 text-slate-800">{item.text}</p>
          <SourceRefList
            refs={item.sourceRefs}
            timeZone={timeZone}
            dateFormat={dateFormat}
          />
        </li>
      ))}
    </ul>
  );
}

interface TaskListProps {
  tasks: readonly TaskItem[];
  timeZone?: string;
  dateFormat: DateFormat;
}

function TaskList({ tasks, timeZone, dateFormat }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="text-sm text-slate-500">No tasks were reported.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-sm">
        <caption className="sr-only">Tasks reported in this summary</caption>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">
              Task
            </th>
            <th scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">
              Owner
            </th>
            <th scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">
              Due date
            </th>
            <th scope="col" className="whitespace-nowrap py-2 font-medium">
              Sources
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tasks.map((task, index) => (
            <tr key={`${index}-${task.text.slice(0, 24)}`}>
              <td className="min-w-56 py-3 pr-4 align-top leading-6 text-slate-800">
                {task.text}
              </td>
              <td className="py-3 pr-4 align-top text-slate-800">
                {task.owner === null ? <NotSpecified /> : task.owner}
              </td>
              <td className="py-3 pr-4 align-top text-slate-800">
                {task.dueDate === null ? (
                  <NotSpecified />
                ) : (
                  formatDueDate(task.dueDate, dateFormat)
                )}
              </td>
              <td className="min-w-44 py-3 align-top">
                <SourceRefList
                  refs={task.sourceRefs}
                  timeZone={timeZone}
                  dateFormat={dateFormat}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface LinkListProps {
  links: readonly LinkItem[];
}

function LinkList({ links }: LinkListProps) {
  if (links.length === 0) {
    return <p className="text-sm text-slate-500">No links were shared.</p>;
  }
  return (
    <ul className="space-y-2">
      {links.map((link, index) => (
        <li key={`${index}-${link.url}`}>
          {isHttpUrl(link.url) ? (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="break-all text-sm font-medium text-brand-700 underline hover:text-brand-800"
            >
              {link.url}
            </a>
          ) : (
            <span className="break-all text-sm text-slate-800">{link.url}</span>
          )}
          {link.description === null ? null : (
            <p className="mt-0.5 text-sm text-slate-600">{link.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

interface SectionProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export interface SummaryViewProps {
  summary: Summary;
  /** IANA time zone of the run, used for source message timestamps. */
  timeZone?: string;
  /** Display date format for source timestamps and due dates. */
  dateFormat?: DateFormat;
}

/** Renders a validated `SummaryResult` (packages/contracts). */
export function SummaryView({
  summary,
  timeZone,
  dateFormat = DEFAULT_DATE_FORMAT,
}: SummaryViewProps) {
  const { result } = summary;

  return (
    <div className="space-y-5">
      <AiSummaryNotice />

      <Section
        title="Overview"
        description={`Generated by ${summary.provider} (${summary.model}) · ${formatDateTime(summary.createdAt, timeZone, dateFormat)}`}
      >
        <p className="whitespace-pre-line text-sm leading-6 text-slate-800">
          {result.overview}
        </p>
      </Section>

      <Section
        title="Key discussions"
        description="Topics the conversation actually covered."
      >
        {result.keyDiscussions.length === 0 ? (
          <p className="text-sm text-slate-500">
            No key discussions were reported for this period.
          </p>
        ) : (
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-800">
            {result.keyDiscussions.map((item, index) => (
              <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Decisions"
        description="Confirmed decisions are separated from proposals and open questions."
      >
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Confirmed decisions
            </h3>
            <div className="mt-2">
              <ClaimList
                items={result.confirmedDecisions}
                emptyLabel="No confirmed decisions were reported."
                timeZone={timeZone}
                dateFormat={dateFormat}
              />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Proposals</h3>
            <div className="mt-2">
              <ClaimList
                items={result.proposals}
                emptyLabel="No proposals were reported."
                timeZone={timeZone}
                dateFormat={dateFormat}
              />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Unresolved questions
            </h3>
            <div className="mt-2">
              <ClaimList
                items={result.unresolvedQuestions}
                emptyLabel="No unresolved questions were reported."
                timeZone={timeZone}
                dateFormat={dateFormat}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Tasks"
        description="Owner and due date are only shown when the conversation states them."
      >
        <TaskList
          tasks={result.tasks}
          timeZone={timeZone}
          dateFormat={dateFormat}
        />
      </Section>

      <Section title="Links" description="Links shared in the summarized messages.">
        <LinkList links={result.links} />
      </Section>
    </div>
  );
}
