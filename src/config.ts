import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// TypeBox is the single source of truth for the config. Every value comes from
// the environment (12-factor, `ALIEXPRESS_` prefix); no `.env` files are read.
// The schema describes the *parsed* object (booleans, ints, absolute paths),
// not the raw strings.

export const BROWSER_CHANNELS = ["chrome", "chromium", "msedge"] as const;
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

/** Chromium-based browsers whose cookie store can be imported (macOS). */
export const IMPORT_BROWSERS = ["arc", "chrome", "chromium", "brave", "edge"] as const;
export type ImportBrowser = (typeof IMPORT_BROWSERS)[number];

/** MTOP host. Every signed API call goes to `${acsBaseUrl}/h5/{api}/{v}/`. */
export const DEFAULT_ACS_BASE_URL = "https://acs.aliexpress.com";
/** Web host used as Referer/Origin and for the login flow. */
export const DEFAULT_SITE_BASE_URL = "https://www.aliexpress.com";
export const SESSION_KEY_BYTES = 32;

export const ConfigSchema = Type.Object({
  /** Everything the tool persists lives under this directory. */
  configDir: Type.String({ minLength: 1 }),
  sessionPath: Type.String({ minLength: 1 }),
  keyPath: Type.String({ minLength: 1 }),
  dbPath: Type.String({ minLength: 1 }),
  browserProfileDir: Type.String({ minLength: 1 }),
  /** The only directory `export` may write to. */
  exportDir: Type.String({ minLength: 1 }),
  /** Base64 of 32 bytes. When absent the key file under configDir is used/created. */
  sessionKey: Type.Optional(Type.String({ minLength: 1 })),
  readOnly: Type.Boolean(),
  compact: Type.Boolean(),
  logFile: Type.Optional(Type.String({ minLength: 1 })),
  browserChannel: Type.Union([
    Type.Literal("chrome"),
    Type.Literal("chromium"),
    Type.Literal("msedge"),
  ]),
  /** When set, `login` imports the session from this browser instead of opening a window. */
  importBrowser: Type.Optional(
    Type.Union([
      Type.Literal("arc"),
      Type.Literal("chrome"),
      Type.Literal("chromium"),
      Type.Literal("brave"),
      Type.Literal("edge"),
    ]),
  ),
  /**
   * Regional parameters. Normally derived from the `aep_usuc_f` cookie captured
   * at login; these env vars only override it (other accounts, other markets).
   */
  region: Type.Optional(Type.String({ minLength: 2 })),
  locale: Type.Optional(Type.String({ minLength: 2 })),
  currency: Type.Optional(Type.String({ minLength: 3 })),
  /** Minimum gap between two AliExpress requests (plus random jitter). */
  minIntervalMs: Type.Integer({ minimum: 0 }),
  jitterMs: Type.Integer({ minimum: 0 }),
  httpTimeoutMs: Type.Integer({ minimum: 1000 }),
  /** Overridable for tests (fake server). */
  acsBaseUrl: Type.String({ minLength: 1 }),
  siteBaseUrl: Type.String({ minLength: 1 }),
});

export type Config = Static<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Configuração inválida do aliexpress-mcp:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function readOptional(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

/** MCP client configs are JSON, not shell: `~/` has to be expanded by hand. */
function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function readBool(problems: string[], env: Env, key: string, fallback: boolean): boolean {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  problems.push(`${key} deve ser boolean (1/0, true/false, yes/no, on/off), veio "${raw}"`);
  return fallback;
}

function readInt(problems: string[], env: Env, key: string, fallback: number, min: number): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    problems.push(`${key} deve ser inteiro >= ${min}, veio "${raw}"`);
    return fallback;
  }
  return parsed;
}

function readEnum<T extends string>(
  problems: string[],
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T | undefined,
): T | undefined {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${key} deve ser ${allowed.join("|")}, veio "${raw}"`);
  return fallback;
}

function readSessionKey(problems: string[], env: Env): string | undefined {
  const raw = readOptional(env, "ALIEXPRESS_SESSION_KEY");
  if (raw === undefined) return undefined;
  if (Buffer.from(raw, "base64").length !== SESSION_KEY_BYTES) {
    problems.push(
      `ALIEXPRESS_SESSION_KEY deve ser base64 de ${SESSION_KEY_BYTES} bytes (gere com: openssl rand -base64 32)`,
    );
    return undefined;
  }
  return raw;
}

function readUrl(problems: string[], env: Env, key: string, fallback: string): string {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    problems.push(`${key} deve ser uma URL http(s), veio "${raw}"`);
    return fallback;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Loads and validates the config from the environment (fail-fast). Every
 * problem is collected so the user fixes all of them in one go. Nothing is
 * required: a missing session fails at call time with an actionable
 * `AuthError`, not at boot.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const configDir = expandHome(
    readOptional(env, "ALIEXPRESS_CONFIG_DIR") ?? join(homedir(), ".config", "aliexpress-mcp"),
  );

  const config: Config = {
    configDir,
    sessionPath: join(configDir, "session.enc"),
    keyPath: join(configDir, "session.key"),
    dbPath: join(configDir, "cache.db"),
    browserProfileDir: join(configDir, "browser-profile"),
    exportDir: expandHome(
      readOptional(env, "ALIEXPRESS_EXPORT_DIR") ?? join(homedir(), "Downloads", "aliexpress-export"),
    ),
    sessionKey: readSessionKey(problems, env),
    readOnly: readBool(problems, env, "ALIEXPRESS_READ_ONLY", false),
    compact: readBool(problems, env, "ALIEXPRESS_COMPACT", false),
    logFile: readOptional(env, "ALIEXPRESS_LOG_FILE"),
    browserChannel: readEnum(problems, env, "ALIEXPRESS_BROWSER_CHANNEL", BROWSER_CHANNELS, "chrome") as BrowserChannel,
    importBrowser: readEnum(problems, env, "ALIEXPRESS_IMPORT_BROWSER", IMPORT_BROWSERS, undefined),
    region: readOptional(env, "ALIEXPRESS_REGION"),
    locale: readOptional(env, "ALIEXPRESS_LOCALE"),
    currency: readOptional(env, "ALIEXPRESS_CURRENCY"),
    // ~0.4–0.6 s per request: the full 7-page crawl ran stable at 350 ms.
    minIntervalMs: readInt(problems, env, "ALIEXPRESS_MIN_INTERVAL_MS", 400, 0),
    jitterMs: readInt(problems, env, "ALIEXPRESS_JITTER_MS", 200, 0),
    httpTimeoutMs: readInt(problems, env, "ALIEXPRESS_HTTP_TIMEOUT_MS", 30_000, 1000),
    acsBaseUrl: readUrl(problems, env, "ALIEXPRESS_ACS_BASE_URL", DEFAULT_ACS_BASE_URL),
    siteBaseUrl: readUrl(problems, env, "ALIEXPRESS_SITE_BASE_URL", DEFAULT_SITE_BASE_URL),
  };

  // Safety net: the parsed object must match the schema (catches any drift
  // between the readers above and the declared shape).
  if (!Value.Check(ConfigSchema, config)) {
    for (const error of Value.Errors(ConfigSchema, config)) {
      problems.push(`${error.path || "/"}: ${error.message}`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
