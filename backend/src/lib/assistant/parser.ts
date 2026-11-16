import type { ContactSummary, Group } from "@summarly/contracts";
import { DEFAULT_SUMMARY_PERIOD, type AssistantPeriod } from "./period.js";

/**
 * Deterministic intent parser for the dashboard assistant (MVP).
 *
 * No AI provider is involved: the user's text is normalized, matched
 * against the KNOWN names (monitored groups and observed contacts),
 * classified by keyword sets, and the remaining words become the search
 * query. That makes every reply reproducible and testable, and keeps the
 * assistant from inventing groups, people, or periods.
 *
 * Matching rules:
 * - Case- and accent-insensitive (`NFD` + combining-mark strip), with
 *   punctuation treated as a word separator.
 * - Longest match wins: "Grupo Ventas" beats "Ventas" when both match.
 * - Ties between DIFFERENT entities of the same kind are ambiguous and
 *   ask for a clarification instead of guessing.
 * - Matched name spans are masked before intent detection, so a group
 *   called "Search Team" does not trigger the message-search intent.
 * - Contacts also match on single words of their name ("Carlos" resolves
 *   "Carlos Luis Gramcko") because people are addressed by first name in
 *   natural phrasing. Groups keep full-name matching only: generic words
 *   from a group name would match several groups at once.
 */

export type AssistantIntent =
  | "summary"
  | "contact_groups"
  | "search_messages"
  | "help";

/** One entity offered to the user when a clarification is needed. */
export interface AssistantCandidate {
  id: string;
  name: string;
}

export type AssistantParseResult =
  | { intent: "summary"; group: Group; period: AssistantPeriod }
  | { intent: "contact_groups"; contact: ContactSummary }
  | {
      intent: "search_messages";
      contact: ContactSummary;
      /** Optional scope: a single monitored group, else all of them. */
      group: Group | null;
      /** Extracted topic; null means "any recent message from this person". */
      query: string | null;
    }
  | {
      intent: "clarify";
      subject: "group" | "contact";
      /** Why the assistant is asking: no match, or several possible ones. */
      reason: "not_found" | "ambiguous";
      candidates: AssistantCandidate[];
      /** Total candidates known (candidates may be capped). */
      total: number;
    }
  | { intent: "help" };

export interface AssistantParseInput {
  text: string;
  /** MONITORED groups only — the parser never sees unmonitored ones. */
  groups: readonly Group[];
  contacts: readonly ContactSummary[];
}

/** Maximum candidates listed in a clarification (fits citation caps). */
export const MAX_CLARIFY_CANDIDATES = 20;

/** Maximum length of the extracted search query. */
const MAX_QUERY_LENGTH = 200;

/** Minimum length of a single-word contact alias ("Ana" is too short). */
const MIN_CONTACT_ALIAS_LENGTH = 3;

// ---- normalization -------------------------------------------------------

interface NormalizedText {
  /** Lowercase, accent-free, punctuation collapsed to single spaces. */
  normalized: string;
  /** normalized[i] came from text[originalIndex[i]]. */
  originalIndex: number[];
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const LETTER = /\p{L}/u;

/**
 * Normalizes text for matching while keeping a map back to the original
 * characters, so matched spans can be removed from the user's own text
 * (query extraction) without losing accents or casing.
 */
function normalizeText(text: string): NormalizedText {
  let normalized = "";
  const originalIndex: number[] = [];
  const pushSpace = (index: number): void => {
    if (normalized.length === 0) return;
    if (normalized.endsWith(" ")) return;
    normalized += " ";
    originalIndex.push(index);
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const stripped = char
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    for (const part of stripped) {
      if (WORD_CHAR.test(part)) {
        normalized += part;
        originalIndex.push(index);
      } else if (WHITESPACE.test(part)) {
        pushSpace(index);
      } else {
        // Punctuation separates words rather than gluing them together.
        pushSpace(index);
      }
    }
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    originalIndex.pop();
  }
  return { normalized, originalIndex };
}

/** Normalized form of a stored name (used as the search needle). */
function normalizeLabel(label: string): string {
  return normalizeText(label).normalized;
}

// ---- name matching -------------------------------------------------------

interface EntityMatch {
  kind: "group" | "contact";
  id: string;
  name: string;
  /** Span in normalized coordinates. */
  start: number;
  end: number;
  length: number;
}

interface NameCandidate {
  kind: "group" | "contact";
  id: string;
  name: string;
  /**
   * Extra normalized forms that resolve to this entity (single-word
   * contact aliases). The full name is always tried as well.
   */
  aliases: readonly string[];
}

/**
 * Single words of a contact name that may be used on their own.
 *
 * People are addressed by first name ("which groups does Carlos
 * participate in?") while the roster stores the full name, so every word
 * of at least `MIN_CONTACT_ALIAS_LENGTH` characters is accepted. Words
 * that are function words or intent triggers are excluded: masking one of
 * those would swallow the user's own question, and nobody is addressed
 * by "the" or "resumen". Digit-only words are excluded too, so a topic
 * like "2026" is never treated as a person.
 */
function contactAliases(name: string): string[] {
  const normalized = normalizeLabel(name);
  if (normalized === "") return [];
  const aliases = new Set<string>();
  for (const word of normalized.split(" ")) {
    if (word.length < MIN_CONTACT_ALIAS_LENGTH) continue;
    if (!LETTER.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    aliases.add(word);
  }
  return [...aliases];
}

/** Finds every whole-word occurrence of each candidate's names. */
function findMatches(
  normalized: string,
  candidates: readonly NameCandidate[],
): EntityMatch[] {
  const matches: EntityMatch[] = [];
  // One entity can be reached through several names ("Carlos" and the
  // full name); the same span must not be counted twice, or a repeated
  // mention would look like an ambiguity.
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const needles = new Set<string>([
      normalizeLabel(candidate.name),
      ...candidate.aliases,
    ]);
    for (const needle of needles) {
      if (needle === "") continue;
      let from = 0;
      for (;;) {
        const at = normalized.indexOf(needle, from);
        if (at === -1) break;
        const before = at === 0 ? undefined : normalized[at - 1];
        const after = normalized[at + needle.length];
        const boundaryBefore = before === undefined || before === " ";
        const boundaryAfter = after === undefined || after === " ";
        if (boundaryBefore && boundaryAfter) {
          const end = at + needle.length;
          const key = `${candidate.kind}|${candidate.id}|${at}|${end}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              kind: candidate.kind,
              id: candidate.id,
              name: candidate.name,
              start: at,
              end,
              length: needle.length,
            });
          }
        }
        from = at + 1;
      }
    }
  }
  return matches;
}

/**
 * Picks the longest match. A tie between different entities of the same
 * kind is ambiguous; a repeated mention of the SAME entity is not.
 */
function bestMatch(matches: readonly EntityMatch[]): {
  winner: EntityMatch | null;
  ambiguous: EntityMatch[];
} {
  if (matches.length === 0) return { winner: null, ambiguous: [] };
  const longest = matches.reduce(
    (max, match) => (match.length > max ? match.length : max),
    0,
  );
  const top = matches.filter((match) => match.length === longest);
  const distinct = new Map<string, EntityMatch>();
  for (const match of top) {
    if (!distinct.has(match.id)) distinct.set(match.id, match);
  }
  if (distinct.size === 1) {
    return { winner: top[0] ?? null, ambiguous: [] };
  }
  return { winner: null, ambiguous: [...distinct.values()] };
}

// ---- intent keywords -----------------------------------------------------

/** "which groups does X participate in" / "en qué grupos participa X". */
const CONTACT_GROUP_PATTERNS: readonly RegExp[] = [
  /\b(which|what) groups?\b/,
  /\bque grupos?\b/,
  /\bgrupos?\b.*\b(particip|pertenec|miembro|member)\b/,
  /\bparticip/,
  /\bpertenec/,
  /\bmember of\b/,
  /\bmiembro de\b/,
  /\bbelongs? to\b/,
];

/** "when did X say something about Y" / "cuándo dijo X ...". */
const SEARCH_PATTERNS: readonly RegExp[] = [
  /\bwhen did\b/,
  /\bwhen\b.*\b(said|say|says|mention(ed|s)?|wrote|write|talked|talk)\b/,
  /\bsearch\b/,
  /\bbusca(r|s|ste)?\b/,
  /\bcuando\b.*\b(dijo|dice|dijeron|hablo|hablaron|menciono|mencionaron|escribio|escribieron)\b/,
  /\b(dijo|hablo|escribio)\b.*\b(sobre|acerca)\b/,
  /\bsaid\b.*\babout\b/,
];

/** "do a summary on X group" / "resumen de X ayer". */
const SUMMARY_PATTERNS: readonly RegExp[] = [
  /\bsummar/,
  /\bresumen/,
  /\bresumir\b/,
  /\bresume\b/,
];

const PERIOD_PATTERNS: ReadonlyArray<{
  period: AssistantPeriod;
  patterns: readonly RegExp[];
}> = [
  { period: "yesterday", patterns: [/\bayer\b/, /\byesterday\b/] },
  { period: "today", patterns: [/\bhoy\b/, /\btoday\b/] },
  {
    period: "last_7d",
    patterns: [
      /\blast week\b/,
      /\besta semana\b/,
      /\bsemana pasada\b/,
      /\blast 7 days\b/,
      /\bultimos 7 dias\b/,
      /\b7 days\b/,
      /\b7 dias\b/,
    ],
  },
  {
    period: "last_24h",
    patterns: [
      /\blast 24 hours\b/,
      /\bultimas 24 horas\b/,
      /\b24 hours\b/,
      /\b24 horas\b/,
      /\blast 24h\b/,
      /\bultimo dia\b/,
    ],
  },
];

/** First index at which any pattern matches, or -1. */
function firstMatchIndex(patterns: readonly RegExp[], text: string): number {
  let earliest = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    if (earliest === -1 || match.index < earliest) earliest = match.index;
  }
  return earliest;
}

type DetectedIntent = Exclude<AssistantIntent, "help">;

/**
 * Intent = the trigger that appears EARLIEST in the message; ties fall
 * back to the declared priority. Earliest-wins keeps natural phrasing
 * working: "resumen de lo que dijo Ana" is a summary (the summary verb
 * opens the sentence) while "cuando dijo Ana el resumen" is a search.
 */
function detectIntent(masked: string): DetectedIntent | null {
  const candidates: Array<{
    intent: DetectedIntent;
    index: number;
    order: number;
  }> = [
    {
      intent: "contact_groups",
      index: firstMatchIndex(CONTACT_GROUP_PATTERNS, masked),
      order: 0,
    },
    { intent: "search_messages", index: firstMatchIndex(SEARCH_PATTERNS, masked), order: 1 },
    { intent: "summary", index: firstMatchIndex(SUMMARY_PATTERNS, masked), order: 2 },
  ];
  const detected = candidates.filter((candidate) => candidate.index >= 0);
  if (detected.length === 0) return null;
  detected.sort((a, b) => a.index - b.index || a.order - b.order);
  return detected[0]?.intent ?? null;
}

function detectPeriod(masked: string): AssistantPeriod | null {
  for (const entry of PERIOD_PATTERNS) {
    if (firstMatchIndex(entry.patterns, masked) >= 0) return entry.period;
  }
  return null;
}

// ---- query extraction ----------------------------------------------------

/**
 * Words that carry no search meaning: articles, prepositions, pronouns,
 * auxiliary/question words, the intent triggers themselves, and time or
 * domain nouns that describe the ASK rather than its topic.
 */
const STOPWORDS = new Set<string>([
  // English function words + triggers
  "a", "an", "the", "do", "does", "did", "doing", "is", "are", "was", "were",
  "be", "been", "am", "i", "you", "he", "she", "it", "we", "they", "me", "my",
  "your", "our", "their", "his", "her", "its", "this", "that", "these", "those",
  "of", "in", "on", "at", "to", "for", "from", "with", "about", "into", "over",
  "under", "and", "or", "but", "if", "then", "than", "so", "as", "by", "please",
  "thanks", "thank", "hi", "hello", "hey", "ok", "okay", "can", "could", "would",
  "should", "will", "shall", "may", "might", "must", "have", "has", "had", "any",
  "some", "all", "something", "anything", "someone", "anyone", "tell", "show",
  "find", "get", "give", "list", "know", "want", "need", "say", "says", "said",
  "saying", "mention", "mentions", "mentioned", "talk", "talks", "talked",
  "talking", "write", "writes", "wrote", "written", "when", "what", "which",
  "who", "whom", "whose", "why", "how", "where", "today", "yesterday", "week",
  "weeks", "last", "past", "hour", "hours", "day", "days", "group", "groups",
  "chat", "chats", "message", "messages", "summary", "summaries", "summarize",
  "summarise", "search", "resume", "participant", "participants", "member",
  "members", "participate", "participates", "participated", "participating",
  "belong", "belongs", "part", "recent", "recently", "latest", "newest", "24",
  "24h", "7", "7d",
  // Spanish function words + triggers
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a",
  "en", "con", "por", "para", "sobre", "acerca", "entre", "y", "o", "u", "que",
  "quien", "quienes", "cual", "cuales", "como", "cuando", "donde", "porque",
  "si", "no", "se", "su", "sus", "mi", "mis", "tu", "tus", "le", "les", "lo",
  "me", "te", "nos", "os", "es", "son", "era", "eran", "fue", "fueron", "ser",
  "estar", "esta", "este", "esto", "estas", "estos", "hay", "ha", "han", "he",
  "has", "habia", "hizo", "hacer", "haz", "dame", "dime", "muestra", "muestrame",
  "busca", "buscar", "buscame", "encuentra", "encontrar", "ver", "saber",
  "quiero", "necesito", "puede", "puedes", "podrias", "favor", "gracias", "hola",
  "buenas", "vale", "hoy", "ayer", "semana", "semanas", "ultima", "ultimas",
  "ultimo", "ultimos", "pasado", "pasada", "hora", "horas", "dia", "dias",
  "grupo", "grupos", "mensaje", "mensajes", "resumen", "resumenes", "resumir",
  "resume", "participa", "participan", "participo", "participaron",
  "participacion", "miembro", "miembros", "pertenece", "pertenecen", "parte",
  "dijo", "dijeron", "dice", "dicen", "hablo", "hablaron", "habla", "hablan",
  "escribio", "escribieron", "escribe", "escriben", "menciono", "mencionaron",
  "menciona", "mencionan",
]);

interface OriginalSpan {
  start: number;
  end: number;
}

/** Converts a normalized-coordinate span back to original text indices. */
function toOriginalSpan(
  match: EntityMatch,
  originalIndex: readonly number[],
  textLength: number,
): OriginalSpan {
  const start = originalIndex[match.start] ?? 0;
  const lastIndex = originalIndex[match.end - 1];
  const end = lastIndex === undefined ? textLength : lastIndex + 1;
  return { start, end };
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’_+-]*/gu;

/**
 * Removes the matched names and every trigger/stop word, leaving the
 * topic. Returns null when nothing meaningful remains (the caller then
 * searches all recent messages from that person).
 */
function extractQuery(
  text: string,
  spans: readonly OriginalSpan[],
): string | null {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const value = match[0] ?? "";
    if (value === "") continue;
    const start = match.index ?? 0;
    const end = start + value.length;
    const insideName = spans.some(
      (span) => start < span.end && end > span.start,
    );
    if (insideName) continue;
    const normalized = normalizeLabel(value);
    if (normalized === "" || STOPWORDS.has(normalized)) continue;
    tokens.push(value);
  }
  const query = tokens.join(" ").trim();
  if (query === "") return null;
  return query.length > MAX_QUERY_LENGTH
    ? query.slice(0, MAX_QUERY_LENGTH).trimEnd()
    : query;
}

// ---- the parser ----------------------------------------------------------

function groupCandidates(groups: readonly Group[]): AssistantCandidate[] {
  return groups
    .filter((group) => group.monitored)
    .map((group) => ({ id: group.id, name: group.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function contactCandidates(
  contacts: readonly ContactSummary[],
): AssistantCandidate[] {
  // Nameless contacts cannot be addressed by name, so they are not
  // useful clarification options.
  return contacts
    .filter((contact) => contact.name !== null)
    .map((contact) => ({ id: contact.id, name: contact.name as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function clarify(
  subject: "group" | "contact",
  candidates: readonly AssistantCandidate[],
  reason: "not_found" | "ambiguous" = "not_found",
): AssistantParseResult {
  return {
    intent: "clarify",
    subject,
    reason,
    candidates: candidates.slice(0, MAX_CLARIFY_CANDIDATES),
    total: candidates.length,
  };
}

/**
 * Parses one user message into an intent + resolved entities.
 * `clarify` is returned when the intent needs an entity that was not
 * found or that matches more than one candidate.
 */
export function parseAssistantMessage(
  input: AssistantParseInput,
): AssistantParseResult {
  const monitoredGroups = input.groups.filter((group) => group.monitored);
  const namedContacts = input.contacts.filter(
    (contact): contact is ContactSummary & { name: string } =>
      contact.name !== null,
  );
  const text = input.text;
  const { normalized, originalIndex } = normalizeText(text);

  const nameCandidates: NameCandidate[] = [
    // Groups match by full name only: a generic word ("Grupo", "Ventas")
    // taken from a group name would make several groups ambiguous.
    ...monitoredGroups.map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      aliases: [],
    })),
    ...namedContacts.map((contact) => ({
      kind: "contact" as const,
      id: contact.id,
      name: contact.name,
      aliases: contactAliases(contact.name),
    })),
  ];
  const matches = findMatches(normalized, nameCandidates);
  const groupMatch = bestMatch(
    matches.filter((match) => match.kind === "group"),
  );
  const contactMatch = bestMatch(
    matches.filter((match) => match.kind === "contact"),
  );

  // Mask every matched name before intent/period detection so names that
  // happen to contain trigger words ("Search Team") cannot skew it.
  let masked = normalized;
  for (const match of matches) {
    masked =
      masked.slice(0, match.start) +
      " ".repeat(match.end - match.start) +
      masked.slice(match.end);
  }

  const intent = detectIntent(masked);
  if (intent === null) return { intent: "help" };

  const groupById = new Map(monitoredGroups.map((group) => [group.id, group]));
  const contactById = new Map(namedContacts.map((contact) => [contact.id, contact]));

  if (intent === "summary") {
    if (groupMatch.ambiguous.length > 0) {
      return clarify(
        "group",
        groupMatch.ambiguous.map((match) => ({ id: match.id, name: match.name })),
        "ambiguous",
      );
    }
    const group =
      groupMatch.winner === null ? undefined : groupById.get(groupMatch.winner.id);
    if (group === undefined) {
      return clarify("group", groupCandidates(monitoredGroups));
    }
    return {
      intent: "summary",
      group,
      period: detectPeriod(masked) ?? DEFAULT_SUMMARY_PERIOD,
    };
  }

  if (contactMatch.ambiguous.length > 0) {
    return clarify(
      "contact",
      contactMatch.ambiguous.map((match) => ({ id: match.id, name: match.name })),
      "ambiguous",
    );
  }
  const contact =
    contactMatch.winner === null
      ? undefined
      : contactById.get(contactMatch.winner.id);
  if (contact === undefined) {
    return clarify("contact", contactCandidates(input.contacts));
  }

  if (intent === "contact_groups") {
    return { intent: "contact_groups", contact };
  }

  // search_messages
  if (groupMatch.ambiguous.length > 0) {
    return clarify(
      "group",
      groupMatch.ambiguous.map((match) => ({ id: match.id, name: match.name })),
      "ambiguous",
    );
  }
  const group =
    groupMatch.winner === null ? null : (groupById.get(groupMatch.winner.id) ?? null);
  const spans = matches.map((match) =>
    toOriginalSpan(match, originalIndex, text.length),
  );
  return {
    intent: "search_messages",
    contact,
    group,
    query: extractQuery(text, spans),
  };
}
