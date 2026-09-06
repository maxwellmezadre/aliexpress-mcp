import { describe, expect, test } from "bun:test";
import { AuthError, CaptchaError, HttpError, MtopError, RateLimitError } from "../src/core/errors.js";
import { type CooldownStore, createHttp } from "../src/core/http.js";
import { classifyRet, isTokenError, retCodeOf } from "../src/mtop/errors.js";
import { createMtopClient, timeZoneParam, trafficBackoffMs } from "../src/mtop/client.js";
import { mtopSign } from "../src/mtop/sign.js";
import { createMemorySessionStore } from "../src/session/store.js";
import {
  fakeClock,
  jsonResponse,
  scriptedFetch,
  sessionData,
  silentLogger,
  textResponse,
} from "./helpers.js";

const ACS = "https://acs.acme.test";

const ok = (data: unknown = {}) =>
  jsonResponse({ api: "mtop.demo", v: "1.0", ret: ["SUCCESS::调用成功"], data });
const fail = (ret: string, setCookie?: string[]) =>
  jsonResponse(
    { api: "mtop.demo", v: "1.0", ret: [ret], data: {} },
    setCookie ? { setCookie } : {},
  );

function setup(script: Parameters<typeof scriptedFetch>[0], cooldown?: CooldownStore) {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const log = silentLogger();
  const session = createMemorySessionStore(sessionData({}, ".acme.test"));
  const http = createHttp(
    {
      session,
      siteBaseUrl: "https://www.acme.test",
      minIntervalMs: 0,
      jitterMs: 0,
      timeoutMs: 30_000,
      log,
      ...(cooldown ? { cooldown } : {}),
    },
    { fetch, sleep: clock.sleep, now: clock.now, random: () => 0 },
  );
  const mtop = createMtopClient(
    { http, acsBaseUrl: ACS, siteBaseUrl: "https://www.acme.test", log },
    { now: clock.now, sleep: clock.sleep },
  );
  return { mtop, http, fetch, clock, log, session };
}

const call = (mtop: ReturnType<typeof setup>["mtop"]) =>
  mtop.request({ api: "mtop.demo", data: { clientPlatform: "pc" } });

const queryOf = (url: string) => new URL(url).searchParams;

describe("ret classification", () => {
  test("splits the stable code from the Chinese half", () => {
    expect(retCodeOf("FAIL_SYS_TOKEN_EMPTY::令牌为空")).toBe("FAIL_SYS_TOKEN_EMPTY");
    expect(retCodeOf(undefined)).toBe("");
  });

  test("treats the three token failures as the same retryable case", () => {
    for (const ret of [
      "FAIL_SYS_TOKEN_EMPTY::令牌为空",
      "FAIL_SYS_TOKEN_EXOIRED::令牌过期",
      "FAIL_SYS_ILLEGAL_ACCESS::非法请求",
    ]) {
      expect(isTokenError(ret)).toBe(true);
      expect(classifyRet(ret)).toBe("token");
    }
  });

  test("maps the remaining families", () => {
    expect(classifyRet("SUCCESS::调用成功")).toBe("success");
    expect(classifyRet("FAIL_SYS_SESSION_EXPIRED::x")).toBe("session");
    expect(classifyRet("NEED_LOGIN::x")).toBe("session");
    expect(classifyRet("FAIL_SYS_TRAFFIC_LIMIT::x")).toBe("traffic");
    expect(classifyRet("FAIL_SYS_USER_VALIDATE::x")).toBe("captcha");
    expect(classifyRet("FAIL_SYS_ACCESS_DENIED::x")).toBe("denied");
    expect(classifyRet("UNKNOWN_FAIL_CODE::系统开小差了")).toBe("unknown");
  });
});

describe("request shape", () => {
  test("signs with the token from the jar and fills in the regional payload", async () => {
    const { mtop, fetch } = setup([ok()]);
    await call(mtop);
    const query = queryOf(fetch.calls[0]?.url as string);
    const data = query.get("data") as string;
    expect(JSON.parse(data)).toEqual({
      shipToCountry: "BR",
      _lang: "pt_BR",
      clientPlatform: "pc",
    });
    expect(query.get("sign")).toBe(mtopSign("tok0123456789", query.get("t") as string, data));
  });

  test("an explicit payload key wins over the regional default", async () => {
    const { mtop, fetch } = setup([ok()]);
    await mtop.request({ api: "mtop.demo", data: { _lang: "en_US" } });
    const data = JSON.parse(queryOf(fetch.calls[0]?.url as string).get("data") as string);
    expect(data._lang).toBe("en_US");
    expect(data.shipToCountry).toBe("BR");
  });

  test("POST sends the payload form-encoded and sets the content type", async () => {
    const { mtop, fetch } = setup([ok()]);
    await mtop.request({ api: "mtop.demo", method: "POST", data: { a: 1 } });
    const init = fetch.calls[0]?.init;
    expect(queryOf(fetch.calls[0]?.url as string).get("data")).toBeNull();
    expect(init?.body).toContain("data=");
    expect(init?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("sends the referer and origin the site sends", async () => {
    const { mtop, fetch } = setup([ok()]);
    await call(mtop);
    expect(fetch.calls[0]?.init.headers.referer).toBe("https://www.acme.test/");
    expect(fetch.calls[0]?.init.headers.origin).toBe("https://www.acme.test");
  });
});

describe("token retry", () => {
  test("absorbs the issued cookie, re-signs with a NEW t and succeeds", async () => {
    const { mtop, fetch } = setup([
      fail("FAIL_SYS_TOKEN_EMPTY::令牌为空", [
        "_m_h5_tk=issued9999_1757999999999; Domain=.acme.test; Path=/; Secure",
      ]),
      (url) => {
        const query = queryOf(url);
        // The retry must sign with the token the server just issued.
        expect(query.get("sign")).toBe(
          mtopSign("issued9999", query.get("t") as string, query.get("data") as string),
        );
        return ok({ module: { shipped: "2" } });
      },
    ]);
    const result = await call(mtop);
    expect(result.ret[0]).toContain("SUCCESS");
    expect(fetch.calls).toHaveLength(2);
    const first = queryOf(fetch.calls[0]?.url as string);
    const second = queryOf(fetch.calls[1]?.url as string);
    // Same payload bytes on both attempts, different signature (new token).
    expect(second.get("data")).toBe(first.get("data"));
    expect(second.get("sign")).not.toBe(first.get("sign"));
  });

  test("a desynchronised token takes the same path instead of aborting", async () => {
    const { mtop, fetch } = setup([
      fail("FAIL_SYS_ILLEGAL_ACCESS::非法请求", [
        "_m_h5_tk=fixed1111_1757999999999; Domain=.acme.test; Path=/; Secure",
      ]),
      ok(),
    ]);
    await call(mtop);
    expect(fetch.calls).toHaveLength(2);
  });

  test("gives up after 3 rounds with an actionable message", async () => {
    const { mtop, fetch } = setup([
      fail("FAIL_SYS_TOKEN_EXOIRED::令牌过期"),
      fail("FAIL_SYS_TOKEN_EXOIRED::令牌过期"),
      fail("FAIL_SYS_TOKEN_EXOIRED::令牌过期"),
    ]);
    try {
      await call(mtop);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MtopError);
      expect((error as MtopError).retCode).toBe("FAIL_SYS_TOKEN_EXOIRED");
      expect((error as Error).message).toMatch(/renovado 3 vezes/);
    }
    // Exactly three attempts: never a loop.
    expect(fetch.calls).toHaveLength(3);
  });
});

describe("rate limit", () => {
  test("backs off exponentially and then reports a RateLimitError", async () => {
    const { mtop, clock, fetch } = setup([
      fail("FAIL_SYS_TRAFFIC_LIMIT::x"),
      fail("FAIL_SYS_TRAFFIC_LIMIT::x"),
      fail("FAIL_SYS_TRAFFIC_LIMIT::x"),
    ]);
    await expect(call(mtop)).rejects.toThrow(RateLimitError);
    expect(fetch.calls).toHaveLength(3);
    expect(clock.slept.filter((ms) => ms >= 2000)).toEqual([2000, 4000]);
  });

  test("caps the traffic backoff", () => {
    expect(trafficBackoffMs(1)).toBe(2000);
    expect(trafficBackoffMs(9)).toBe(60_000);
  });
});

describe("terminal failures", () => {
  test("a dead session is reported once and costs no further request", async () => {
    const { mtop, fetch } = setup([fail("FAIL_SYS_SESSION_EXPIRED::x")]);
    await expect(call(mtop)).rejects.toThrow(AuthError);
    await expect(call(mtop)).rejects.toThrow(/aliexpress login/);
    expect(fetch.calls).toHaveLength(1);
  });

  test("an anti-bot verdict trips the breaker and persists the cooldown", async () => {
    let until: number | null = null;
    const cooldown: CooldownStore = {
      get: () => until,
      set: (value) => {
        until = value;
      },
    };
    const { mtop, fetch, http } = setup([fail("FAIL_SYS_USER_VALIDATE::x")], cooldown);
    await expect(call(mtop)).rejects.toThrow(CaptchaError);
    expect(http.state().tripped).toBe(true);
    expect(until).not.toBeNull();
    await expect(call(mtop)).rejects.toThrow(CaptchaError);
    expect(fetch.calls).toHaveLength(1);
  });

  test("an unknown ret carries the stable code and a pt-BR hint", async () => {
    const { mtop } = setup([fail("UNKNOWN_FAIL_CODE::系统开小差了")]);
    await expect(call(mtop)).rejects.toThrow(/UNKNOWN_FAIL_CODE.*par[âa]metro inv[áa]lido/);
  });

  test("access denied is not retried", async () => {
    const { mtop, fetch } = setup([fail("FAIL_SYS_ACCESS_DENIED::x")]);
    await expect(call(mtop)).rejects.toThrow(MtopError);
    expect(fetch.calls).toHaveLength(1);
  });

  test("a non-JSON body is reported instead of crashing the parser", async () => {
    const { mtop } = setup([textResponse("<html>nope</html>")]);
    await expect(call(mtop)).rejects.toThrow(HttpError);
  });
});

describe("counters and helpers", () => {
  test("counts every attempt, retries included", async () => {
    const { mtop } = setup([
      fail("FAIL_SYS_TOKEN_EMPTY::x", [
        "_m_h5_tk=a1234567_1757999999999; Domain=.acme.test; Path=/; Secure",
      ]),
      ok(),
    ]);
    await call(mtop);
    expect(mtop.calls()).toBe(2);
  });

  test("timeZoneParam renders the offset the way MTOP expects", () => {
    // -180 minutes (Brasília) → GMT-3; the API rejects "GMT-0300".
    const brasilia = { getTimezoneOffset: () => 180 } as Date;
    expect(timeZoneParam(brasilia)).toBe("GMT-3");
    const india = { getTimezoneOffset: () => -330 } as Date;
    expect(timeZoneParam(india)).toBe("GMT+5:30");
    const utc = { getTimezoneOffset: () => 0 } as Date;
    expect(timeZoneParam(utc)).toBe("GMT+0");
  });
});
