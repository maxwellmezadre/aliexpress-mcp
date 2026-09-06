import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";

// loadConfig takes `env` as a parameter so tests never touch process.env.
const base = { ALIEXPRESS_CONFIG_DIR: "/tmp/ae-test" };

describe("loadConfig defaults", () => {
  test("derives every path from the config dir", () => {
    const config = loadConfig(base);
    expect(config.configDir).toBe("/tmp/ae-test");
    expect(config.sessionPath).toBe("/tmp/ae-test/session.enc");
    expect(config.keyPath).toBe("/tmp/ae-test/session.key");
    expect(config.dbPath).toBe("/tmp/ae-test/cache.db");
    expect(config.browserProfileDir).toBe("/tmp/ae-test/browser-profile");
  });

  test("falls back to ~/.config/aliexpress-mcp", () => {
    const config = loadConfig({});
    expect(config.configDir).toBe(join(homedir(), ".config", "aliexpress-mcp"));
    expect(config.exportDir).toBe(join(homedir(), "Downloads", "aliexpress-export"));
  });

  test("expands a leading ~/ (MCP configs are JSON, not shell)", () => {
    const config = loadConfig({ ALIEXPRESS_CONFIG_DIR: "~/ae", ALIEXPRESS_EXPORT_DIR: "~/out" });
    expect(config.configDir).toBe(join(homedir(), "ae"));
    expect(config.exportDir).toBe(join(homedir(), "out"));
  });

  test("keeps the conservative pacing defaults", () => {
    const config = loadConfig(base);
    expect(config.minIntervalMs).toBe(400);
    expect(config.jitterMs).toBe(200);
    expect(config.httpTimeoutMs).toBe(30_000);
    expect(config.readOnly).toBe(false);
    expect(config.compact).toBe(false);
  });
});

describe("loadConfig validation", () => {
  test("accepts every documented boolean spelling", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(loadConfig({ ...base, ALIEXPRESS_READ_ONLY: value }).readOnly).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(loadConfig({ ...base, ALIEXPRESS_READ_ONLY: value }).readOnly).toBe(false);
    }
  });

  test("rejects a non-boolean instead of defaulting silently", () => {
    expect(() => loadConfig({ ...base, ALIEXPRESS_COMPACT: "maybe" })).toThrow(ConfigError);
  });

  test("rejects a session key that is not 32 bytes of base64", () => {
    expect(() => loadConfig({ ...base, ALIEXPRESS_SESSION_KEY: "dG9vIHNob3J0" })).toThrow(
      /32 bytes/,
    );
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(loadConfig({ ...base, ALIEXPRESS_SESSION_KEY: key }).sessionKey).toBe(key);
  });

  test("rejects an unknown browser channel and a non-http base url", () => {
    expect(() => loadConfig({ ...base, ALIEXPRESS_BROWSER_CHANNEL: "safari" })).toThrow(
      /chrome\|chromium\|msedge/,
    );
    expect(() => loadConfig({ ...base, ALIEXPRESS_ACS_BASE_URL: "ftp://x" })).toThrow(/http\(s\)/);
  });

  test("reports every problem at once so the user fixes them in one go", () => {
    try {
      loadConfig({
        ...base,
        ALIEXPRESS_READ_ONLY: "maybe",
        ALIEXPRESS_MIN_INTERVAL_MS: "-5",
        ALIEXPRESS_IMPORT_BROWSER: "safari",
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(3);
    }
  });

  test("strips trailing slashes from the base urls", () => {
    const config = loadConfig({ ...base, ALIEXPRESS_ACS_BASE_URL: "https://acs.example.com/" });
    expect(config.acsBaseUrl).toBe("https://acs.example.com");
  });
});
