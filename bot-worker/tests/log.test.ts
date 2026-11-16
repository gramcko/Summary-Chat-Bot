import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, isLogLevel, silentLogger } from "../src/lib/log.js";

/**
 * LOG_FILE sink (diagnostic file logging): the file receives exactly the
 * lines the worker prints (same JSON, after level filtering), the parent
 * directory is created on demand, and an unusable path never throws.
 */
describe("createLogger file sink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "summarly-log-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends the same line it writes to stdout", () => {
    const file = join(dir, "nested", "bot-worker.log");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const log = createLogger("bot-worker", "info", file);

    log("info", "history_request_sent", { groupId: "g-1", round: 2 });

    expect(existsSync(file)).toBe(true);
    const printed = String(stdout.mock.calls[0]?.[0] ?? "");
    const written = readFileSync(file, "utf8");
    expect(written).toBe(printed);
    const record = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(record["service"]).toBe("bot-worker");
    expect(record["level"]).toBe("info");
    expect(record["event"]).toBe("history_request_sent");
    expect(record["groupId"]).toBe("g-1");
    expect(record["round"]).toBe(2);
  });

  it("never writes filtered-out levels to the file", () => {
    const file = join(dir, "bot-worker.log");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger("bot-worker", "warn", file);

    log("info", "should_be_dropped");
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe("");

    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    log("error", "kept", { reason: "boom" });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(String(stderr.mock.calls[0]?.[0] ?? "")).toContain("kept");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "error",
      event: "kept",
      reason: "boom",
    });
  });

  it("appends across logger instances instead of truncating", () => {
    const file = join(dir, "bot-worker.log");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    writeFileSync(file, '{"event":"earlier"}\n', "utf8");

    createLogger("bot-worker", "info", file)("info", "later");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"event":"earlier"}');
  });

  it("does not throw when the log file cannot be written", () => {
    // A directory where the file should be: append fails with EISDIR.
    const unusable = join(dir, "as-a-directory");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    // Create the "file" as a directory.
    createLogger("bot-worker", "info", join(unusable, "x.log"))("info", "seed");
    const log = createLogger("bot-worker", "info", unusable);

    expect(() => log("info", "still_logging")).not.toThrow();
    expect(stdout).toHaveBeenCalled();
  });

  it("keeps console logging when no file is configured", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const log = createLogger("bot-worker", "info", "   ");

    log("info", "console_only");

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(existsSync(join(process.cwd(), "   "))).toBe(false);
  });

  it("exposes the level guard and a silent logger", () => {
    expect(isLogLevel("debug")).toBe(true);
    expect(isLogLevel("trace")).toBe(false);
    expect(() => silentLogger("info", "nothing")).not.toThrow();
  });
});
