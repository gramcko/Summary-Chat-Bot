#!/usr/bin/env node
/**
 * One-command setup for the production Docker deployment.
 *
 * Creates the repository-root `.env` from `.env.example` with freshly
 * generated secrets, then (unless --no-start) builds and starts the
 * Compose stack with `docker compose up -d --build --wait`.
 *
 * Usage:
 *   npm run setup -- --domain summarly.example.com
 *   npm run setup -- --domain localhost --no-start
 *   npm run setup -- --force --domain example.com
 *   node scripts/setup.mjs --help
 *
 * Generated values (NEVER printed, never written anywhere except `.env`):
 *   POSTGRES_PASSWORD  randomBytes(24).toString("base64url")  (URL-safe)
 *   ENCRYPTION_KEY     randomBytes(32).toString("base64")     (AES-256-GCM)
 *
 * Everything else in `.env.example` (comments and placeholders) is kept
 * as-is, so the generated file stays documented. The file is written with
 * mode 0600 on POSIX (best effort on Windows: NTFS ACLs are the
 * operator's responsibility).
 *
 * Node built-ins only: this script must run before `npm install` is
 * strictly required (it is invoked through npm, so no dependencies).
 *
 * Exit codes:
 *   0  success
 *   1  .env already exists without --force, Docker/Compose unavailable, or
 *      `docker compose up` failed
 *   2  usage error (bad flag or invalid domain)
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repoRoot, ".env");
const envExamplePath = join(repoRoot, ".env.example");

// Piping the output into `head`/`less` closes stdout early; treat that as a
// normal exit instead of an EPIPE stack trace.
process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

const USAGE = `Summarly Chat Bot — production setup

Usage:
  npm run setup -- [options]
  node scripts/setup.mjs [options]

Options:
  --domain <name>   Public host name Caddy serves and obtains a certificate
                    for (default: localhost; also read from $DOMAIN).
                    "localhost" uses Caddy's local CA — browsers warn until
                    its root certificate is trusted.
  --no-start        Only create .env; do not run Docker Compose.
  --force           Overwrite an existing .env (default: refuse and exit 1).
  --help, -h        Show this help and exit.

What it does:
  1. Writes .env from .env.example with generated POSTGRES_PASSWORD and
     ENCRYPTION_KEY, DOMAIN=<domain> and COOKIE_SECURE=true. Secrets are
     generated locally and never printed.
  2. Checks that Docker Compose v2 is available (skipped with --no-start).
  3. Runs: docker compose up -d --build --wait

Afterwards:
  - Open https://<domain> and complete /setup (admin password + recovery codes).
  - Configure the AI provider in Settings, link WhatsApp on Connection, then
    opt a group into monitoring.
  - Logs: docker compose logs -f
  - Backups, restore and upgrades: docs/deployment.md

The existing .env is never deleted or rewritten without --force, and no
persistent volume is touched by this script.
`;

/** Print a line to stderr (setup progress must never carry secret material). */
function log(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 1) {
  log(`\nError: ${message}`);
  process.exit(code);
}

/**
 * Parse argv. Supported forms: --domain value, --domain=value, --no-start,
 * --force, --help/-h. Unknown flags are usage errors (a typo must not
 * silently start the stack with the wrong domain).
 */
function parseArgs(argv) {
  const options = {
    domain: undefined,
    noStart: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-start") {
      options.noStart = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--domain") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        fail("--domain needs a value, e.g. --domain summarly.example.com", 2);
      }
      options.domain = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--domain=")) {
      const value = arg.slice("--domain=".length);
      if (value === "") {
        fail("--domain needs a value, e.g. --domain summarly.example.com", 2);
      }
      options.domain = value;
      continue;
    }
    fail(`unknown argument: ${arg} (see --help)`, 2);
  }

  return options;
}

/**
 * Normalize the domain: tolerate a pasted URL or a trailing slash, then
 * accept only a host name (letters, digits, dots, hyphens) or localhost.
 * Anything else would end up in Caddy's site address and in the printed
 * URL, so reject it early instead of producing a broken deployment.
 */
function normalizeDomain(raw) {
  let value = String(raw).trim();
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // strip scheme
  value = value.replace(/\/.*$/, ""); // strip path/trailing slash

  if (value === "") {
    fail("domain is empty; pass --domain <name> (or leave it out for localhost)", 2);
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    fail(
      `invalid domain "${value}": use a host name such as summarly.example.com or localhost`,
      2,
    );
  }
  return value.toLowerCase();
}

/**
 * Ask for the domain when nothing was supplied and a human is present.
 * Non-interactive runs (CI, piped stdin) fall back to localhost instead of
 * hanging on a prompt nobody can answer.
 */
async function resolveDomain(options) {
  if (options.domain !== undefined) {
    return normalizeDomain(options.domain);
  }

  const fromEnv = process.env.DOMAIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return normalizeDomain(fromEnv);
  }

  if (!process.stdin.isTTY) {
    return "localhost";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Domain [localhost]: ");
    return normalizeDomain(answer.trim() === "" ? "localhost" : answer);
  } finally {
    rl.close();
  }
}

/**
 * Replace `KEY=...` in the example file, preserving comments, blank lines
 * and the file's line endings (the value match stops before CR/LF, so a
 * CRLF checkout stays CRLF). Only the first uncommented occurrence of a
 * key is rewritten; commented examples (`# KEY=`) are left untouched.
 */
function replaceAssignment(content, key, value) {
  const pattern = new RegExp(`^${key}=[^\\r\\n]*`, "m");
  if (!pattern.test(content)) {
    return content;
  }
  return content.replace(pattern, () => `${key}=${value}`);
}

function hasAssignment(content, key) {
  return new RegExp(`^${key}=`, "m").test(content);
}

/** Build the new .env text from .env.example plus generated values. */
function buildEnvFile(domain) {
  const postgresPassword = randomBytes(24).toString("base64url");
  const encryptionKey = randomBytes(32).toString("base64");

  // Sanity-check the generated key before it reaches the file: the backend
  // rejects anything that is not 32 base64 bytes, and a bad .env would only
  // surface later as a failed startup.
  const decoded = Buffer.from(encryptionKey, "base64");
  if (decoded.length !== 32) {
    fail("internal error: generated ENCRYPTION_KEY is not 32 bytes");
  }

  let content = readFileSync(envExamplePath, "utf8");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";

  content = replaceAssignment(content, "DOMAIN", domain);
  content = replaceAssignment(content, "POSTGRES_PASSWORD", postgresPassword);
  content = replaceAssignment(content, "ENCRYPTION_KEY", encryptionKey);
  content = replaceAssignment(content, "COOKIE_SECURE", "true");

  // Defensive: if a key is ever removed from .env.example, still produce a
  // complete file rather than a silently broken deployment.
  const missing = [
    ["DOMAIN", domain],
    ["POSTGRES_PASSWORD", postgresPassword],
    ["ENCRYPTION_KEY", encryptionKey],
    ["COOKIE_SECURE", "true"],
  ].filter(([key]) => !hasAssignment(content, key));

  if (missing.length > 0) {
    if (!content.endsWith(newline)) {
      content += newline;
    }
    content += `${newline}# Added by scripts/setup.mjs (missing from .env.example)${newline}`;
    for (const [key, value] of missing) {
      content += `${key}=${value}${newline}`;
    }
  }

  return content;
}

function writeEnvFile(content) {
  // `mode` applies on creation; chmod covers a pre-existing file replaced
  // with --force. Windows ignores POSIX bits — hence best effort.
  writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows: no POSIX permissions to set. Not fatal.
  }
}

function run(command, args, extraOptions = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    ...extraOptions,
  });
}

function ensureDockerCompose() {
  const result = run("docker", ["compose", "version"], { stdio: "ignore" });

  if (result.error || result.status !== 0) {
    fail(
      [
        "Docker Compose v2 is not available.",
        "",
        "Prerequisites:",
        "  - Docker Engine 24+ with the Compose v2 plugin (`docker compose version`).",
        "  - ~2 GB free disk for images, plus room for the database and backups.",
        "  - Ports 80/tcp, 443/tcp and 443/udp reachable for Caddy.",
        "",
        "Install Docker (https://docs.docker.com/engine/install/), make sure your",
        "user can run it, then rerun: npm run setup",
      ].join("\n"),
    );
  }
}

function composeUp() {
  log("\nBuilding and starting the stack (first build takes a few minutes)...");
  const up = run("docker", ["compose", "up", "-d", "--build", "--wait"], {
    stdio: "inherit",
  });

  if (up.error || up.status !== 0) {
    log("\nThe stack did not come up cleanly. Recent logs:");
    run("docker", ["compose", "logs", "--tail=200"], { stdio: "inherit" });
    fail(
      [
        "`docker compose up -d --build --wait` failed.",
        "",
        "Next steps:",
        "  - Read the logs above and the recovery table in docs/deployment.md.",
        "  - Fix the reported problem, then rerun: docker compose up -d --build --wait",
        "  - Do NOT run `docker compose down -v`: it deletes the database and the",
        "    WhatsApp session volume.",
        "  - The generated .env is kept; rerunning this script refuses to overwrite",
        "    it unless you pass --force.",
      ].join("\n"),
    );
  }
}

function printSummary(domain, started) {
  const url = `https://${domain}`;
  const lines = ["", "Summarly is configured.", `  URL: ${url}`];

  if (domain === "localhost") {
    lines.push(
      "  Note: localhost uses Caddy's local CA. Browsers warn until you trust",
      "        its root certificate:",
      "        docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt",
    );
  }

  lines.push("");
  if (started) {
    lines.push("First run:");
  } else {
    lines.push(
      "Compose was not started (--no-start). Start it with:",
      "  docker compose up -d --build --wait",
      "",
      "First run:",
    );
  }

  lines.push(
    `  1. Open ${url}/ and complete /setup (admin password + recovery codes).`,
    "  2. Settings: configure the AI provider (Google Gemini, or the mock).",
    "  3. Connection: link WhatsApp (the QR/pairing payload appears there).",
    "  4. Groups: opt a group into monitoring, then request or schedule summaries.",
    "",
    "Logs:    docker compose logs -f",
    "Backups: docs/deployment.md (database, WhatsApp session, ENCRYPTION_KEY)",
    "",
    "The generated secrets are in .env only; they were not printed.",
    "Back up .env and ENCRYPTION_KEY separately from the database — without",
    "ENCRYPTION_KEY, saved provider API keys cannot be decrypted after a restore.",
    "",
  );

  process.stdout.write(lines.join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (!existsSync(envExamplePath)) {
    fail(`missing ${envExamplePath}: run this script from a full checkout of the repository.`);
  }

  if (existsSync(envPath) && !options.force) {
    fail(
      [
        ".env already exists at the repository root, so nothing was changed.",
        "",
        "  - To keep the current configuration: just start the stack with",
        "      docker compose up -d --build --wait",
        "  - To regenerate it (NEW secrets, existing database password will no",
        "    longer match the running PostgreSQL volume): rerun with --force.",
        "    Existing volumes are not deleted, but a changed POSTGRES_PASSWORD",
        "    only takes effect after the database is recreated or the role's",
        "    password is updated manually — read docs/deployment.md first.",
      ].join("\n"),
    );
  }

  const domain = await resolveDomain(options);

  // Check the prerequisite BEFORE writing .env: a failed check would
  // otherwise leave a generated .env behind that a plain rerun refuses to
  // touch, forcing --force for no good reason.
  if (!options.noStart) {
    ensureDockerCompose();
  }

  log(`Writing .env for DOMAIN=${domain} (secrets generated locally, not printed)...`);
  const content = buildEnvFile(domain);
  writeEnvFile(content);
  log(`Wrote ${envPath}`);

  if (options.noStart) {
    printSummary(domain, false);
    return;
  }

  composeUp();
  printSummary(domain, true);
}

main().catch((error) => {
  // Never dump the environment or file contents: the error may originate
  // next to secret material.
  fail(error instanceof Error ? error.message : String(error));
});
