import {
  type Cookie,
  type RegionalSettings,
  cookieHeader,
  mergeSetCookie,
  mtopToken,
} from "../session/jar.js";
import type { SessionData, SessionStore } from "../session/store.js";
import { AuthError, CaptchaError, HttpError } from "./errors.js";
import type { Logger } from "./logger.js";

// The single funnel to AliExpress. It exists to enforce the anti-bot contract
// in ONE place:
//   - strictly serial: requests never overlap, even from concurrent tool calls;
//   - a minimum gap plus random jitter between requests;
//   - exponential backoff on transient failures (network, 429, 5xx);
//   - a circuit breaker with a cooldown that survives the process, so a retry
//     loop cannot deepen an anti-bot block;
//   - `redirect: "manual"`, because a 302 to the login page is a dead session,
//     not a page worth downloading;
//   - Set-Cookie absorption: MTOP rotates `_m_h5_tk` through it, and a request
//     signed with a stale token is rejected.
// It knows nothing about the MTOP envelope — that lives in src/mtop. Every
// temporal collaborator (fetch, sleep, now, random) is injectable so the tests
// are deterministic without fake timers.

export type FetchResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
  text(): Promise<string>;
};
export type FetchInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  redirect: "manual";
  body?: string;
  signal?: AbortSignal;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type HttpDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export type HttpRequest = {
  url: string;
  method: "GET" | "POST";
  /** Extra headers; `cookie` and `user-agent` are added by this layer. */
  headers?: Record<string, string>;
  body?: string;
  /** Short label for logs and error messages (never the full URL: it carries ids). */
  label: string;
};

export type HttpResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
};

export type HttpState = {
  tripped: boolean;
  authDead: boolean;
  requests: number;
  lastRequestAt: number | null;
};

/** Persisted anti-bot cooldown (unix ms); survives the process. */
export type CooldownStore = { get(): number | null; set(until: number): void };

export type HttpOptions = {
  session: SessionStore;
  siteBaseUrl: string;
  minIntervalMs: number;
  jitterMs: number;
  timeoutMs: number;
  log: Logger;
  cooldown?: CooldownStore;
};

export type Http = {
  /** Runs `fn` in the serial queue: the next one starts only after it settles. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Sends one paced request with the session cookies. Call it inside `serial`. */
  send(request: HttpRequest): Promise<HttpResponse>;
  /** Current `_m_h5_tk` prefix, for the MTOP signature. Empty when absent. */
  token(): string;
  regional(): RegionalSettings;
  userAgent(): string;
  cookies(): readonly Cookie[];
  /** Trips the breaker for the rest of the process and persists the cooldown. */
  trip(reason: string): never;
  /** Marks the session dead so the next call fails without spending a request. */
  markAuthDead(message: string): never;
  state(): HttpState;
  /** Active anti-bot cooldown (unix ms) or null. */
  cooldownUntil(): number | null;
  /** Forget the loaded jar so the next request re-reads the store (after an in-process login). */
  resetSession(): void;
};

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const MAX_ATTEMPTS = 4;
/** After an anti-bot verdict, no request for this long — even from a new process. */
export const COOLDOWN_MS = 30 * 60_000;

export const CAPTCHA_MESSAGE =
  "O AliExpress exigiu verificação anti-bot para esta sessão. O cliente foi desativado neste " +
  "processo: abra aliexpress.com no seu navegador, resolva o desafio se aparecer, espere alguns " +
  "minutos e rode `aliexpress login`.";

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const realFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as Promise<FetchResponse>;

export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);

const isTransient = (status: number): boolean => status === 429 || status >= 500;

export function createHttp(opts: HttpOptions, deps: HttpDeps = {}): Http {
  const fetchImpl = deps.fetch ?? realFetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const { session, log } = opts;

  let jar: SessionData | null = null;
  let loadedMtime: number | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let tripped = false;
  let authDead = false;
  let requests = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Loads the jar lazily and reloads it after the user ran `aliexpress login`
   * (the session file changed since we loaded it) — no MCP restart needed.
   */
  function ensureSession(): SessionData {
    const mtime = session.mtimeMs();
    if (jar === null || (authDead && mtime !== loadedMtime)) {
      jar = session.load();
      loadedMtime = mtime;
      authDead = false;
    }
    if (jar === null) throw new AuthError("Nenhuma sessão do AliExpress salva.");
    if (authDead) throw new AuthError("A sessão do AliExpress expirou ou foi rejeitada.");
    return jar;
  }

  const untilLabel = (until: number): string =>
    new Date(until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  function trip(reason: string): never {
    tripped = true;
    const until = now() + COOLDOWN_MS;
    opts.cooldown?.set(until);
    log.error(
      `anti-bot challenge detected (${reason}); client disabled for this process, cooldown until ${untilLabel(until)}`,
    );
    throw new CaptchaError(`${CAPTCHA_MESSAGE} Aguarde até ${untilLabel(until)}.`);
  }

  function markAuthDead(message: string): never {
    authDead = true;
    throw new AuthError(message);
  }

  function assertUsable(): void {
    if (tripped) throw new CaptchaError(CAPTCHA_MESSAGE);
    const until = opts.cooldown?.get() ?? null;
    if (until !== null && until > now()) {
      throw new CaptchaError(`${CAPTCHA_MESSAGE} Aguarde até ${untilLabel(until)}.`);
    }
  }

  async function gap(): Promise<void> {
    const wait = lastRequestAt + opts.minIntervalMs + random() * opts.jitterMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  }

  /** Token renewals arrive as Set-Cookie on any response; persist only real changes. */
  function persistCookies(response: FetchResponse, url: URL): void {
    const lines = response.headers.getSetCookie();
    if (lines.length === 0 || jar === null) return;
    const merged = mergeSetCookie(jar.cookies, lines, url.hostname, now());
    if (merged.skipped > 0) {
      log.warn(`${merged.skipped} Set-Cookie line(s) could not be parsed and were ignored`);
    }
    if (!merged.changed) return;
    jar = { ...jar, cookies: merged.cookies, savedAt: now() };
    try {
      session.save(jar);
      loadedMtime = session.mtimeMs();
    } catch (error) {
      log.warn(
        `could not persist renewed cookies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function send(request: HttpRequest): Promise<HttpResponse> {
    assertUsable();
    const current = ensureSession();
    const url = new URL(request.url);
    const started = now();

    for (let attempt = 1; ; attempt += 1) {
      await gap();
      const headers: Record<string, string> = {
        ...request.headers,
        cookie: cookieHeader(current.cookies, url, now()),
        "user-agent": current.userAgent,
      };
      let response: FetchResponse;
      try {
        response = await fetchImpl(url.toString(), {
          method: request.method,
          headers,
          redirect: "manual",
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (error) {
        requests += 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS) {
          log.warn(`${request.label} network error on attempt ${attempt}: ${reason}`);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new HttpError(0, `Falha de rede ao chamar o AliExpress em ${request.label}: ${reason}`);
      }
      requests += 1;
      const { status } = response;

      // A 3xx here is never a real redirect: MTOP answers 200 or bounces an
      // unauthenticated caller to the login page.
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location") ?? "";
        if (/login|passport/i.test(location)) {
          markAuthDead("O AliExpress redirecionou para a página de login: a sessão expirou.");
        }
        if (/punish|_____tmd_____|x5sec|captcha/i.test(location)) trip("redirect");
        throw new HttpError(
          status,
          `O AliExpress redirecionou ${request.label} para ${location || "(sem location)"}.`,
        );
      }

      persistCookies(response, url);

      if (isTransient(status) && attempt < MAX_ATTEMPTS) {
        log.warn(`${request.label} HTTP ${status} on attempt ${attempt}; backing off`);
        await sleep(backoffMs(attempt));
        continue;
      }

      const body = await response.text();
      // Baxia serves an interstitial instead of JSON when it flags the caller.
      if (/_____tmd_____|punish\?|x5secdata/i.test(body)) trip("anti-bot interstitial");

      if (isTransient(status)) {
        throw new HttpError(
          status,
          `O AliExpress respondeu HTTP ${status} em ${request.label} após ${attempt} tentativas.`,
        );
      }
      if (status >= 400) {
        throw new HttpError(status, `O AliExpress respondeu HTTP ${status} em ${request.label}.`);
      }

      // Never log headers: the cookie header is the account.
      log.debug(`${request.label} ${status} ${now() - started}ms`);
      return { status, headers: response.headers, body };
    }
  }

  return {
    serial,
    send,
    token: () => mtopToken(ensureSession().cookies),
    regional: () => ensureSession().regional,
    userAgent: () => ensureSession().userAgent,
    cookies: () => ensureSession().cookies,
    trip,
    markAuthDead,
    cooldownUntil: () => {
      const until = opts.cooldown?.get() ?? null;
      return until !== null && until > now() ? until : null;
    },
    resetSession: () => {
      jar = null;
      loadedMtime = null;
      authDead = false;
    },
    state: () => ({
      tripped,
      authDead,
      requests,
      lastRequestAt: Number.isFinite(lastRequestAt) ? lastRequestAt : null,
    }),
  };
}
