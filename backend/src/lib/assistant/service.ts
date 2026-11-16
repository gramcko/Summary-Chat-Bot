import {
  AssistantChatResponse,
  type AssistantChatRequest,
  type ContactSummary,
  type Group,
} from "@summarly/contracts";
import type { SummaryEnqueuer } from "../enqueue.js";
import type { Store } from "../store.js";
import type { AssistantAnswerComposer } from "./answer-composer.js";
import { parseAssistantMessage, type AssistantParseResult } from "./parser.js";
import {
  DEFAULT_SUMMARY_PERIOD,
  describePeriod,
  periodToInterval,
  type AssistantPeriod,
} from "./period.js";
import type { AssistantPlan, AssistantPlanner } from "./planner.js";

/**
 * Dashboard assistant service.
 *
 * Resolves the user's message against the store and produces a reply
 * plus citations. Group/contact resolution, citations, and the pending
 * run id are always deterministic: an optional planner (the Gemini
 * classifier) may only CHOOSE the tool and the candidate names, and its
 * plan is validated against the same monitored data before use. An
 * optional answer composer (the Gemini rewriter) may only REWRITE the
 * reply text; every failure keeps the deterministic draft. The service
 * never accepts an entity id from the client: groups and contacts are
 * resolved by NAME against monitored data, so an unmonitored group can
 * neither be summarized nor searched.
 *
 * Logging rule: only intent names, planner/answer sources, tool names,
 * counts, and durations — never message bodies, names, JIDs, or reply
 * text.
 */

/** The store surface the assistant needs (narrow for testability). */
export type AssistantStore = Pick<
  Store,
  "listGroups" | "listContacts" | "getContact" | "createOrFindRun" | "searchMessages"
>;

export type AssistantLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

export interface AssistantServiceOptions {
  store: AssistantStore;
  /** Best-effort queue producer, same contract as routes/runs.ts. */
  enqueue: SummaryEnqueuer;
  /** Clock seam for deterministic tests. */
  now?: () => Date;
  log?: AssistantLogger;
  /**
   * Optional planner (the Gemini classifier). It only selects a tool and
   * candidate names; a null plan, an error, or an unknown name falls back
   * to the deterministic parser. Unset = parser only.
   */
  planner?: AssistantPlanner;
  /**
   * Optional answer composer (the Gemini rewriter). It only rewrites the
   * deterministic reply text for the data-backed intents; citations and
   * the pending run id always come from the deterministic tools. A null
   * result, an error, or an empty/over-long answer keeps the draft.
   * Unset = template replies only.
   */
  answerComposer?: AssistantAnswerComposer;
}

/** Which component chose the tool for this turn (safe log field). */
export type AssistantPlannerSource = "gemini" | "heuristic";

/** Which component wrote the reply text for this turn (safe log field). */
export type AssistantAnswerSource = "gemini" | "template";

/** Intents whose reply text may be rewritten by the composer. */
const COMPOSABLE_INTENTS: ReadonlySet<string> = new Set([
  "summary",
  "contact_groups",
  "search_messages",
]);

/** The published reply cap (`AssistantChatResponse.reply.max`). */
const MAX_REPLY_CHARS = 8000;

/** Maximum search hits quoted in one reply (and cited). */
export const MAX_SEARCH_HITS = 10;

/** Maximum groups/messages listed in one reply (fits the 20-citation cap). */
const MAX_LISTED = 20;

/** Maximum characters quoted from one message body. */
const MAX_EXCERPT = 140;

function displayName(contact: ContactSummary): string {
  return contact.name ?? contact.phone ?? contact.id;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(no text)";
  if (collapsed.length <= MAX_EXCERPT) return collapsed;
  return `${collapsed.slice(0, MAX_EXCERPT - 1).trimEnd()}…`;
}

function formatTimestamp(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    // A bad group timezone must not break the reply.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}

function helpReply(): AssistantChatResponse {
  return {
    reply: [
      "I can help with three things:",
      '- Summary: "do a summary on <group> today" (also yesterday, last 24 hours, or last week).',
      '- Group membership: "which groups does <contact> participate in?"',
      '- Message search: "when did <contact> say something about <topic>?"',
      "",
      "I only use monitored groups and the messages captured from them.",
    ].join("\n"),
    citations: [],
    pendingRunId: null,
  };
}

/** Trimmed plan field; empty and null both mean "not provided". */
function planValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Exact case-insensitive name resolution. Zero or several matches resolve
 * to null (the caller falls back to the parser, which can ask a
 * clarification); a plan never guesses between candidates.
 */
function matchGroupName(
  groups: readonly Group[],
  name: string,
): Group | null {
  const needle = name.trim().toLowerCase();
  const matches = groups.filter(
    (group) => group.monitored && group.name.trim().toLowerCase() === needle,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function matchContactName(
  contacts: readonly ContactSummary[],
  name: string,
): ContactSummary | null {
  const needle = name.trim().toLowerCase();
  const matches = contacts.filter(
    (contact) =>
      contact.name !== null &&
      contact.name.trim().toLowerCase() === needle,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Turns a validated planner plan into the parser's own result shape, or
 * null when the plan cannot be executed as written (missing/unknown/
 * ambiguous name). Null means "use the deterministic parser": an AI plan
 * can only ever choose among data the admin can already see, never widen
 * the boundary or trigger a clarification-free guess.
 */
export function resolveAssistantPlan(
  plan: AssistantPlan,
  groups: readonly Group[],
  contacts: readonly ContactSummary[],
): AssistantParseResult | null {
  if (plan.intent === "help") return { intent: "help" };

  const groupName = planValue(plan.groupName);
  const contactName = planValue(plan.contactName);

  if (plan.intent === "summary") {
    if (groupName === null) return null;
    const group = matchGroupName(groups, groupName);
    if (group === null) return null;
    return {
      intent: "summary",
      group,
      period: plan.period ?? DEFAULT_SUMMARY_PERIOD,
    };
  }

  if (contactName === null) return null;
  const contact = matchContactName(contacts, contactName);
  if (contact === null) return null;

  if (plan.intent === "contact_groups") {
    return { intent: "contact_groups", contact };
  }

  // search_messages: the group scope is optional, but a NAMED group must
  // resolve exactly — an unknown scope is not silently widened.
  let group: Group | null = null;
  if (groupName !== null) {
    group = matchGroupName(groups, groupName);
    if (group === null) return null;
  }
  return {
    intent: "search_messages",
    contact,
    group,
    query: planValue(plan.query),
  };
}

export class AssistantService {
  private readonly store: AssistantStore;
  private readonly enqueue: SummaryEnqueuer;
  private readonly now: () => Date;
  private readonly log: AssistantLogger | undefined;
  private readonly planner: AssistantPlanner | undefined;
  private readonly answerComposer: AssistantAnswerComposer | undefined;

  constructor(options: AssistantServiceOptions) {
    this.store = options.store;
    this.enqueue = options.enqueue;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.planner = options.planner;
    this.answerComposer = options.answerComposer;
  }

  /** Answers one chat request (the last user turn drives the reply). */
  async chat(request: AssistantChatRequest): Promise<AssistantChatResponse> {
    const started = Date.now();
    const lastUser = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");

    let response: AssistantChatResponse;
    let intent: string;
    let plannerSource: AssistantPlannerSource = "heuristic";
    if (lastUser === undefined) {
      intent = "help";
      response = helpReply();
    } else {
      const [allGroups, contacts] = await Promise.all([
        this.store.listGroups(),
        this.store.listContacts(),
      ]);
      // The privacy boundary: the assistant only ever sees monitored
      // groups (and the store derives contacts from monitored rosters).
      const groups = allGroups.filter((group) => group.monitored);
      const resolution = await this.resolveIntent(
        lastUser.content,
        groups,
        contacts,
      );
      intent = resolution.parsed.intent;
      plannerSource = resolution.source;
      response = await this.respond(resolution.parsed, groups);
      if (
        this.answerComposer !== undefined &&
        COMPOSABLE_INTENTS.has(intent)
      ) {
        response = await this.composeAnswer(lastUser.content, response, intent);
      }
    }

    this.log?.("assistant_chat", {
      intent,
      plannerSource,
      citationCount: response.citations.length,
      durationMs: Date.now() - started,
    });
    // Validated before leaving the service: a reply can never violate
    // the published contract (length caps, citation caps).
    return AssistantChatResponse.parse(response);
  }

  /**
   * Planner first, deterministic parser as the safety net. The planner
   * can only produce a plan that resolves exactly against monitored
   * names; a null plan, a planner error, or an unresolvable name all
   * fall back to `parseAssistantMessage` (never a thrown error).
   */
  private async resolveIntent(
    text: string,
    groups: readonly Group[],
    contacts: readonly ContactSummary[],
  ): Promise<{
    parsed: AssistantParseResult;
    source: AssistantPlannerSource;
  }> {
    const heuristic = (): {
      parsed: AssistantParseResult;
      source: AssistantPlannerSource;
    } => ({
      parsed: parseAssistantMessage({ text, groups, contacts }),
      source: "heuristic",
    });

    if (this.planner === undefined) return heuristic();

    let plan: AssistantPlan | null;
    try {
      plan = await this.planner.plan({ text, groups, contacts });
    } catch (error) {
      // Error TYPE only: messages can carry provider text.
      this.log?.("assistant_planner_failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
      return heuristic();
    }
    if (plan === null) return heuristic();

    const parsed = resolveAssistantPlan(plan, groups, contacts);
    return parsed === null ? heuristic() : { parsed, source: "gemini" };
  }

  /**
   * Optional rewrite of the deterministic reply (ADR 0009, round 3).
   *
   * The composer receives the question and the complete draft, and may
   * only return replacement TEXT. Citations and the pending run id are
   * taken from the draft, so a model can never widen the evidence. Every
   * failure (null, throw, empty, over-long) keeps the draft; a summary
   * reply always keeps its run link, even when the model drops it.
   *
   * Logging: `assistant_answer` carries the source, duration, and a safe
   * reason — never the question, draft, or composed text.
   */
  private async composeAnswer(
    question: string,
    draft: AssistantChatResponse,
    intent: string,
  ): Promise<AssistantChatResponse> {
    const composer = this.answerComposer;
    if (composer === undefined) return draft;

    const started = Date.now();
    let composed: string | null = null;
    let fallbackReason: string | null = null;
    try {
      composed = await composer.compose({ question, draft });
    } catch (error) {
      // Error TYPE only: messages can carry provider text.
      fallbackReason = error instanceof Error ? error.name : "unknown";
    }

    const text = composed?.trim() ?? "";
    if (text === "" || text.length > MAX_REPLY_CHARS) {
      // `null` means "composition unavailable" (unconfigured, failed, or
      // model error); a blank string is a different, safe-to-report case.
      const reason =
        fallbackReason ??
        (composed === null ? "unavailable" : text === "" ? "empty" : "invalid");
      this.log?.("assistant_answer", {
        source: "template",
        durationMs: Date.now() - started,
        fallbackReason: reason,
      });
      return draft;
    }

    let reply = text;
    if (intent === "summary" && draft.pendingRunId !== null) {
      const link = `/runs/${draft.pendingRunId}`;
      if (!reply.includes(link)) reply = `${reply}\n\nOpen the run: ${link}`;
    }
    // The link append must never push the answer past the published cap;
    // the deterministic draft (which carries the link) is the fallback.
    if (reply.length > MAX_REPLY_CHARS) {
      this.log?.("assistant_answer", {
        source: "template",
        durationMs: Date.now() - started,
        fallbackReason: "invalid",
      });
      return draft;
    }

    this.log?.("assistant_answer", {
      source: "gemini",
      durationMs: Date.now() - started,
      fallbackReason: null,
    });
    return { ...draft, reply };
  }

  private async respond(
    parsed: AssistantParseResult,
    groups: readonly Group[],
  ): Promise<AssistantChatResponse> {
    switch (parsed.intent) {
      case "summary":
        return this.handleSummary(parsed.group, parsed.period);
      case "contact_groups":
        return this.handleContactGroups(parsed.contact);
      case "search_messages":
        return this.handleSearch(parsed.contact, parsed.group, parsed.query, groups);
      case "clarify":
        return this.handleClarify(parsed);
      case "help":
        return helpReply();
    }
  }

  /**
   * Durable run first, then best-effort enqueue (architecture A6): a
   * queue outage leaves the run `pending` and the reconciliation pass
   * re-enqueues it, so the reply stays successful but honest.
   */
  private async handleSummary(
    group: Group,
    period: AssistantPeriod,
  ): Promise<AssistantChatResponse> {
    const interval = periodToInterval(period, group.timezone, this.now());
    const { run } = await this.store.createOrFindRun({
      groupId: group.id,
      interval,
      kind: "manual",
      instructions: null,
    });

    let enqueueFailed = false;
    if (run.status === "pending" || run.status === "processing") {
      try {
        await this.enqueue.enqueueSummaryRun(run.id);
      } catch (error) {
        enqueueFailed = true;
        this.log?.("assistant_enqueue_failed", {
          summaryRunId: run.id,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }

    const coverage = `${describePeriod(period)} (${interval.timezone})`;
    const link = `/runs/${run.id}`;
    let reply: string;
    if (run.status === "completed") {
      reply =
        `A summary for “${group.name}” covering ${coverage} already exists. ` +
        `Read it at ${link}.`;
    } else if (run.status === "failed") {
      reply =
        `The last summary run for “${group.name}” covering ${coverage} failed. ` +
        `Retry it at ${link}.`;
    } else {
      reply =
        `Queued a summary for “${group.name}” covering ${coverage}. ` +
        `Follow it at ${link}.`;
      if (enqueueFailed) {
        reply +=
          "\nThe queue is temporarily unavailable, so the run stays pending " +
          "and will be retried automatically.";
      }
    }

    return {
      reply,
      citations: [
        {
          kind: "run",
          groupId: group.id,
          groupName: group.name,
          messageId: null,
          runId: run.id,
          sentAt: null,
        },
      ],
      pendingRunId: run.id,
    };
  }

  private async handleContactGroups(
    matched: ContactSummary,
  ): Promise<AssistantChatResponse> {
    // Re-read for aliases/freshness; a roster refresh may have removed
    // the contact between the list and this call.
    const contact = await this.store.getContact(matched.id);
    if (contact === undefined) {
      return {
        reply:
          "I can't find that contact on any monitored group's roster anymore.",
        citations: [],
        pendingRunId: null,
      };
    }
    const name = displayName(contact);
    if (contact.groups.length === 0) {
      return {
        reply: `${name} is not an active member of any monitored group.`,
        citations: [],
        pendingRunId: null,
      };
    }
    const shown = contact.groups.slice(0, MAX_LISTED);
    const extra =
      contact.groups.length > shown.length
        ? `\n…and ${contact.groups.length - shown.length} more.`
        : "";
    return {
      reply:
        `${name} participates in ${contact.groups.length} monitored ` +
        `${plural(contact.groups.length, "group", "groups")}:\n` +
        shown.map((group) => `- ${group.name}`).join("\n") +
        extra,
      citations: shown.map((group) => ({
        kind: "group" as const,
        groupId: group.id,
        groupName: group.name,
        messageId: null,
        runId: null,
        sentAt: null,
      })),
      pendingRunId: null,
    };
  }

  private async handleSearch(
    matched: ContactSummary,
    group: Group | null,
    query: string | null,
    groups: readonly Group[],
  ): Promise<AssistantChatResponse> {
    const contact = await this.store.getContact(matched.id);
    if (contact === undefined) {
      return {
        reply:
          "I can't find that contact on any monitored group's roster anymore.",
        citations: [],
        pendingRunId: null,
      };
    }
    const hits = await this.store.searchMessages({
      groupId: group?.id,
      senderAliases: contact.aliases,
      text: query ?? undefined,
      limit: MAX_SEARCH_HITS,
    });

    const name = displayName(contact);
    const scope = group === null ? "" : ` in “${group.name}”`;
    const topic = query === null ? "" : ` about “${query}”`;

    if (hits.length === 0) {
      return {
        reply: `I found no messages from ${name}${scope}${topic}.`,
        citations: [],
        pendingRunId: null,
      };
    }

    const timeZoneByGroup = new Map(
      groups.map((candidate) => [candidate.id, candidate.timezone]),
    );
    const order = query === null ? "most recent" : "most relevant";
    const lines = hits.map(
      (hit) =>
        `- ${formatTimestamp(hit.sentAt, timeZoneByGroup.get(hit.groupId) ?? "UTC")} ` +
        `· ${hit.groupName}: “${excerpt(hit.body)}”`,
    );

    return {
      reply:
        `Showing the ${hits.length} ${order} ${plural(hits.length, "message", "messages")} ` +
        `from ${name}${scope}${topic}:\n` +
        `${lines.join("\n")}\n\n` +
        "Times use each group's local time zone.",
      citations: hits.map((hit) => ({
        kind: "message" as const,
        groupId: hit.groupId,
        groupName: hit.groupName,
        messageId: hit.id,
        runId: null,
        sentAt: hit.sentAt,
      })),
      pendingRunId: null,
    };
  }

  private handleClarify(
    parsed: Extract<AssistantParseResult, { intent: "clarify" }>,
  ): AssistantChatResponse {
    const noun = parsed.subject;
    if (parsed.candidates.length === 0) {
      return {
        reply:
          parsed.subject === "group"
            ? "I couldn't match a group in your message, and no monitored " +
              "groups are available yet. Monitor a group on the Groups page first."
            : "I couldn't match a contact in your message. Contacts come from " +
              "the rosters of monitored groups; try naming one of those people.",
        citations: [],
        pendingRunId: null,
      };
    }
    const intro =
      parsed.reason === "ambiguous"
        ? `More than one ${noun} matches your message. Which one did you mean?`
        : `I couldn't match a ${noun} in your message. I know about:`;
    const extra =
      parsed.total > parsed.candidates.length
        ? `\n…and ${parsed.total - parsed.candidates.length} more.`
        : "";
    return {
      reply:
        `${intro}\n` +
        parsed.candidates.map((candidate) => `- ${candidate.name}`).join("\n") +
        extra,
      citations:
        parsed.subject === "group"
          ? parsed.candidates.map((candidate) => ({
              kind: "group" as const,
              groupId: candidate.id,
              groupName: candidate.name,
              messageId: null,
              runId: null,
              sentAt: null,
            }))
          : [],
      pendingRunId: null,
    };
  }
}
