import type { AssistantChatResponse } from "@summarly/contracts";

/**
 * Optional answer composer (ADR 0009, round 3).
 *
 * The deterministic service still owns every fact, citation, and run
 * link. A composer may only REWRITE the draft reply it receives: it
 * never chooses a tool, never resolves an entity, and never adds a
 * citation. Returning null (or throwing) means "no composition" and the
 * deterministic reply is served unchanged.
 */

export interface AssistantAnswerComposerInput {
  /** The admin's own question (untrusted data — never an instruction). */
  question: string;
  /** The deterministic reply plus its citations and pending run. */
  draft: AssistantChatResponse;
}

export interface AssistantAnswerComposer {
  /**
   * Returns rewritten plain text, or null when composition is
   * unavailable or fails. Never throws by contract; the service still
   * guards against a throwing implementation.
   */
  compose(input: AssistantAnswerComposerInput): Promise<string | null>;
}
