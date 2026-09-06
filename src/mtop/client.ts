import { HttpError, MtopError, RateLimitError } from "../core/errors.js";
import type { Http } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { RET_HINTS, classifyRet, retCodeOf } from "./errors.js";
import { signedCall } from "./sign.js";

// The MTOP layer: signs, sends through the shared http funnel, and classifies
// `ret[0]`. Everything above it (src/ae) works with plain typed payloads.

export type MtopOptions = {
  api: string;
  /** API version; every endpoint we use is "1.0". */
  v?: string;
  method?: "GET" | "POST";
  /** Payload; the regional keys are filled in from the session when absent. */
  data: Record<string, unknown>;
};

export type MtopResponse<T = unknown> = {
  api: string;
  v: string;
  ret: string[];
  data: T;
  traceId?: string;
};

export type MtopClient = {
  request<T = unknown>(opts: MtopOptions): Promise<MtopResponse<T>>;
  /** Requests made through this client, for `doctor` and the sync report. */
  calls(): number;
};

/** The official SDK retries 5 times; 3 is enough and never loops. */
export const MAX_TOKEN_ATTEMPTS = 3;
export const MAX_TRAFFIC_ATTEMPTS = 3;
export const TRAFFIC_BACKOFF_BASE_MS = 2_000;
export const TRAFFIC_BACKOFF_MAX_MS = 60_000;

export const trafficBackoffMs = (attempt: number): number =>
  Math.min(TRAFFIC_BACKOFF_BASE_MS * 2 ** (attempt - 1), TRAFFIC_BACKOFF_MAX_MS);

export type MtopDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMtopClient(
  opts: { http: Http; acsBaseUrl: string; siteBaseUrl: string; log: Logger },
  deps: MtopDeps = {},
): MtopClient {
  const { http, acsBaseUrl, siteBaseUrl, log } = opts;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  let calls = 0;

  function parse<T>(api: string, body: string): MtopResponse<T> {
    try {
      return JSON.parse(body) as MtopResponse<T>;
    } catch {
      throw new HttpError(200, `Resposta não-JSON do AliExpress em ${api}.`);
    }
  }

  async function attempt<T>(api: string, v: string, method: "GET" | "POST", data: string) {
    // A fresh `t` per attempt: re-signing with the old one is rejected.
    const call = signedCall({
      acsBaseUrl,
      api,
      v,
      method,
      token: http.token(),
      t: String(now()),
      data,
    });
    calls += 1;
    const response = await http.send({
      url: call.url,
      method,
      label: api,
      headers: {
        referer: `${siteBaseUrl}/`,
        origin: siteBaseUrl,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(call.body === undefined ? {} : { body: call.body }),
    });
    return parse<T>(api, response.body);
  }

  async function run<T>(options: MtopOptions): Promise<MtopResponse<T>> {
    const api = options.api;
    const v = options.v ?? "1.0";
    const method = options.method ?? "GET";
    // Serialised ONCE: the signature and the transported payload must be the
    // very same bytes.
    const data = JSON.stringify(withRegionalDefaults(options.data, http));

    let tokenAttempts = 0;
    let trafficAttempts = 0;

    for (;;) {
      const body = await attempt<T>(api, v, method, data);
      const ret = body.ret?.[0];
      const code = retCodeOf(ret);

      switch (classifyRet(ret)) {
        case "success":
          return body;

        case "token": {
          tokenAttempts += 1;
          if (tokenAttempts >= MAX_TOKEN_ATTEMPTS) {
            // Three rounds with a freshly absorbed cookie each time: the token
            // is not the problem any more.
            throw new MtopError(
              code,
              ret ?? "",
              api,
              "o token foi renovado 3 vezes e ainda foi recusado — a sessão ou a assinatura está errada",
            );
          }
          // The `Set-Cookie` with the new `_m_h5_tk` was already absorbed by the
          // http layer; the next attempt re-signs with it.
          log.debug(`${api} ${code}; re-signing with the renewed token (${tokenAttempts})`);
          continue;
        }

        case "traffic": {
          trafficAttempts += 1;
          if (trafficAttempts >= MAX_TRAFFIC_ATTEMPTS) {
            throw new RateLimitError(
              trafficAttempts,
              `O AliExpress limitou as requisições em ${api} após ${trafficAttempts} tentativas. Espere alguns minutos.`,
            );
          }
          const wait = trafficBackoffMs(trafficAttempts);
          log.warn(`${api} ${code}; backing off ${wait}ms`);
          await sleep(wait);
          continue;
        }

        case "session":
          return http.markAuthDead(`O AliExpress recusou a sessão em ${api} (${code}).`);

        case "captcha":
          return http.trip(`${code} on ${api}`);

        default:
          throw new MtopError(code, ret ?? "", api, RET_HINTS[code]);
      }
    }
  }

  return {
    // One serial slot for the whole retry loop: a concurrent call must not
    // rotate `_m_h5_tk` between our signing and our sending.
    request: <T,>(options: MtopOptions) => http.serial(() => run<T>(options)),
    calls: () => calls,
  };
}

/**
 * Fills in the regional keys every MTOP payload carries, from the session's
 * `aep_usuc_f`. An explicit value in `data` always wins.
 */
function withRegionalDefaults(data: Record<string, unknown>, http: Http): Record<string, unknown> {
  const regional = http.regional();
  const defaults: Record<string, unknown> = {
    shipToCountry: regional.region,
    _lang: regional.locale,
  };
  return { ...defaults, ...data };
}

/**
 * `new Date().toString()` → `"GMT-0300"`; MTOP wants `"GMT-3"`. Derived from
 * the machine clock, exactly like the page does.
 */
export function timeZoneParam(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const hours = Math.trunc(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}
