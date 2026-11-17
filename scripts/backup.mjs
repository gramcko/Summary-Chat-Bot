#!/usr/bin/env node
/**
 * Summarly Chat Bot — production backup for the Docker Compose stack.
 *
 * Creates backups/<UTC timestamp>/ containing:
 *   summarly.dump      PostgreSQL custom-format dump (pg_dump -Fc) of the
 *                      running `postgres` service
 *   wa-session.tar.gz  archive of the `wa-session` volume, taken with a
 *                      one-off `bot-worker` container (unless --no-session)
 *   env.backup         copy of the repository-root .env, 0600 (only with
 *                      --include-env; it contains secrets)
 *   summary.txt        non-secret metadata: timestamp, DOMAIN, database
 *                      names, file sizes and the sensitivity warning
 *
 * Usage:
 *   npm run backup
 *   npm run backup -- --include-env --keep 14
 *   npm run backup -- --no-session
 *   node scripts/backup.mjs --help
 *
 * The dump is streamed to disk (child_process.spawn + createWriteStream), so
 * a large database never sits in memory. Nothing is written to Redis or to
 * the application volumes; the only side effect is a short-lived `run --rm`
 * container for the session archive.
 *
 * Node 20+ built-ins only. Exit codes:
 *   0  backup written
 *   1  Docker/Compose unavailable, postgres not running/healthy, or a dump
 *      step failed
 *   2  usage error (unknown flag, bad --keep value)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repoRoot, ".env");
const backupsRoot = join(repoRoot, "backups");

// Only directories created by this script are ever pruned. Anything else
// under backups/ (a manually named dump, an encrypted archive, a directory
// an operator made) is left alone.
const BACKUP_DIR_PATTERN = /^\d{8}-\d{6}Z$/;

// Piping the output into `head`/`less` closes stdout early; treat that as a
// normal exit instead of an EPIPE stack trace.
process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

const USAGE = `Summarly Chat Bot — production backup

Usage:
  npm run backup -- [options]
  node scripts/backup.mjs [options]

Options:
  --include-env   Also copy .env to the backup as env.backup (mode 0600).
                  WARNING: it contains secrets (POSTGRES_PASSWORD,
                  ENCRYPTION_KEY, ...). Encrypt the backup before moving it
                  off the host.
  --no-session    Skip the WhatsApp session archive (wa-session.tar.gz).
  --keep <n>      After a successful backup, delete older backup directories
                  in backups/ beyond the newest n. Only directories named like
                  YYYYMMDD-HHMMSSZ are considered; nothing else is touched.
  --help, -h      Show this help and exit.

What it does:
  1. Checks Docker Compose v2 and that the postgres service is running and
     healthy (a started container is not assumed to be ready).
  2. Creates backups/<UTC timestamp>/ (0700 where supported).
  3. Streams: docker compose exec -T postgres pg_dump -U <user> -d <db> -Fc
     to summarly.dump.
  4. Streams: docker compose run --rm --no-deps -T --entrypoint tar
     bot-worker -C /data -czf - wa-session to wa-session.tar.gz.
  5. Writes summary.txt (no secrets) and prints the path and file sizes.

The dump and the session archive are taken from the live stack; stop
bot-worker first if you need a perfectly consistent session copy.

Backups contain chat data (PII) and WhatsApp session credentials that can
link the account. Encrypt them (age, gpg, ...) and restrict access. Back up
ENCRYPTION_KEY separately: without it, saved AI provider keys cannot be
decrypted after a restore.

Restore with: npm run restore -- backups/<timestamp>
`;

/** Progress goes to stderr so it never mixes with data streams. */
function log(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 1) {
  log(`\nError: ${message}`);
  process.exit(code);
}

/**
 * Parse argv. Supports --include-env, --no-session, --keep <n>,
 * --keep=<n>, --help/-h. Unknown flags and stray positional arguments are
 * usage errors: a typo must not silently produce an incomplete backup.
 */
function parseArgs(argv) {
  const options = {
    includeEnv: false,
    noSession: false,
    keep: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--include-env") {
      options.includeEnv = true;
      continue;
    }
    if (arg === "--no-session") {
      options.noSession = true;
      continue;
    }
    if (arg === "--keep") {
      options.keep = parseKeep(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--keep=")) {
      options.keep = parseKeep(arg.slice("--keep=".length));
      continue;
    }
    fail(`unknown argument: ${arg} (see --help)`, 2);
  }

  return options;
}

function parseKeep(raw) {
  if (raw === undefined || raw === "") {
    fail("--keep needs a number, e.g. --keep 14", 2);
  }
  if (!/^\d+$/.test(raw)) {
    fail(`--keep needs a whole number, got "${raw}"`, 2);
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1) {
    fail("--keep must be at least 1 (use the default to keep everything)", 2);
  }
  return value;
}

/**
 * Read the repository-root .env without evaluating it. Values are never
 * printed; only POSTGRES_USER, POSTGRES_DB and DOMAIN are used here.
 */
function readEnvFile() {
  if (!existsSync(envPath)) {
    fail(
      [
        `missing ${envPath}.`,
        "",
        "The production stack is configured from the repository-root .env.",
        "Create it with `npm run setup` (or copy .env.example and fill it in),",
        "then rerun the backup.",
      ].join("\n"),
    );
  }

  const values = new Map();
  const content = readFileSync(envPath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const assignment = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;

    const key = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!values.has(key)) {
      values.set(key, value);
    }
  }

  return values;
}

function envValue(values, key, fallback) {
  const raw = values.get(key);
  const value = raw === undefined ? "" : raw.trim();
  return value === "" ? fallback : value;
}

/** UTC timestamp directory name: 20261116-201530Z (sortable, unambiguous). */
function utcTimestamp() {
  const iso = new Date().toISOString(); // 2026-11-16T20:15:30.123Z
  const [datePart, timePart] = iso.split("T");
  const date = datePart.replace(/-/g, "");
  const time = timePart.slice(0, 8).replace(/:/g, "");
  return `${date}-${time}Z`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function dockerSync(args) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    // Never inherit stdin here: these are short status probes.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureDockerCompose() {
  const result = spawnSync("docker", ["compose", "version"], {
    cwd: repoRoot,
    stdio: "ignore",
  });

  if (result.error || result.status !== 0) {
    fail(
      [
        "Docker Compose v2 is not available.",
        "",
        "The backup reads the running stack, so it needs Docker Engine 24+",
        "with the Compose v2 plugin (`docker compose version`) and access to",
        "the Docker daemon.",
        "",
        "Install Docker (https://docs.docker.com/engine/install/), make sure",
        "your user can run it, then rerun: npm run backup",
      ].join("\n"),
    );
  }
}

/**
 * Refuse to dump unless the postgres service exists, is running and is
 * healthy. `pg_isready` then confirms the server accepts connections.
 */
function ensurePostgresReady(user, database) {
  const ps = dockerSync(["compose", "ps", "-q", "postgres"]);
  if (ps.error || ps.status !== 0) {
    fail(
      `\`docker compose ps\` failed: ${(ps.stderr || ps.error?.message || "").trim()}`,
    );
  }

  const containerId = ps.stdout.trim().split(/\s+/)[0];
  if (!containerId) {
    fail(
      [
        "the postgres service is not running, so there is nothing to dump.",
        "",
        "Start the stack first: docker compose up -d --wait",
        "Then check: docker compose ps",
      ].join("\n"),
    );
  }

  const inspect = dockerSync([
    "inspect",
    "--format",
    "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    containerId,
  ]);
  if (inspect.error || inspect.status !== 0) {
    fail(`could not inspect the postgres container: ${(inspect.stderr || "").trim()}`);
  }

  const [state, health] = inspect.stdout.trim().split("|");
  if (state !== "running") {
    fail(`the postgres container is ${state}, not running. Start it with: docker compose up -d postgres`);
  }
  if (health !== "none" && health !== "healthy") {
    fail(
      [
        `the postgres service is "${health}", not healthy.`,
        "",
        "Wait for it to become healthy (docker compose ps), then rerun the",
        "backup. A container that is merely started is not ready to dump.",
      ].join("\n"),
    );
  }

  const ready = dockerSync([
    "compose",
    "exec",
    "-T",
    "postgres",
    "pg_isready",
    "-U",
    user,
    "-d",
    database,
  ]);
  if (ready.error || ready.status !== 0) {
    fail(
      [
        `postgres did not accept connections (pg_isready -U ${user} -d ${database}).`,
        "",
        "Check the container: docker compose logs --tail=100 postgres",
      ].join("\n"),
    );
  }
}

/**
 * Run `docker <args>` and stream its stdout into `filePath`.
 *
 * Streaming (rather than spawnSync buffering) keeps memory flat for large
 * dumps. The file is created 0600 where the OS supports it; the caller
 * deletes it on failure so a truncated archive is never mistaken for a
 * usable backup.
 */
function dockerStreamToFile(args, filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const output = createWriteStream(filePath, { mode: 0o600 });
    const child = spawn("docker", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let exitCode = null;
    let childClosed = false;
    let fileFinished = false;
    let stderrTail = "";

    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        output.destroy();
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    const maybeFinish = () => {
      if (!childClosed || !fileFinished) return;
      if (exitCode === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `\`docker ${args.join(" ")}\` exited with code ${exitCode}` +
            (stderrTail.trim() === "" ? "" : `\n${stderrTail.trim()}`),
        ),
      );
    };

    child.on("error", (error) => {
      childClosed = true;
      settle(error);
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-8000);
      process.stderr.write(text);
    });

    if (child.stdout) {
      child.stdout.pipe(output);
    } else {
      // Spawn failed before any stream existed; let the error handler report.
      output.end();
    }

    output.on("error", (error) => {
      child.kill();
      settle(error);
    });
    output.on("finish", () => {
      fileFinished = true;
      maybeFinish();
    });

    child.on("close", (code) => {
      exitCode = code;
      childClosed = true;
      maybeFinish();
    });
  });
}

/**
 * Delete old timestamped backup directories, keeping the newest `keep`.
 * Only `backups/<YYYYMMDD-HHMMSSZ>` directories are candidates: symlinks,
 * files and any other name are skipped, and every path is re-checked to be
 * directly under backups/ before removal.
 */
function pruneOldBackups(keep) {
  if (!existsSync(backupsRoot)) return [];

  const candidates = readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse(); // newest first (names sort chronologically)

  const stale = candidates.slice(keep);
  const removed = [];

  for (const name of stale) {
    const target = resolve(backupsRoot, name);
    if (!target.startsWith(`${resolve(backupsRoot)}${sep}`)) {
      log(`Skipping ${name}: outside ${backupsRoot}`);
      continue;
    }

    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      log(`Skipping ${name}: not a plain directory`);
      continue;
    }

    rmSync(target, { recursive: true, force: true });
    removed.push(name);
    log(`Removed old backup: ${target}`);
  }

  return removed;
}

function writeSummary(backupDir, details) {
  const lines = [
    "Summarly backup",
    "",
    `created (UTC): ${details.createdAt}`,
    `host:          ${hostname()}`,
    `domain:        ${details.domain}`,
    `postgres:      user=${details.user} database=${details.database}`,
    "",
    "files:",
    ...details.files.map((file) => `  ${file.name}  ${file.bytes} bytes (${formatBytes(file.bytes)})`),
    "",
    "contents:",
    "  - PostgreSQL dump: messages, groups, runs, summaries, settings and",
    "    encrypted AI provider keys.",
    "  - WhatsApp session credentials (Baileys), if wa-session.tar.gz exists.",
    "  - .env copy, if env.backup exists (contains secrets).",
    "",
    "WARNING: this directory contains chat data (PII) and credentials.",
    "Encrypt it before copying it off the host (age, gpg, ...) and restrict",
    "access. ENCRYPTION_KEY is not inside the database: back it up separately,",
    "otherwise saved AI provider keys cannot be decrypted after a restore.",
    "",
  ];

  writeFileMode0600(join(backupDir, "summary.txt"), lines.join("\n"));
}

function writeFileMode0600(filePath, content) {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows: no POSIX bits; NTFS ACLs are the operator's responsibility.
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const env = readEnvFile();
  const user = envValue(env, "POSTGRES_USER", "summarly");
  const database = envValue(env, "POSTGRES_DB", "summarly");
  const domain = envValue(env, "DOMAIN", "localhost");

  ensureDockerCompose();
  ensurePostgresReady(user, database);

  const createdAt = new Date().toISOString();
  const stamp = utcTimestamp();
  const backupDir = join(backupsRoot, stamp);

  if (existsSync(backupDir)) {
    fail(
      `backup directory already exists: ${backupDir}\nWait a second and rerun, or move the existing directory aside.`,
    );
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(backupDir, 0o700);
  } catch {
    // Windows: best effort.
  }

  log(`Creating backup in ${backupDir}`);

  const files = [];

  // 1. PostgreSQL — streamed, never buffered in memory.
  const dumpPath = join(backupDir, "summarly.dump");
  log(`Dumping PostgreSQL (user=${user}, database=${database}) ...`);
  try {
    await dockerStreamToFile(
      ["compose", "exec", "-T", "postgres", "pg_dump", "-U", user, "-d", database, "-Fc"],
      dumpPath,
    );
  } catch (error) {
    rmSync(dumpPath, { force: true });
    rmSync(backupDir, { recursive: true, force: true });
    fail(
      [
        `PostgreSQL dump failed: ${error instanceof Error ? error.message : String(error)}`,
        "",
        "Nothing usable was written; the incomplete backup directory was removed.",
        "Check the database: docker compose logs --tail=100 postgres",
        "and that POSTGRES_USER/POSTGRES_DB in .env match the running database.",
      ].join("\n"),
    );
  }

  const dumpStats = statSync(dumpPath);
  if (dumpStats.size === 0) {
    rmSync(backupDir, { recursive: true, force: true });
    fail("pg_dump produced an empty file; the backup was discarded. Check the postgres logs.");
  }
  files.push({ name: "summarly.dump", bytes: dumpStats.size });
  log(`  summarly.dump: ${formatBytes(dumpStats.size)}`);

  // 2. WhatsApp session volume, read through a one-off container.
  if (options.noSession) {
    log("Skipping the WhatsApp session archive (--no-session).");
  } else {
    const sessionPath = join(backupDir, "wa-session.tar.gz");
    log("Archiving the WhatsApp session volume ...");
    try {
      await dockerStreamToFile(
        [
          "compose",
          "run",
          "--rm",
          "--no-deps",
          // -T: no pseudo-TTY, so the gzip stream stays binary-clean.
          "-T",
          "--entrypoint",
          "tar",
          "bot-worker",
          "-C",
          "/data",
          "-czf",
          "-",
          "wa-session",
        ],
        sessionPath,
      );
    } catch (error) {
      rmSync(sessionPath, { force: true });
      fail(
        [
          `WhatsApp session backup failed: ${error instanceof Error ? error.message : String(error)}`,
          "",
          `The database dump was kept: ${dumpPath}`,
          "The backup is incomplete (no wa-session.tar.gz).",
          "",
          "Check that the app image exists (docker compose build bot-worker) and",
          "that the bot-worker service is defined, then rerun. Use --no-session",
          "to take a database-only backup.",
        ].join("\n"),
      );
    }

    const sessionStats = statSync(sessionPath);
    if (sessionStats.size === 0) {
      rmSync(sessionPath, { force: true });
      fail(
        `The session archive is empty. The database dump was kept at ${dumpPath}.\nRerun the backup or use --no-session.`,
      );
    }
    files.push({ name: "wa-session.tar.gz", bytes: sessionStats.size });
    log(`  wa-session.tar.gz: ${formatBytes(sessionStats.size)}`);
  }

  // 3. Optional .env copy — the only file here that holds master secrets.
  if (options.includeEnv) {
    const envBackupPath = join(backupDir, "env.backup");
    copyFileSync(envPath, envBackupPath);
    try {
      chmodSync(envBackupPath, 0o600);
    } catch {
      // Windows: best effort.
    }
    files.push({ name: "env.backup", bytes: statSync(envBackupPath).size });
    log("");
    log("WARNING: env.backup contains SECRETS, including ENCRYPTION_KEY");
    log("(which decrypts the AI provider keys stored in the database) and");
    log("POSTGRES_PASSWORD. Encrypt the whole backup before copying it off");
    log("this host, and never commit it.");
    log("");
  }

  writeSummary(backupDir, {
    createdAt,
    domain,
    user,
    database,
    files,
  });

  if (options.keep !== undefined) {
    try {
      pruneOldBackups(options.keep);
    } catch (error) {
      // A failed prune must not invalidate a good backup.
      log(
        `Warning: could not prune old backups: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const sizeLines = files.map(
    (file) => `  ${file.name.padEnd(20)} ${formatBytes(file.bytes)}`,
  );

  process.stdout.write(
    [
      "",
      `Backup complete: ${backupDir}`,
      ...sizeLines,
      "",
      "This backup contains chat data (PII) and, unless --no-session was used,",
      "WhatsApp session credentials that can link the account.",
      "Encrypt it before storing it off the host, for example:",
      `  tar -C backups -czf - ${stamp} | age -p > ${stamp}.tar.gz.age`,
      "or use gpg, and restrict access to the backups/ directory.",
      "",
      "ENCRYPTION_KEY is not in the database dump. Back it up separately:",
      "without it, saved AI provider API keys cannot be decrypted after a",
      "restore and must be re-entered.",
      "",
      "Restore with: npm run restore -- backups/" + stamp,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  // Never dump the environment: the error may originate next to secret
  // material. Compose/pg_dump messages are already on stderr.
  fail(error instanceof Error ? error.message : String(error));
});
