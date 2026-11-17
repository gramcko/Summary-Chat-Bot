#!/usr/bin/env node
/**
 * Summarly Chat Bot — restore a backup taken by scripts/backup.mjs.
 *
 * Usage:
 *   npm run restore -- backups/20261116-201530Z
 *   npm run restore -- backups/20261116-201530Z --with-session
 *   npm run restore -- backups/20261116-201530Z --yes
 *   node scripts/restore.mjs --help
 *
 * What it does:
 *   1. Validates the backup directory (summarly.dump must exist) and reads
 *      POSTGRES_USER / POSTGRES_DB from the repository-root .env.
 *   2. Asks for a typed `RESTORE` confirmation unless --yes is passed.
 *   3. Stops backend, summary-worker, bot-worker, dashboard and caddy.
 *      postgres and redis keep running: the database is restored through
 *      `docker compose exec`, and Redis holds only rebuildable queue state.
 *   4. Restores the database:
 *        docker compose exec -T postgres pg_restore -U <user> -d <db>
 *          --clean --if-exists --no-owner --no-privileges
 *      fed from summarly.dump.
 *   5. Optionally (--with-session) replaces the wa-session volume contents
 *      from wa-session.tar.gz. This is destructive to the current session.
 *   6. Starts the stack again with `docker compose up -d --wait`.
 *
 * On failure it prints `docker compose logs --tail=200` and recovery steps.
 * It never runs `docker compose down` or `down -v`, and never prints secrets
 * or dump contents.
 *
 * Node 20+ built-ins only. Exit codes:
 *   0  restore completed and the stack is up
 *   1  restore failed or was cancelled
 *   2  usage error (missing/unknown argument, non-interactive without --yes)
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repoRoot, ".env");

// Application services stopped during the restore. postgres and redis are
// deliberately left running: the dump is fed through the running server and
// Redis state is disposable.
const APP_SERVICES = ["backend", "summary-worker", "bot-worker", "dashboard", "caddy"];

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

const USAGE = `Summarly Chat Bot — restore a backup

Usage:
  npm run restore -- <backup directory> [options]
  node scripts/restore.mjs <backup directory> [options]

Arguments:
  <backup directory>   Directory created by scripts/backup.mjs, for example
                       backups/20261116-201530Z. Relative paths are resolved
                       against the current directory, then the repository root.
                       It must contain summarly.dump.

Options:
  --with-session   Also restore wa-session.tar.gz into the wa-session volume.
                   DESTRUCTIVE: it clears the current WhatsApp session first,
                   so the linked account may need to be linked again.
  --yes            Skip the typed RESTORE confirmation (automation only).
  --help, -h       Show this help and exit.

What it does:
  1. Stops backend, summary-worker, bot-worker, dashboard and caddy.
     postgres and redis keep running.
  2. Restores the database with pg_restore --clean --if-exists --no-owner
     --no-privileges. This REPLACES all current data.
  3. Optionally replaces the WhatsApp session volume (--with-session).
  4. Starts the stack again: docker compose up -d --wait

Before restoring:
  - Take a fresh backup: npm run backup
  - Put the matching ENCRYPTION_KEY back into .env first. Without the key
    that encrypted the provider keys, saved AI provider API keys stay
    unreadable and must be re-entered.
  - An env.backup inside the backup directory is NOT restored automatically.

On failure the script prints recent container logs and recovery steps. It
never runs \`docker compose down -v\`: that would delete the database and the
WhatsApp session volume.
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 1) {
  log(`\nError: ${message}`);
  process.exit(code);
}

/**
 * Parse argv: one positional backup directory, --with-session, --yes,
 * --help/-h. Anything else is a usage error so a typo cannot trigger a
 * destructive restore against the wrong target.
 */
function parseArgs(argv) {
  const options = {
    backupArg: undefined,
    withSession: false,
    yes: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--with-session") {
      options.withSession = true;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`unknown argument: ${arg} (see --help)`, 2);
    }
    if (options.backupArg !== undefined) {
      fail(`unexpected argument: ${arg} (only one backup directory is accepted)`, 2);
    }
    options.backupArg = arg;
  }

  return options;
}

/** Read the repository-root .env without evaluating it; values are never printed. */
function readEnvFile() {
  if (!existsSync(envPath)) {
    fail(
      [
        `missing ${envPath}.`,
        "",
        "Compose reads POSTGRES_USER/POSTGRES_DB and the application secrets from",
        "the repository-root .env. Restore the matching .env first (or copy",
        ".env.example and fill it in), then rerun.",
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

/** Resolve the backup directory from the CLI argument. */
function resolveBackupDir(backupArg) {
  const fromCwd = isAbsolute(backupArg) ? backupArg : resolve(process.cwd(), backupArg);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }

  // `npm run restore -- backups/...` is normally run from the repository
  // root, but resolve against it as a fallback so the documented command
  // works from a subdirectory too.
  if (!isAbsolute(backupArg)) {
    const fromRepo = resolve(repoRoot, backupArg);
    if (existsSync(fromRepo)) {
      return fromRepo;
    }
  }

  fail(
    [
      `backup directory not found: ${backupArg}`,
      "",
      "Pass a directory created by `npm run backup`, for example:",
      "  npm run restore -- backups/20261116-201530Z",
      "List existing backups with: ls backups",
    ].join("\n"),
    2,
  );
}

function dockerSync(args, extraOptions = {}) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...extraOptions,
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
        "The restore drives the running stack, so it needs Docker Engine 24+",
        "with the Compose v2 plugin (`docker compose version`) and access to",
        "the Docker daemon.",
        "",
        "Install Docker (https://docs.docker.com/engine/install/), make sure",
        "your user can run it, then rerun: npm run restore -- <backup directory>",
      ].join("\n"),
    );
  }
}

/**
 * The restore feeds pg_restore through the running postgres container, so
 * that service must exist, run and be healthy before anything is stopped.
 */
function ensurePostgresReady(user, database) {
  const ps = dockerSync(["compose", "ps", "-q", "postgres"]);
  if (ps.error || ps.status !== 0) {
    fail(`\`docker compose ps\` failed: ${(ps.stderr || ps.error?.message || "").trim()}`);
  }

  const containerId = ps.stdout.trim().split(/\s+/)[0];
  if (!containerId) {
    fail(
      [
        "the postgres service is not running, so it cannot accept a restore.",
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
        "Wait for it to become healthy (docker compose ps) before restoring.",
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
 * Run `docker <args>` and feed `filePath` into its stdin. stdout is
 * inherited so pg_restore's progress messages stay visible; stderr is
 * forwarded and a tail is kept for the error message.
 */
function dockerStreamFromFile(args, filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", args, {
      cwd: repoRoot,
      stdio: ["pipe", "inherit", "pipe"],
    });
    const input = createReadStream(filePath);

    let settled = false;
    let stderrTail = "";

    const settle = (error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-8000);
      process.stderr.write(text);
    });

    // pg_restore can exit before consuming the whole file; EPIPE on stdin is
    // then expected and the exit code decides success.
    child.stdin?.on("error", () => {});

    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `\`docker ${args.join(" ")}\` exited with code ${code}` +
            (stderrTail.trim() === "" ? "" : `\n${stderrTail.trim()}`),
        ),
      );
    });

    input.on("error", (error) => {
      child.kill();
      settle(error);
    });
    if (child.stdin) {
      input.pipe(child.stdin);
    } else {
      input.destroy();
    }
  });
}

function runInherit(args, label) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`);
  }
}

async function confirmRestore(options, details) {
  if (options.yes) {
    log("Skipping the confirmation prompt (--yes).");
    return;
  }

  if (!process.stdin.isTTY) {
    fail(
      [
        "refusing to restore without confirmation in a non-interactive shell.",
        "",
        "Pass --yes to confirm explicitly, for example:",
        "  npm run restore -- <backup directory> --yes",
      ].join("\n"),
      2,
    );
  }

  const lines = [
    "",
    "About to restore:",
    `  backup:   ${details.backupDir}`,
    `  database: user=${details.user} db=${details.database}  (REPLACES the current data)`,
  ];
  if (options.withSession) {
    lines.push(
      "  session:  wa-session.tar.gz  (CLEARS and REPLACES the current WhatsApp session)",
    );
  } else {
    lines.push("  session:  left untouched (no --with-session)");
  }
  lines.push(
    "",
    "Steps: stop backend, summary-worker, bot-worker, dashboard and caddy;",
    "restore PostgreSQL; then run `docker compose up -d --wait`.",
    "postgres and redis keep running. This cannot be undone.",
    "",
    "Take a fresh backup first if you have not already: npm run backup",
    "",
  );
  process.stdout.write(`${lines.join("\n")}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question("Type RESTORE to continue: ");
  } finally {
    rl.close();
  }

  if (answer.trim() !== "RESTORE") {
    fail("restore cancelled; nothing was changed.", 1);
  }
}

/**
 * Print recent logs plus recovery steps after a failed restore. Services are
 * left stopped on purpose: starting them against a partially restored
 * database could serve inconsistent data.
 */
function reportFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`\nRestore failed: ${message}`);

  log("\nRecent container logs (docker compose logs --tail=200):");
  const logs = spawnSync("docker", ["compose", "logs", "--tail=200"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (logs.error) {
    log(`  (could not read logs: ${logs.error.message})`);
  }

  log(
    [
      "",
      "Recovery:",
      "  - The application services were stopped for the restore; check",
      "    `docker compose ps` (if the failure happened early they may still be",
      "    running). The database may be partially restored, so fix the",
      "    reported problem before starting them.",
      "  - Rerun the same restore command (it is safe to repeat):",
      "      npm run restore -- <backup directory>",
      "  - If the dump itself is unreadable, use an older backup directory",
      "    (check backups/) or restore the matching ENCRYPTION_KEY and .env.",
      "  - Inspect the database directly when needed:",
      "      docker compose exec postgres psql -U <user> -d <db>",
      "  - To start with the current data after resolving the problem:",
      "      docker compose up -d --wait",
      "  - Never run `docker compose down -v`: it deletes the database and the",
      "    WhatsApp session volume.",
      "",
    ].join("\n"),
  );

  process.exit(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.backupArg === undefined) {
    fail("missing backup directory argument (see --help).", 2);
  }

  const backupDir = resolveBackupDir(options.backupArg);
  if (!statSync(backupDir).isDirectory()) {
    fail(`not a directory: ${backupDir}`, 2);
  }

  const dumpPath = join(backupDir, "summarly.dump");
  if (!existsSync(dumpPath)) {
    fail(
      [
        `missing ${dumpPath}.`,
        "",
        "A backup directory must contain summarly.dump (created by",
        "`npm run backup`). Nothing was changed.",
      ].join("\n"),
      2,
    );
  }
  if (statSync(dumpPath).size === 0) {
    fail(
      [
        `${dumpPath} is empty, so there is nothing to restore.`,
        "",
        "Use another backup directory (check backups/), or take a new backup.",
        "Nothing was changed.",
      ].join("\n"),
      2,
    );
  }

  const sessionPath = join(backupDir, "wa-session.tar.gz");
  if (options.withSession && !existsSync(sessionPath)) {
    fail(
      [
        `missing ${sessionPath}, so --with-session cannot run.`,
        "",
        "Rerun without --with-session to restore only the database, or take a",
        "new backup that includes the WhatsApp session.",
      ].join("\n"),
      2,
    );
  }

  const env = readEnvFile();
  const user = envValue(env, "POSTGRES_USER", "summarly");
  const database = envValue(env, "POSTGRES_DB", "summarly");

  ensureDockerCompose();
  ensurePostgresReady(user, database);

  if (existsSync(join(backupDir, "env.backup"))) {
    log(
      [
        "",
        "Note: this backup contains env.backup. It is NOT restored",
        "automatically — check that .env has the ENCRYPTION_KEY that was used",
        "when the dump was taken, or saved provider API keys stay unreadable.",
        "",
      ].join("\n"),
    );
  }

  await confirmRestore(options, { backupDir, user, database });

  try {
    log(`\nStopping application services (${APP_SERVICES.join(", ")}) ...`);
    runInherit(["compose", "stop", ...APP_SERVICES], "docker compose stop");

    log(`\nRestoring the database from ${dumpPath} ...`);
    await dockerStreamFromFile(
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "-U",
        user,
        "-d",
        database,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
      ],
      dumpPath,
    );

    if (options.withSession) {
      log(`\nRestoring the WhatsApp session from ${sessionPath} ...`);
      // The volume is mounted at /data/wa-session: clear its contents (the
      // mount point itself cannot be removed) and extract the archive, which
      // contains a wa-session/ directory. chmod restores the owner-only mode
      // the bot-worker requires.
      const sessionScript = [
        "set -eu",
        "find /data/wa-session -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
        "tar -xzf - -C /data",
        "chmod 0700 /data/wa-session",
      ].join("\n");

      await dockerStreamFromFile(
        [
          "compose",
          "run",
          "--rm",
          "--no-deps",
          // -T: no pseudo-TTY, so the gzip stream on stdin stays intact.
          "-T",
          "--entrypoint",
          "sh",
          "bot-worker",
          "-c",
          sessionScript,
        ],
        sessionPath,
      );
    }

    log("\nStarting the stack (docker compose up -d --wait) ...");
    runInherit(["compose", "up", "-d", "--wait"], "docker compose up");
  } catch (error) {
    reportFailure(error);
    return;
  }

  process.stdout.write(
    [
      "",
      "Restore complete.",
      `  backup:   ${backupDir}`,
      `  database: user=${user} db=${database}`,
      options.withSession
        ? "  session:  replaced from wa-session.tar.gz"
        : "  session:  left untouched",
      "",
      "Next steps:",
      "  - Open the dashboard and confirm groups, summaries and settings.",
      "  - docker compose ps  — every service should be healthy/running.",
      "  - If the restored WhatsApp session was invalidated by WhatsApp, unlink",
      "    and re-link the account from the Connection page.",
      "  - Pending summary runs are reconciled from PostgreSQL; Redis queue",
      "    state was intentionally not restored.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
