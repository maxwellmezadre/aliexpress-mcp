import { describe, expect, test } from "bun:test";
import { AuthError, CaptchaError, HttpError } from "../src/core/errors.js";
import {
  BACKOFF_BASE_MS,
  COOLDOWN_MS,
  type CooldownStore,
  type Http,
  MAX_ATTEMPTS,
  backoffMs,
  createHttp,
} from "../src/core/http.js";
import { createMemorySessionStore } from "../src/session/store.js";
import {
  fakeClock,
  jsonResponse,
  redirectResponse,
  response,
  scriptedFetch,
  cookie,
  sessionData,
  silentLogger,
  textResponse,
} from "./helpers.js";

const ACS = "https://acs.acme.test/h5/mtop.demo/1.0/";

function setup(
  script: Parameters<typeof scriptedFetch>[0],
  opts: { session?: ReturnType<typeof sessionData> | null; cooldown?: CooldownStore } = {},
) {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const log = silentLogger();
  const session = createMemorySessionStore(
    opts.session === undefined ? sessionData({}, ".acme.test") : opts.session,
  );
  const http = createHttp(
    {
      session,
      siteBaseUrl: "https://www.acme.test",
      minIntervalMs: 400,
      jitterMs: 200,
      timeoutMs: 30_000,
      log,
      ...(opts.cooldown ? { cooldown: opts.cooldown } : {}),
    },
    { fetch, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
  );
  return { http, fetch, clock, log, session };
}

const get = (http: Http) => http.send({ url: ACS, method: "GET", label: "mtop.demo" });

describe("session lifecycle", () => {
  test("fails without a session and never spends a request", async () => {
    const { http, fetch } = setup([], { session: null });
    await expect(get(http)).rejects.toThrow(AuthError);
    expect(fetch.calls).toHaveLength(0);
  });

  test("sends the session cookies and the captured user agent", async () => {
    const { http, fetch } = setup([jsonResponse({ ret: ["SUCCESS::ok"] })]);
    await get(http);
    const headers = fetch.calls[0]?.init.headers as Record<string, string>;
    expect(headers.cookie).toContain("acs_usuc_t=session-secret-value-0001");
    expect(headers["user-agent"]).toContain("Chrome/152");
    expect(fetch.calls[0]?.init.redirect).toBe("manual");
  });

  test("exposes the mtop token and the regional settings from the jar", () => {
    const { http } = setup([]);
    expect(http.token()).toBe("tok0123456789");
    expect(http.regional()).toEqual({
      region: "BR",
      locale: "pt_BR",
      currency: "BRL",
      memberId: "1234567890",
    });
  });

  test("signs with the freshest token when the jar holds two _m_h5_tk cookies", async () => {
    const jar = sessionData({}, ".acme.test");
    jar.cookies.push(
      cookie({ name: "_m_h5_tk", value: "newer5555_1757999999999", domain: "acs.acme.test" }),
    );
    const { http } = setup([], { session: jar });
    expect(http.token()).toBe("newer5555");
  });

  test("a dead session fails the next call without touching the network", async () => {
    const { http, fetch } = setup([redirectResponse("https://login.acme.test/login.htm")]);
    await expect(get(http)).rejects.toThrow(AuthError);
    expect(fetch.calls).toHaveLength(1);
    await expect(get(http)).rejects.toThrow(AuthError);
    expect(fetch.calls).toHaveLength(1);
  });

  test("reloads the jar after the user re-logged in, without an MCP restart", async () => {
    const { http, fetch, session } = setup([
      redirectResponse("https://login.acme.test/login.htm"),
      jsonResponse({ ret: ["SUCCESS::ok"] }),
    ]);
    await expect(get(http)).rejects.toThrow(AuthError);
    session.save(sessionData({ savedAt: 2 }, ".acme.test")); // `aliexpress login` elsewhere
    await get(http);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("pacing", () => {
  test("waits minInterval + jitter between requests", async () => {
    const { http, clock } = setup([
      jsonResponse({ ok: 1 }),
      jsonResponse({ ok: 2 }),
      jsonResponse({ ok: 3 }),
    ]);
    await get(http);
    await get(http);
    await get(http);
    // random() is 0.5 → 400 + 0.5 * 200 = 500 ms; the first request waits nothing.
    expect(clock.slept).toEqual([500, 500]);
  });

  test("serialises concurrent callers: never more than one request in flight", async () => {
    const { http, fetch } = setup([
      jsonResponse({ n: 1 }),
      jsonResponse({ n: 2 }),
      jsonResponse({ n: 3 }),
    ]);
    const label = (n: number) => http.serial(() => http.send({ url: ACS, method: "GET", label: `r${n}` }));
    await Promise.all([label(1), label(2), label(3)]);
    expect(fetch.maxInFlight).toBe(1);
    expect(fetch.calls.map((call) => call.init.headers)).toHaveLength(3);
  });

  test("keeps FIFO order even when one request rejects", async () => {
    const { http } = setup([
      response({ status: 400 }),
      jsonResponse({ n: 2 }),
    ]);
    const order: string[] = [];
    const first = http.serial(() => http.send({ url: ACS, method: "GET", label: "a" })).catch(() => {
      order.push("a");
    });
    const second = http.serial(() => http.send({ url: ACS, method: "GET", label: "b" })).then(() => {
      order.push("b");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("retries", () => {
  test("backs off exponentially on 5xx and gives up after MAX_ATTEMPTS", async () => {
    const { http, clock, fetch } = setup([
      response({ status: 503 }),
      response({ status: 503 }),
      response({ status: 503 }),
      response({ status: 503 }),
    ]);
    await expect(get(http)).rejects.toThrow(HttpError);
    expect(fetch.calls).toHaveLength(MAX_ATTEMPTS);
    // Gaps and backoffs interleave; the backoffs are the powers of two.
    expect(clock.slept.filter((ms) => ms >= BACKOFF_BASE_MS)).toEqual([2000, 4000, 8000]);
  });

  test("caps the backoff", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(10)).toBe(60_000);
  });

  test("recovers when a retry succeeds", async () => {
    const { http, fetch } = setup([response({ status: 500 }), jsonResponse({ ret: ["SUCCESS::ok"] })]);
    const result = await get(http);
    expect(result.status).toBe(200);
    expect(fetch.calls).toHaveLength(2);
  });

  test("retries a network error and then reports it as HttpError(0)", async () => {
    const boom = () => {
      throw new Error("ECONNRESET");
    };
    const { http, fetch } = setup([boom, boom, boom, boom]);
    await expect(get(http)).rejects.toThrow(/Falha de rede/);
    expect(fetch.calls).toHaveLength(MAX_ATTEMPTS);
  });

  test("does not retry a 4xx — it is a verdict, not a hiccup", async () => {
    const { http, fetch } = setup([response({ status: 403 })]);
    await expect(get(http)).rejects.toThrow(HttpError);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("cookie renewal", () => {
  test("absorbs the rotated mtop token and persists it once", async () => {
    const { http, session } = setup([
      jsonResponse(
        { ret: ["SUCCESS::ok"] },
        { setCookie: ["_m_h5_tk=fresh9876_1757999999999; Domain=.acme.test; Path=/"] },
      ),
      jsonResponse({ ret: ["SUCCESS::ok"] }),
    ]);
    await get(http);
    expect(http.token()).toBe("fresh9876");
    expect(session.load()?.cookies.some((c) => c.value.startsWith("fresh9876"))).toBe(true);
  });

  test("does not rewrite the file when the response repeats the same cookie", async () => {
    const { http, session } = setup([
      jsonResponse(
        { ok: 1 },
        { setCookie: ["_m_h5_tk=tok0123456789_1757000000000; Domain=.acme.test; Path=/; Secure"] },
      ),
    ]);
    const before = session.mtimeMs();
    await get(http);
    expect(session.mtimeMs()).toBe(before);
  });
});

describe("anti-bot breaker", () => {
  test("an interstitial body trips the breaker and the next call spends no request", async () => {
    const cooldownValue: { until: number | null } = { until: null };
    const cooldown: CooldownStore = {
      get: () => cooldownValue.until,
      set: (until) => {
        cooldownValue.until = until;
      },
    };
    const { http, fetch, clock } = setup(
      [textResponse("<html>_____tmd_____/punish?x5secdata=abc</html>")],
      { cooldown },
    );
    await expect(get(http)).rejects.toThrow(CaptchaError);
    expect(http.state().tripped).toBe(true);
    expect(cooldownValue.until).toBe(clock.now() + COOLDOWN_MS);
    await expect(get(http)).rejects.toThrow(CaptchaError);
    expect(fetch.calls).toHaveLength(1);
  });

  test("a persisted cooldown from another process blocks before any request", async () => {
    const clockStart = 1_757_000_000_000;
    const cooldown: CooldownStore = { get: () => clockStart + 60_000, set: () => undefined };
    const { http, fetch } = setup([jsonResponse({ ok: 1 })], { cooldown });
    await expect(get(http)).rejects.toThrow(CaptchaError);
    expect(fetch.calls).toHaveLength(0);
    expect(http.cooldownUntil()).toBe(clockStart + 60_000);
  });

  test("an expired cooldown lets requests through again", async () => {
    const cooldown: CooldownStore = { get: () => 1, set: () => undefined };
    const { http } = setup([jsonResponse({ ok: 1 })], { cooldown });
    await get(http);
    expect(http.cooldownUntil()).toBeNull();
  });
});

describe("privacy", () => {
  test("error messages carry the label, never the url or the cookies", async () => {
    const { http } = setup([response({ status: 418 })]);
    try {
      await http.send({ url: `${ACS}?data=%7B%22orderId%22%3A%22123%22%7D`, method: "GET", label: "order.detail" });
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("order.detail");
      expect(message).not.toContain("orderId");
      expect(message).not.toContain("session-secret-value-0001");
    }
  });

  test("logs never contain a header", async () => {
    const { http, log } = setup([jsonResponse({ ok: 1 })]);
    await get(http);
    expect(log.lines.join("\n")).not.toContain("session-secret-value-0001");
  });
});
