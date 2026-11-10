import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_HISTORY_IMPORT_BUDGETS,
  HISTORY_IMPORT_BOUNDS,
  validateHistoryImportBudgets,
} from "./history-import.js";
import { isLogLevel, type LogLevel } from "./lib/log.js";
import type { HistorySyncMode } from "./whatsapp/adapter.js";

/**
 * Configuration for the bot-worker service (architecture §4.3, ADR
 * 0004). Everything is validated at the boundary and the service fails
 * fast on invalid or missing configuration.
 *
 * PRIVACY: the resolved session directory path must NEVER be written to
 * logs, APIs, or error output (AGENTS.md / ADR 0004) — error messages
 * from this module deliberately omit it and carry only the variable
 * name and an fs error code.
 *
 * SESSION STORAGE SAFETY (audit M1/M2, CR-m3): the session directory
 * holds account credentials and must not live inside the repository
 * working tree (commit/serve/backup exposure). In-tree locations are
 * refused unless WA_SESSION_ALLOW_INSECURE=yes is set EXPLICITLY (the
 * documented development escape hatch). Permission hardening is
 * verified, not assumed: owner-only mode on POSIX, refused on Windows
 * (NTFS ACLs cannot be verified here — the operator's responsibility)
 * unless explicitly acknowledged the same way.
 */

/** Capped exponential backoff for reconnect attempts (ADR 0004). */
export interface BackoffPolicy {
  /** Delay before the first reconnect attempt. */
  baseMs: number;
  /** Upper bound for any single delay. */
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };

export interface BotConfig {
  /** PostgreSQL connection string (required). */
  databaseUrl: string;
  /**
   * Absolute path of the WhatsApp session-state directory (protected;
   * never logged).
   */
  sessionDir: string;
  /** IANA time zone assigned to newly discovered groups. Default "UTC". */
  defaultTimezone: string;
  /** E.164 digits for pairing-code linking; null = terminal QR linking. */
  phoneNumber: string | null;
  /**
   * Explicit development escape hatch (WA_SESSION_ALLOW_INSECURE=yes):
   * allows session storage that fails the safety checks (inside the
   * repository working tree, or permission checks that cannot pass).
   */
  allowInsecureSessionStorage: boolean;
  /**
   * Opt-in egress (WA_CHECK_UPDATES=yes): fetch the Baileys version
   * manifest at connect time instead of using the bundled version.
   */
  checkForUpdates: boolean;
  /**
   * Linking display policy (WA_LINKING_DISPLAY): "tty" renders the QR /
   * pairing code only on an interactive terminal (the default); "none"
   * never renders it (log-safe: linking material must never reach log
   * pipelines).
   */
  linkingDisplay: "tty" | "none";
  /** History-import budget knobs (ADR 0007); bounded best-effort. */
  historyImport: HistoryImportSettings;
  /**
   * Connect-time history policy (WA_HISTORY_SYNC): "off" (privacy-first,
   * default), "recent" (let the initial sync complete but drop it), or
   * "full" (capture initial/full history for monitored groups).
   */
  historySyncMode: HistorySyncMode;
  /**
   * Session-control poll interval (SESSION_CONTROL_POLL_MS, default
   * 3000, floor 1000): how often the admin logout flag is checked.
   */
  sessionControlPollMs: number;
  logLevel: LogLevel;
  backoff: BackoffPolicy;
}

/**
 * History-import knobs from the environment (ADR 0007). The import is
 * BOUNDED best-effort: WhatsApp decides what history it returns and the
 * import is partial by design. The remaining budget internals (round
 * timeout, settle window, stale threshold) live in
 * `history-import.ts`'s DEFAULT_HISTORY_IMPORT_BUDGETS.
 */
export interface HistoryImportSettings {
  /** Poll interval for pending imports (floor 1000). */
  pollMs: number;
  /** Messages requested per round. */
  batchCount: number;
  /** Maximum request rounds per import. */
  maxRounds: number;
  /** Maximum messages collected per import. */
  maxMessages: number;
  /** Wall-clock budget per import, milliseconds. */
  timeBudgetMs: number;
}

/** A configuration problem with an actionable, safe message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Finds the repository root by walking up from `start` until a
 * package.json with a "workspaces" field is found (the npm-workspaces
 * root). Returns null when run outside the repository.
 */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined) return dir;
      } catch {
        // Unreadable package.json: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `candidate` is `root` itself or lives below it. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Normalizes a phone number to bare E.164 digits (no "+"). */
function normalizePhoneNumber(raw: string): string {
  return raw.trim().replace(/[\s\-().]/g, "").replace(/^\+/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const databaseUrl = env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new ConfigError(
      "DATABASE_URL is required. Copy .env.example to .env at the repository " +
        "root (it is loaded automatically) or export it in the environment " +
        "(docker-compose.dev.yml provides a local PostgreSQL).",
    );
  }

  const allowInsecureSessionStorage = env["WA_SESSION_ALLOW_INSECURE"] === "yes";

  // ---- WhatsApp session storage (protected; ADR 0004) ----
  // Relative values resolve against the REPOSITORY ROOT (never against
  // process.cwd(), which is a package directory under npm scripts —
  // CR-m3). The default is <repo root>/wa-session.
  const repoRoot = findRepoRoot();
  const sessionDirRaw = env["WA_SESSION_DIR"]?.trim();
  let sessionDir: string;
  if (sessionDirRaw !== undefined && sessionDirRaw !== "") {
    sessionDir = isAbsolute(sessionDirRaw)
      ? resolve(sessionDirRaw)
      : resolve(repoRoot ?? process.cwd(), sessionDirRaw);
  } else {
    sessionDir = join(repoRoot ?? process.cwd(), "wa-session");
  }

  // Containment check (audit M1): session credentials must not live
  // inside the repository working tree (commit / static-serve / backup
  // exposure). The documented dev default is inside the tree and needs
  // the explicit escape hatch.
  if (
    repoRoot !== null &&
    isInsideRoot(sessionDir, repoRoot) &&
    !allowInsecureSessionStorage
  ) {
    throw new ConfigError(
      "the WhatsApp session directory resolves INSIDE the repository working " +
        "tree, where it could be committed, served, or backed up with the " +
        "source. Point WA_SESSION_DIR at a directory outside the repository " +
        "(a protected volume in deployments) or set WA_SESSION_ALLOW_INSECURE=yes " +
        "to acknowledge the risk (development only). The path is never logged, " +
        "so it is not shown here.",
    );
  }

  const defaultTimezone = env["DEFAULT_GROUP_TIMEZONE"]?.trim() || "UTC";
  if (!isValidTimeZone(defaultTimezone)) {
    throw new ConfigError(
      `DEFAULT_GROUP_TIMEZONE "${defaultTimezone}" is not a valid IANA time zone ` +
        '(for example "UTC" or "Europe/Madrid").',
    );
  }

  let phoneNumber: string | null = null;
  const rawPhone = env["WA_PHONE_NUMBER"]?.trim();
  if (rawPhone !== undefined && rawPhone !== "") {
    phoneNumber = normalizePhoneNumber(rawPhone);
    if (!/^\d{7,15}$/.test(phoneNumber)) {
      throw new ConfigError(
        "WA_PHONE_NUMBER must be a phone number in international format " +
          "(E.164 digits, a leading + is allowed), for example +34600111222.",
      );
    }
  }

  const checkForUpdates = env["WA_CHECK_UPDATES"] === "yes";

  const rawDisplay = env["WA_LINKING_DISPLAY"]?.trim() || "tty";
  if (rawDisplay !== "tty" && rawDisplay !== "none") {
    throw new ConfigError(
      `WA_LINKING_DISPLAY "${rawDisplay}" is not valid (expected "tty" or "none").`,
    );
  }
  const linkingDisplay = rawDisplay;

  const rawLevel = env["LOG_LEVEL"]?.trim();
  let logLevel: LogLevel = "info";
  if (rawLevel !== undefined && rawLevel !== "") {
    if (!isLogLevel(rawLevel)) {
      throw new ConfigError(
        `LOG_LEVEL "${rawLevel}" is not valid (expected debug, info, warn, or error).`,
      );
    }
    logLevel = rawLevel;
  }

  // ---- History import budgets (ADR 0007): bounded best-effort ----
  const historyImport: HistoryImportSettings = {
    pollMs: parseBudgetInt(env, "HISTORY_IMPORT_POLL_MS", 5_000),
    batchCount: parseBudgetInt(
      env,
      "HISTORY_IMPORT_BATCH_COUNT",
      DEFAULT_HISTORY_IMPORT_BUDGETS.batchCount,
      HISTORY_IMPORT_BOUNDS.batchCount,
    ),
    maxRounds: parseBudgetInt(
      env,
      "HISTORY_IMPORT_MAX_ROUNDS",
      20,
      HISTORY_IMPORT_BOUNDS.maxRounds,
    ),
    maxMessages: parseBudgetInt(
      env,
      "HISTORY_IMPORT_MAX_MESSAGES",
      2_000,
      HISTORY_IMPORT_BOUNDS.maxMessages,
    ),
    timeBudgetMs: parseBudgetInt(env, "HISTORY_IMPORT_TIME_BUDGET_MS", 120_000),
  };
  // The poll interval has a hard floor (like RECONCILE_INTERVAL_MS):
  // values below 1000ms would poll the database pointlessly.
  if (historyImport.pollMs < 1_000) historyImport.pollMs = 1_000;

  // Staleness invariant + bounds (SA-L1): a slow-but-active import must
  // never look stale to the recovery sweep (timeBudget + roundTimeout
  // < staleMs). Fails fast with the validator's clear message.
  try {
    validateHistoryImportBudgets({
      ...DEFAULT_HISTORY_IMPORT_BUDGETS,
      ...historyImport,
    });
  } catch (error) {
    throw new ConfigError(
      error instanceof Error
        ? error.message
        : "Invalid history import budget configuration.",
    );
  }

  const rawHistorySync = env["WA_HISTORY_SYNC"]?.trim() || "off";
  if (
    rawHistorySync !== "off" &&
    rawHistorySync !== "recent" &&
    rawHistorySync !== "full"
  ) {
    throw new ConfigError(
      `WA_HISTORY_SYNC "${rawHistorySync}" is not valid (expected "off", "recent", or "full").`,
    );
  }
  const historySyncMode: HistorySyncMode = rawHistorySync;

  // ---- Session control (ADR 0008): admin logout flag polling ----
  let sessionControlPollMs = parseBudgetInt(
    env,
    "SESSION_CONTROL_POLL_MS",
    3_000,
  );
  // Same hard floor as the other pollers: below 1000ms the database is
  // polled pointlessly.
  if (sessionControlPollMs < 1_000) sessionControlPollMs = 1_000;

  return {
    databaseUrl,
    sessionDir,
    defaultTimezone,
    phoneNumber,
    allowInsecureSessionStorage,
    checkForUpdates,
    linkingDisplay,
    historyImport,
    historySyncMode,
    sessionControlPollMs,
    logLevel,
    backoff: DEFAULT_BACKOFF,
  };
}

/** Parses a positive-integer budget env; empty/unset keeps the default. */
function parseBudgetInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? "" : ` between 1 and ${max}`;
    throw new ConfigError(`${name} must be a positive integer${range} (got "${raw}").`);
  }
  return parsed;
}

export interface SessionStorageOptions {
  /** Explicit dev escape hatch (WA_SESSION_ALLOW_INSECURE=yes). */
  allowInsecure: boolean;
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Prepares the WhatsApp session-state directory: created when missing
 * (mode 0700 on POSIX), then the permission post-condition is VERIFIED
 * (audit M2 — hardening is not silently best-effort):
 *
 * - POSIX: the directory must be owner-only (`mode & 0o077 === 0`) or
 *   startup fails (fail fast: this is credential storage). The 0700
 *   DIRECTORY is the protection — Baileys writes its auth files with the
 *   process umask, so file modes must not be relied upon (ADR 0004).
 * - win32: refused by default — NTFS ACLs cannot be verified in Node,
 *   so protecting the directory is the operator's job (documented);
 *   WA_SESSION_ALLOW_INSECURE=yes acknowledges this explicitly.
 *
 * Errors reference the variable and an fs error code only — never the
 * path (ADR 0004: the session directory is never logged).
 */
export function ensureSessionStorage(
  sessionDir: string,
  options: SessionStorageOptions = { allowInsecure: false },
): void {
  const platform = options.platform ?? process.platform;
  try {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }
    // Best-effort chmod: the post-condition below is what enforces it.
    try {
      chmodSync(sessionDir, 0o700);
    } catch {
      // Checked below via statSync; may fail on Windows or mounts.
    }
    accessSync(sessionDir, fsConstants.W_OK);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    throw new ConfigError(
      `WA_SESSION_DIR is not usable (fs error: ${code}). Create a writable ` +
        "directory for the WhatsApp session state and point WA_SESSION_DIR at " +
        "it (see ADR 0004 for the required permissions). The path is never " +
        "logged, so it is not shown here.",
    );
  }

  if (options.allowInsecure) return; // explicit acknowledgment (dev)

  if (platform === "win32") {
    throw new ConfigError(
      "WA_SESSION_DIR permission hardening cannot be verified on Windows " +
        "(NTFS ACLs are the operator's responsibility). Run the bot-worker on " +
        "a POSIX host/container (recommended) or set WA_SESSION_ALLOW_INSECURE=yes " +
        "to acknowledge the risk explicitly (ADR 0004).",
    );
  }

  const mode = statSync(sessionDir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    // Fail fast (documented in ADR 0004): this directory holds account
    // credentials, so a group/world-accessible mode is a startup error,
    // not a warning.
    throw new ConfigError(
      "the WhatsApp session directory is not owner-only (permission check " +
        `failed: mode ${(mode).toString(8)} exposes it beyond the owner). Fix ` +
        "the directory mode (0700) and ownership, or set " +
        "WA_SESSION_ALLOW_INSECURE=yes to acknowledge the risk (ADR 0004).",
    );
  }
}
