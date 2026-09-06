// Pure cookie-jar helpers, no I/O. The cookie shape is Playwright's
// (`context.cookies()` / `storageState`), so the login bootstrap persists
// exactly what it captured — including the HttpOnly session cookies that
// `document.cookie` never shows — and the MTOP client rebuilds the `Cookie:`
// header from it.

export type SameSite = "Strict" | "Lax" | "None";

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie (Playwright's convention). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSite;
};

export type MergeResult = {
  cookies: Cookie[];
  /** True when a value or expiry actually changed — the trigger to persist. */
  changed: boolean;
  /** Set-Cookie lines that could not be parsed. */
  skipped: number;
};

const stripDot = (domain: string): string => domain.replace(/^\./, "").toLowerCase();

/**
 * Deliberately liberal: a host-only cookie (`aliexpress.com`) also matches
 * subdomains. The session spans `www.aliexpress.com` and `acs.aliexpress.com`,
 * and the RFC 6265 host-only rule would drop cookies the browser itself sent
 * for that same registrable domain.
 */
export function hostMatches(host: string, domain: string): boolean {
  const wanted = stripDot(domain);
  const actual = host.toLowerCase();
  return actual === wanted || actual.endsWith(`.${wanted}`);
}

/** Builds the `Cookie:` header value for `url` from the cookies that apply. */
export function cookieHeader(cookies: readonly Cookie[], url: URL, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  return cookies
    .filter(
      (cookie) =>
        hostMatches(url.hostname, cookie.domain) &&
        // ponytail: prefix match, not the RFC 6265 path-segment rule.
        url.pathname.startsWith(cookie.path) &&
        (cookie.expires === -1 || cookie.expires > nowSeconds) &&
        (!cookie.secure || url.protocol === "https:"),
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

const keyOf = (cookie: Cookie): string => `${cookie.name}|${stripDot(cookie.domain)}|${cookie.path}`;

function expiresOf(parsed: Bun.Cookie, nowSeconds: number): number {
  if (typeof parsed.maxAge === "number") return nowSeconds + parsed.maxAge;
  const { expires } = parsed;
  if (expires instanceof Date) return Math.floor(expires.getTime() / 1000);
  if (typeof expires === "number") return expires > 1e11 ? Math.floor(expires / 1000) : expires;
  return -1;
}

function sameSiteOf(value: string | undefined): SameSite | undefined {
  switch (value) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
      return "None";
    default:
      return undefined;
  }
}

function sameCookie(a: Cookie, b: Cookie): boolean {
  return (
    a.value === b.value &&
    a.expires === b.expires &&
    // Normalised: some parsers keep the leading dot and some drop it, and a
    // spurious difference here would rewrite the session file on every request.
    stripDot(a.domain) === stripDot(b.domain) &&
    a.path === b.path &&
    a.httpOnly === b.httpOnly &&
    a.secure === b.secure
  );
}

/**
 * Applies `Set-Cookie` lines from a response to the jar. Cookies are keyed by
 * (name, domain, path); expired ones (`Max-Age=0`, past `Expires`) are removed.
 * Insertion order is preserved so the `Cookie:` header stays stable.
 *
 * This is not an optimisation: MTOP renews `_m_h5_tk` through `Set-Cookie`, and
 * a request signed with a stale token is rejected.
 */
export function mergeSetCookie(
  cookies: readonly Cookie[],
  lines: readonly string[],
  requestHost: string,
  nowMs: number,
): MergeResult {
  const nowSeconds = Math.floor(nowMs / 1000);
  const next = new Map(cookies.map((cookie) => [keyOf(cookie), cookie]));
  let changed = false;
  let skipped = 0;

  for (const line of lines) {
    let parsed: Bun.Cookie;
    try {
      parsed = Bun.Cookie.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const incoming: Cookie = {
      name: parsed.name,
      value: parsed.value,
      domain: parsed.domain ?? requestHost,
      path: parsed.path || "/",
      expires: expiresOf(parsed, nowSeconds),
      httpOnly: parsed.httpOnly,
      secure: parsed.secure,
      sameSite: sameSiteOf(parsed.sameSite),
    };
    const key = keyOf(incoming);
    const current = next.get(key);
    const dead = incoming.expires !== -1 && incoming.expires <= nowSeconds;
    if (dead) {
      if (current) {
        next.delete(key);
        changed = true;
      }
      continue;
    }
    if (!current || !sameCookie(current, incoming)) {
      next.set(key, incoming);
      changed = true;
    }
  }

  return { cookies: [...next.values()], changed, skipped };
}

export function findCookie(cookies: readonly Cookie[], name: string): Cookie | undefined {
  return cookies.find((cookie) => cookie.name === name);
}

/**
 * The MTOP anti-abuse token. The cookie is `<token>_<expiresAtMs>`; only the
 * part before the first `_` goes into the signature. This is NOT authentication
 * — the session cookies are — it is a short-lived token the server itself
 * issues and rotates.
 *
 * A jar can legitimately hold two `_m_h5_tk` entries (one scoped to
 * `.aliexpress.com`, one to `acs.aliexpress.com`); the browser sends both and
 * picking the wrong one costs a whole retry round. The trailing timestamp says
 * which is fresher, so that is the one we sign with.
 */
export function mtopToken(cookies: readonly Cookie[]): string {
  let token = "";
  let freshest = Number.NEGATIVE_INFINITY;
  for (const candidate of cookies) {
    if (candidate.name !== "_m_h5_tk") continue;
    const [value, expiresAt] = candidate.value.split("_");
    if (!value) continue;
    const stamp = Number(expiresAt);
    const rank = Number.isFinite(stamp) ? stamp : 0;
    if (rank >= freshest) {
      freshest = rank;
      token = value;
    }
  }
  return token;
}

export type RegionalSettings = {
  /** `shipToCountry` in every MTOP payload. */
  region: string;
  /** `_lang`; decides the language of every status/label string that comes back. */
  locale: string;
  /** `_currency`. */
  currency: string;
  /** AliExpress member id, when the cookie carries it. */
  memberId: string | null;
};

export const DEFAULT_REGIONAL: RegionalSettings = {
  region: "US",
  locale: "en_US",
  currency: "USD",
  memberId: null,
};

/**
 * `aep_usuc_f` is a URL-encoded mini query string
 * (`region=BR&site=bra&b_locale=pt_BR&c_tp=BRL&x_alimid=...`). It is where the
 * site itself derives the regional parameters from, so reproducing it keeps our
 * payloads identical to the browser's.
 */
export function parseAepUsucF(raw: string | undefined): RegionalSettings {
  if (!raw) return DEFAULT_REGIONAL;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is not worth failing a request over.
  }
  const params = new URLSearchParams(decoded);
  const region = params.get("region") || DEFAULT_REGIONAL.region;
  return {
    // CN is the seller-side site and has no buyer order list; fall back to US.
    region: region === "CN" ? "US" : region,
    locale: params.get("b_locale") || DEFAULT_REGIONAL.locale,
    currency: params.get("c_tp") || DEFAULT_REGIONAL.currency,
    memberId: params.get("x_alimid") || null,
  };
}

/** Regional settings of the saved session, straight from its `aep_usuc_f`. */
export function regionalFromJar(cookies: readonly Cookie[]): RegionalSettings {
  return parseAepUsucF(findCookie(cookies, "aep_usuc_f")?.value);
}
