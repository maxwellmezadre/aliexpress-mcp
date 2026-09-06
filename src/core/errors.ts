// Error taxonomy for everything that talks to AliExpress. Messages are
// user-facing (pt-BR) and actionable; the classes let callers (mtop client,
// sync, tools, CLI) branch on the *kind* of failure without parsing text.

export const LOGIN_HINT = "Rode `aliexpress login` no terminal (login manual no navegador).";

/**
 * MTOP answered with a `ret[0]` that is not SUCCESS. `retCode` is the part
 * before `::` (e.g. `FAIL_SYS_TRAFFIC_LIMIT`), which is stable across locales —
 * the human half after `::` is Chinese and must never be shown alone.
 */
export class MtopError extends Error {
  constructor(
    public readonly retCode: string,
    public readonly ret: string,
    public readonly api: string,
    hint?: string,
  ) {
    super(`AliExpress respondeu ${retCode} em ${api}` + (hint ? ` — ${hint}` : ""));
    this.name = "MtopError";
  }
}

/** No session, or AliExpress rejected it. Fix: `aliexpress login`. */
export class AuthError extends Error {
  constructor(message: string) {
    super(`${message} ${LOGIN_HINT}`);
    this.name = "AuthError";
  }
}

/**
 * Anti-bot challenge (`FAIL_SYS_USER_VALIDATE`, Baxia/x5sec). The client is
 * disabled for the rest of the process and a cooldown is persisted, because
 * retrying is what deepens the block.
 */
export class CaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaError";
  }
}

/** Transport-level failure (network, unexpected status/redirect, non-JSON body). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** MTOP rate limit (`FAIL_SYS_TRAFFIC_LIMIT`) survived every backoff. */
export class RateLimitError extends Error {
  constructor(
    public readonly attempts: number,
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** The encrypted session file or its key is unusable. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/** The interactive browser login did not complete. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * The Ultron/DX payload no longer looks like what the parsers expect — the
 * AliExpress front-end changed. Actionable: `aliexpress doctor` says which
 * layer broke, `docs/REDISCOVERY.md` says how to remap it.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(`${message} Rode \`aliexpress doctor\` para ver qual camada quebrou.`);
    this.name = "ParseError";
  }
}
