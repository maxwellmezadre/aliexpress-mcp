import type { Database } from "bun:sqlite";
import { openCache } from "./cache/db.js";
import { type CacheRepo, createCacheRepo } from "./cache/repo.js";
import { type Config, loadConfig } from "./config.js";
import { type FetchLike, type Http, createHttp } from "./core/http.js";
import { type Logger, createLogger } from "./core/logger.js";
import { type MtopClient, createMtopClient } from "./mtop/client.js";
import { type SessionStore, createSessionStore } from "./session/store.js";

// Explicit DI container. Everything a tool needs hangs off `Ctx`, and every
// temporal/IO collaborator can be replaced in tests. No singletons, no
// framework: `createContext(loadConfig())` is the whole wiring.

export type ContextDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  session?: SessionStore;
  log?: Logger;
  /** `:memory:` in tests. */
  db?: Database;
};

export type Ctx = {
  config: Config;
  log: Logger;
  now: () => number;
  session: SessionStore;
  http: Http;
  mtop: MtopClient;
  /** Memoised: the SQLite file is only opened (and migrated) on first use, so
   *  a tool that never touches the cache never creates it. */
  cache: () => CacheRepo;
  /** Closes what was opened. Safe to call more than once. */
  dispose: () => void;
};

export function createContext(config: Config, deps: ContextDeps = {}): Ctx {
  const now = deps.now ?? (() => Date.now());
  const session = deps.session ?? createSessionStore(config);
  // The logger reads the cookie values through a provider, so redaction keeps
  // working after MTOP rotates `_m_h5_tk` mid-session.
  const log =
    deps.log ??
    createLogger({
      ...(config.logFile ? { logFile: config.logFile } : {}),
      secrets: () => session.peekSecrets(),
    });

  const http = createHttp(
    {
      session,
      siteBaseUrl: config.siteBaseUrl,
      minIntervalMs: config.minIntervalMs,
      jitterMs: config.jitterMs,
      timeoutMs: config.httpTimeoutMs,
      log,
    },
    {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      now,
    },
  );

  const mtop = createMtopClient(
    { http, acsBaseUrl: config.acsBaseUrl, siteBaseUrl: config.siteBaseUrl, log },
    { now, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );

  let db: Database | undefined;
  let repo: CacheRepo | undefined;
  const cache = (): CacheRepo => {
    if (!repo) {
      db = deps.db ?? openCache(config.dbPath);
      repo = createCacheRepo(db, now);
    }
    return repo;
  };

  return {
    config,
    log,
    now,
    session,
    http,
    mtop,
    cache,
    dispose: () => {
      if (deps.db === undefined) db?.close();
      db = undefined;
      repo = undefined;
    },
  };
}

/** Convenience for the entry points: load the env config and wire everything. */
export const contextFromEnv = (): Ctx => createContext(loadConfig());
