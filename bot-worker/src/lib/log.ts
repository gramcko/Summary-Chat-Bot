/**
 * Structured operational logs (architecture §9): one JSON object per
 * line with timestamp, service, level, event, and safe fields.
 *
 * NEVER log message content, chat/group names, credentials, API keys,
 * access tokens, phone numbers, session secrets, or the session
 * directory path (AGENTS.md). Field values passed to the logger must be
 * identifiers (JIDs, message ids), counts, codes, durations, or other
 * safe metadata only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/**
 * Builds a best-effort appender for an optional log file (LOG_FILE).
 *
 * The parent directory is created recursively ONCE, here, and every
 * failure is swallowed: the file sink is a diagnostic convenience and
 * must never crash or degrade the worker (logging stays functional on
 * stdout/stderr). The path is never logged — it is operational
 * configuration, and a path can leak deployment details.
 */
function openFileSink(filePath: string): (line: string) => void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Unusable directory: appends below will fail quietly instead.
  }
  return (line: string): void => {
    try {
      appendFileSync(filePath, line, "utf8");
    } catch {
      // Best effort only (disk full, permissions, rotated away...).
    }
  };
}

/**
 * Creates a JSON-lines logger. With `filePath` (LOG_FILE) each emitted
 * line is ALSO appended to that file, byte-identical to the console
 * line, after level filtering — so the file never contains more than
 * the process prints. Both sinks are best-effort.
 */
export function createLogger(
  service: string,
  minLevel: LogLevel = "info",
  filePath?: string,
): Logger {
  const target = filePath?.trim();
  const sink =
    target === undefined || target === "" ? null : openFileSink(target);
  return (level, event, fields) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      time: new Date().toISOString(),
      service,
      level,
      event,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (level === "debug" || level === "info") {
      process.stdout.write(line);
    } else {
      process.stderr.write(line);
    }
    sink?.(line);
  };
}

/** Logger that swallows everything (unit tests). */
export const silentLogger: Logger = () => {};
