import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { LoginError } from "../src/core/errors.js";
import type { Cookie } from "../src/session/jar.js";
import {
  type BrowserContextLike,
  type PageLike,
  LOGIN_PROBE_SCRIPT,
  launchOptions,
  runLogin,
} from "../src/session/login.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { cookie, fakeClock, scriptedFetch, silentLogger } from "./helpers.js";

// No browser is launched: the Playwright slice we depend on is injected.

function fakePlaywright(opts: {
  loginAfterProbes?: number;
  cookies?: Cookie[];
  onLaunch?: (dir: string, options: Record<string, unknown>) => void;
  failLaunch?: boolean;
}) {
  let probes = 0;
  const visited: string[] = [];
  const page: PageLike = {
    goto: async (url) => {
      visited.push(url);
      return null;
    },
    evaluate: async (script) => {
      if (script === "navigator.userAgent") return "Mozilla/5.0 Chrome/152.0.0.0";
      if (script === LOGIN_PROBE_SCRIPT) return ++probes > (opts.loginAfterProbes ?? 0);
      return null;
    },
    url: () => visited[visited.length - 1] ?? "",
    waitForLoadState: async () => null,
  };
  let closed = false;
  const context: BrowserContextLike = {
    newPage: async () => page,
    cookies: async () =>
      opts.cookies ?? [
        cookie({ name: "acs_usuc_t", value: "session-value-0001" }),
        cookie({
          name: "aep_usuc_f",
          value: "region=BR&b_locale=pt_BR&c_tp=BRL&x_alimid=1234567890",
        }),
        cookie({ name: "other", value: "1", domain: ".example.com" }),
      ],
    close: async () => {
      closed = true;
    },
  };
  return {
    playwright: {
      chromium: {
        launchPersistentContext: async (dir: string, options: Record<string, unknown>) => {
          opts.onLaunch?.(dir, options);
          if (opts.failLaunch) throw new Error("Executable doesn't exist");
          return context;
        },
      },
    },
    visited,
    probeCount: () => probes,
    isClosed: () => closed,
  };
}

function context(): { ctx: Ctx; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ae-login-"));
  const clock = fakeClock();
  const config = loadConfig({
    ALIEXPRESS_CONFIG_DIR: dir,
    ALIEXPRESS_SITE_BASE_URL: "https://www.aliexpress.com",
  });
  const ctx = createContext(config, {
    fetch: scriptedFetch([]),
    now: clock.now,
    session: createMemorySessionStore(null),
    log: silentLogger(),
  });
  return { ctx, dir };
}

describe("launchOptions", () => {
  test("hides the automation signals AliExpress reads", () => {
    const options = launchOptions("chrome");
    expect(options.channel).toBe("chrome");
    expect(options.headless).toBe(false);
    expect(options.args).toContain("--disable-blink-features=AutomationControlled");
    expect(options.ignoreDefaultArgs).toContain("--enable-automation");
  });
});

describe("LOGIN_PROBE_SCRIPT", () => {
  test("asks the site's own MTOP SDK instead of matching a url or selector", () => {
    expect(LOGIN_PROBE_SCRIPT).toContain("window.lib.mtop.request");
    expect(LOGIN_PROBE_SCRIPT).toContain("mtop.aliexpress.trade.buyer.order.list");
    // Never order.count: it answers SUCCESS with zeros to a logged-out caller.
    expect(LOGIN_PROBE_SCRIPT).not.toContain("order.count");
    expect(LOGIN_PROBE_SCRIPT).toContain("SUCCESS");
    // It reads the regional parameters from the page's own cookie.
    expect(LOGIN_PROBE_SCRIPT).toContain("aep_usuc_f");
  });
});

describe("runLogin", () => {
  test("polls until the API answers SUCCESS, then saves the jar", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ loginAfterProbes: 2 });
    const result = await runLogin(
      ctx,
      { timeoutMs: 60_000, report: () => undefined },
      { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
    );
    expect(fake.probeCount()).toBe(3);
    expect(result.memberId).toBe("1234567890");
    expect(result.region).toBe("BR");
    expect(result.currency).toBe("BRL");
    // The foreign-domain cookie is dropped.
    expect(result.cookieCount).toBe(2);
    expect(ctx.session.load()?.userAgent).toContain("Chrome/152");
    // Lands on the orders page again so the server issues the HttpOnly cookies.
    expect(fake.visited.filter((url) => url.includes("/p/order/index.html"))).toHaveLength(2);
    expect(fake.isClosed()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("times out with an actionable message instead of hanging forever", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ loginAfterProbes: Number.POSITIVE_INFINITY });
    await expect(
      runLogin(
        ctx,
        { timeoutMs: 0, report: () => undefined },
        { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
      ),
    ).rejects.toThrow(LoginError);
    expect(ctx.session.load()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a browser that will not open explains how to fix it", async () => {
    const { ctx, dir } = context();
    const fake = fakePlaywright({ failLaunch: true });
    await expect(
      runLogin(ctx, { report: () => undefined }, { importPlaywright: async () => fake.playwright })
    ).rejects.toThrow(/playwright install chromium|Google Chrome/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses the persistent profile directory from the config", async () => {
    const { ctx, dir } = context();
    let launchedIn = "";
    const fake = fakePlaywright({
      loginAfterProbes: 0,
      onLaunch: (target) => {
        launchedIn = target;
      },
    });
    await runLogin(
      ctx,
      { report: () => undefined },
      { importPlaywright: async () => fake.playwright, sleep: async () => undefined },
    );
    expect(launchedIn).toBe(ctx.config.browserProfileDir);
    rmSync(dir, { recursive: true, force: true });
  });
});
