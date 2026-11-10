import { Pool } from "pg";
import qrcode from "qrcode-terminal";
import {
  ConfigError,
  ensureSessionStorage,
  loadConfig,
  type BotConfig,
} from "./config.js";
import { PostgresBotDb } from "./db.js";
import { HistoryImportService } from "./history-import.js";
import { errorReason } from "./lib/errors.js";
import { loadRepoEnv } from "./lib/load-env.js";
import { createLogger, isLogLevel, type Logger } from "./lib/log.js";
import { startParentWatchdog } from "./lib/parent-watchdog.js";
import { CaptureService, type LinkingInfo } from "./service.js";
import { SessionControlService } from "./session-control.js";
import { BaileysAdapter } from "./whatsapp/baileys-adapter.js";

/**
 * bot-worker entry point (architecture §4.3, ADR 0004): owns the linked
 * WhatsApp session, discovers group chats (privacy-first opt-in), and
 * persists monitored group messages to PostgreSQL. Operational logs
 * carry counts and identifiers only — never message content, names,
 * phone numbers, or session material (AGENTS.md).
 */

// Load the repository-root .env (see .env.example) before any
// configuration is read. Shell-exported variables win over the file.
loadRepoEnv();

// Early logger for startup failures; the real level comes from config.
const earlyLevel = process.env["LOG_LEVEL"]?.trim();
const bootstrapLog = createLogger(
  "bot-worker",
  earlyLevel !== undefined && isLogLevel(earlyLevel) ? earlyLevel : "info",
);

function fail(message: string): never {
  bootstrapLog("error", "startup_failed", { message });
  process.exit(1);
}

let config: BotConfig;
try {
  config = loadConfig();
} catch (error) {
  fail(error instanceof ConfigError ? error.message : "Invalid configuration.");
}

const log: Logger = createLogger("bot-worker", config.logLevel);

// Fail fast on unusable session storage BEFORE any network activity.
// The path itself is never logged (ADR 0004).
try {
  ensureSessionStorage(config.sessionDir, {
    allowInsecure: config.allowInsecureSessionStorage,
  });
} catch (error) {
  fail(
    error instanceof ConfigError
      ? error.message
      : "WhatsApp session storage setup failed.",
  );
}

const pool = new Pool({ connectionString: config.databaseUrl });
// Safe reason only (codes/redacted text); never connection URLs.
pool.on("error", (error) => {
  log("error", "database_pool_error", { reason: errorReason(error) });
});

const db = new PostgresBotDb(pool);
const adapter = new BaileysAdapter({
  sessionDir: config.sessionDir,
  phoneNumber: config.phoneNumber,
  checkForUpdates: config.checkForUpdates,
  historySyncMode: config.historySyncMode,
  log,
});

/**
 * Linking UX (MVP, ADR 0004): render the QR / pairing code on the
 * terminal. This is presentation, not logging — the material is shown
 * once and never written to structured logs. It is rendered ONLY on an
 * interactive terminal (audit M3/L5: in Docker stdout IS the log
 * stream, and a retained QR is a live pairing ticket).
 */
const linkingDisplayEnabled =
  config.linkingDisplay !== "none" && process.stdout.isTTY === true;
let linkingSuppressedWarned = false;
let qrShownBefore = false;

function presentLinking(linking: LinkingInfo): void {
  if (!linkingDisplayEnabled) {
    if (!linkingSuppressedWarned) {
      linkingSuppressedWarned = true;
      log("warn", "linking_display_disabled", {
        note:
          "Linking material is NOT rendered because the output is not an " +
          "interactive terminal (WA_LINKING_DISPLAY). Run the bot-worker in a " +
          "terminal to link the account. Never pipe linking output into log " +
          "pipelines: a retained QR code is a live pairing ticket (ADR 0004).",
      });
    }
    return;
  }
  if (linking.kind === "qr") {
    if (qrShownBefore) {
      process.stdout.write(
        "\n(The QR codes printed earlier have expired — use the latest one below.)\n",
      );
    }
    qrShownBefore = true;
    process.stdout.write(
      "\nLink the WhatsApp account (the QR below is linkable credentials:\n" +
        "do not share it, screenshot it, or paste it into chats):\n" +
        "  WhatsApp > Settings > Linked devices > Link a device\n\n",
    );
    qrcode.generate(linking.qr, { small: true });
    process.stdout.write(
      "\nWaiting for the scan... the code refreshes automatically.\n",
    );
  } else {
    process.stdout.write(
      `\nPairing code: ${linking.code}\n` +
        "  WhatsApp > Settings > Linked devices > Link with phone number\n" +
        "  and enter the code above (it expires in a few minutes).\n",
    );
  }
}

const service = new CaptureService({
  adapter,
  db,
  log,
  defaultTimezone: config.defaultTimezone,
  backoff: config.backoff,
  onLinking: presentLinking,
});

// History imports (ADR 0007): bounded best-effort backfill driven by
// admin requests recorded in PostgreSQL (no queue, no RPC).
const historyImports = new HistoryImportService({
  adapter,
  db,
  log,
  budgets: config.historyImport,
});

// Session control (ADR 0008): polls the admin logout flag and tears
// the session down (remote revoke + local auth-state purge), then
// re-arms linking so the account can be linked again without a restart.
const sessionControl = new SessionControlService({
  adapter,
  db,
  log,
  capture: service,
  sessionDir: config.sessionDir,
  pollMs: config.sessionControlPollMs,
});

log("info", "bot_worker_starting", {
  defaultTimezone: config.defaultTimezone,
  pairingCodeLinking: config.phoneNumber !== null,
  logLevel: config.logLevel,
  note:
    "The WhatsApp integration (Baileys) is unofficial and can break on " +
    "upstream changes - see docs/decisions/0004.",
});

try {
  await service.start();
} catch (error) {
  fail(
    error instanceof Error
      ? error.message.slice(0, 200)
      : "Startup failed unexpectedly.",
  );
}

log("info", "bot_worker_started", { status: service.sessionStatus });
historyImports.start();
sessionControl.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_started", { signal });
  let failed = false;
  // Order matters: stop the pollers first (history import releases an
  // active claim back to 'pending'; session control finishes or leaves
  // a pending logout flag for the next start), then close the WhatsApp
  // socket (the adapter saves its auth state) and let in-flight message
  // batches commit BEFORE the database pool goes away (architecture
  // §5.1/§6, ADR 0007/0008).
  try {
    await historyImports.stop();
  } catch {
    failed = true;
  }
  try {
    await sessionControl.stop();
  } catch {
    failed = true;
  }
  try {
    await service.stop();
  } catch {
    failed = true;
  }
  try {
    await pool.end();
  } catch {
    failed = true;
  }
  log(failed ? "error" : "info", "shutdown_complete", { signal, failed });
  process.exit(failed ? 1 : 0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// Parent-PID watchdog (fix round B, risk): when the backend supervises
// us (SUMMARLY_PARENT_PID), a vanished parent — e.g. a force-killed
// backend on Windows, where nothing cascades to children — triggers
// our graceful shutdown instead of an orphaned live WhatsApp session.
// Standalone runs (no env var) are unaffected.
const parentPidRaw = process.env["SUMMARLY_PARENT_PID"]?.trim();
const parentPid =
  parentPidRaw === undefined || parentPidRaw === ""
    ? Number.NaN
    : Number(parentPidRaw);
if (Number.isInteger(parentPid) && parentPid > 0) {
  startParentWatchdog({
    pid: parentPid,
    onParentGone: () => void shutdown("parent_gone"),
  });
}
