"use client";

import type {
  AssistantChatRequest,
  AssistantCitation,
  AssistantTurn,
  DateFormat,
} from "@summarly/contracts";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useAppDateFormat, useAppTimeZone } from "@/components/TimeZoneProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/States";
import { api, toApiError, type ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/time";

/**
 * Contract limit for `AssistantChatRequest.messages` (1..20 turns). The
 * transcript is unbounded, so only the most recent turns are sent.
 */
const MAX_TURNS = 20;

/** Contract limit for a single turn's content (`AssistantTurn.content`). */
const MAX_CONTENT_LENGTH = 4000;

const SUGGESTED_PROMPTS = [
  "Summarize Grupo prueba today",
  "Which groups does Carlos participate in?",
  "When did Carlos mention the invoice?",
] as const;

interface ChatMessage {
  /** Local React key only; never sent to the API. */
  id: string;
  role: AssistantTurn["role"];
  content: string;
  citations: AssistantCitation[];
  pendingRunId: string | null;
}

function citationHref(citation: AssistantCitation): string {
  if (citation.kind === "run" && citation.runId !== null) {
    return `/runs/${encodeURIComponent(citation.runId)}`;
  }
  if (citation.kind === "message") {
    return `/groups/${encodeURIComponent(citation.groupId)}?tab=messages`;
  }
  return `/groups/${encodeURIComponent(citation.groupId)}`;
}

function citationLabel(citation: AssistantCitation): string {
  if (citation.kind === "run") return `Summary run · ${citation.groupName}`;
  if (citation.kind === "message") return `Message · ${citation.groupName}`;
  return `Group · ${citation.groupName}`;
}

function citationKey(citation: AssistantCitation, index: number): string {
  return [
    citation.kind,
    citation.groupId,
    citation.messageId ?? citation.runId ?? String(index),
  ].join(":");
}

interface MessageBubbleProps {
  message: ChatMessage;
  timeZone: string;
  dateFormat: DateFormat;
}

function MessageBubble({ message, timeZone, dateFormat }: MessageBubbleProps) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-2xl border px-3.5 py-2.5 text-sm sm:max-w-[80%] ${
          isUser
            ? "border-brand-200 bg-brand-50 text-slate-900"
            : "border-slate-200 bg-white text-slate-800"
        }`}
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          {isUser ? "You" : "Assistant"}
        </p>
        <p className="mt-1 whitespace-pre-line break-words leading-6">
          {message.content}
        </p>

        {message.citations.length === 0 ? null : (
          <div className="mt-3 border-t border-slate-200 pt-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Sources
            </p>
            <ul className="mt-1 space-y-1">
              {message.citations.map((citation, index) => (
                <li key={citationKey(citation, index)} className="text-xs">
                  <Link
                    href={citationHref(citation)}
                    className="font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                  >
                    {citationLabel(citation)}
                  </Link>
                  {citation.sentAt === null ? null : (
                    <span className="ml-1.5 text-slate-500">
                      {formatDateTime(citation.sentAt, timeZone, dateFormat)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {message.pendingRunId === null ? null : (
          <p className="mt-2 text-xs">
            <Link
              href={`/runs/${encodeURIComponent(message.pendingRunId)}`}
              className="font-semibold text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              Open run
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Browser-only chat over the deterministic backend assistant.
 *
 * The conversation lives in component state: nothing is persisted, so a
 * reload starts a fresh transcript. At most `MAX_TURNS` recent turns are
 * sent with each request (the contract's upper bound).
 */
export function AssistantChat() {
  const timeZone = useAppTimeZone();
  const dateFormat = useAppDateFormat();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  /** Synchronous guard: state updates lag behind a fast double submit. */
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const inputId = useId();
  const suggestionsId = useId();
  const hintId = `${inputId}-hint`;

  const lastMessage =
    messages.length === 0 ? null : (messages[messages.length - 1] ?? null);
  const canRetry = !sending && lastMessage?.role === "user";
  const canClear = !sending && (messages.length > 0 || error !== null);
  // Announced through the polite live region below (never the whole transcript).
  const statusText = sending
    ? "Thinking…"
    : lastMessage?.role === "assistant"
      ? "Assistant replied."
      : "";

  // Keep the newest turn in view as the transcript grows.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [messages, sending]);

  function nextId(): string {
    sequence.current += 1;
    return `turn-${sequence.current}`;
  }

  async function requestReply(conversation: readonly ChatMessage[]): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);

    const body: AssistantChatRequest = {
      messages: conversation.slice(-MAX_TURNS).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };

    try {
      const response = await api.assistantChat(body);
      setMessages((previous) => [
        ...previous,
        {
          id: nextId(),
          role: "assistant",
          content: response.reply,
          citations: response.citations,
          pendingRunId: response.pendingRunId,
        },
      ]);
    } catch (cause) {
      // The user turn stays in the transcript so it can be retried.
      setError(toApiError(cause));
    } finally {
      inFlight.current = false;
      setSending(false);
      inputRef.current?.focus();
    }
  }

  /** Appends a user turn and asks for a reply (shared by input and prompts). */
  function submit(content: string): void {
    if (inFlight.current) return;
    const trimmed = content.trim();
    if (trimmed === "") return;

    const conversation: ChatMessage[] = [
      ...messages,
      {
        id: nextId(),
        role: "user",
        content: trimmed,
        citations: [],
        pendingRunId: null,
      },
    ];
    setMessages(conversation);
    setError(null);
    void requestReply(conversation);
  }

  function handleSend(): void {
    if (inFlight.current || input.trim() === "") return;
    submit(input);
    setInput("");
    inputRef.current?.focus();
  }

  function handleRetry(): void {
    if (inFlight.current || lastMessage?.role !== "user") return;
    void requestReply(messages);
  }

  function handleClear(): void {
    if (inFlight.current) return;
    setMessages([]);
    setInput("");
    setError(null);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    // An Enter that confirms an IME candidate must not send the message.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSend();
  }

  return (
    <Card>
      <CardHeader
        title="Ask the assistant"
        description="Answers use only monitored groups, captured messages, and completed summaries."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={!canClear}
          >
            Clear chat
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <div>
          <p
            id={suggestionsId}
            className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"
          >
            Suggested prompts
          </p>
          <div
            role="group"
            aria-labelledby={suggestionsId}
            className="mt-2 flex flex-wrap gap-2"
          >
            {SUGGESTED_PROMPTS.map((prompt) => (
              <Button
                key={prompt}
                variant="secondary"
                size="sm"
                onClick={() => submit(prompt)}
                disabled={sending}
              >
                {prompt}
              </Button>
            ))}
          </div>
        </div>

        <div
          ref={transcriptRef}
          className="max-h-[26rem] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4"
        >
          {messages.length === 0 && !sending ? (
            <EmptyState
              title="No messages yet"
              description="Try a suggested prompt or ask your own question below."
            />
          ) : (
            <ol aria-label="Conversation" className="space-y-3">
              {messages.map((message) => (
                <li key={message.id}>
                  <MessageBubble
                    message={message}
                    timeZone={timeZone}
                    dateFormat={dateFormat}
                  />
                </li>
              ))}
              {sending ? (
                <li className="flex items-center gap-2 px-1 text-sm text-slate-500">
                  <Spinner className="h-4 w-4" />
                  <span>Thinking…</span>
                </li>
              ) : null}
            </ol>
          )}
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {statusText}
        </p>

        {error === null ? null : (
          <Alert tone="error" title="Could not send the message">
            <p>{error.message}</p>
            {canRetry ? (
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={handleRetry}>
                  Try again
                </Button>
              </div>
            ) : null}
          </Alert>
        )}

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSend();
          }}
          className="space-y-2"
        >
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-slate-800"
          >
            Message
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            maxLength={MAX_CONTENT_LENGTH}
            placeholder="Ask about a group, a person, or a message…"
            aria-describedby={hintId}
            className="block w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p id={hintId} className="text-xs text-slate-500">
              Enter sends · Shift+Enter adds a new line · {input.length} /{" "}
              {MAX_CONTENT_LENGTH}
            </p>
            <Button
              type="submit"
              loading={sending}
              disabled={sending || input.trim() === ""}
            >
              Send
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
