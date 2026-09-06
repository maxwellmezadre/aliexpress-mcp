import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_SECRET_LENGTH, createLogger, redactSecrets } from "../src/core/logger.js";

const dir = mkdtempSync(join(tmpdir(), "ae-logger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("redactSecrets", () => {
  test("replaces every occurrence of a secret", () => {
    expect(redactSecrets("cookie=abcdefgh12 and abcdefgh12", ["abcdefgh12"])).toBe(
      "cookie=*** and ***",
    );
  });

  test("ignores values shorter than the minimum (a 1-char cookie would erase every s)", () => {
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(redactSecrets("session status", ["s"])).toBe("session status");
    expect(redactSecrets("short", ["1234567"])).toBe("short");
  });
});

describe("createLogger", () => {
  test("writes to the sink with the level prefix and never to stdout", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    log.info("hello");
    log.error("boom");
    expect(lines).toEqual(["[info] hello\n", "[error] boom\n"]);
  });

  test("follows a function secrets source (cookies renew mid-session)", () => {
    const lines: string[] = [];
    let token = "aaaaaaaaaa";
    const log = createLogger({ sink: (line) => lines.push(line), secrets: () => [token] });
    log.info(`token ${token}`);
    token = "bbbbbbbbbb";
    log.info(`token ${token}`);
    expect(lines).toEqual(["[info] token ***\n", "[info] token ***\n"]);
  });

  test("mirrors to the log file when configured", () => {
    const logFile = join(dir, "ae.log");
    const log = createLogger({ logFile, sink: () => undefined });
    log.warn("to disk");
    expect(readFileSync(logFile, "utf8")).toBe("[warn] to disk\n");
  });

  test("a failing file sink never takes the process down", () => {
    const log = createLogger({ logFile: join(dir, "missing", "deep.log"), sink: () => undefined });
    expect(() => log.info("still fine")).not.toThrow();
  });
});
