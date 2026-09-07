import { mkdirSync, rmSync } from "node:fs";
import type { BrowserChannel } from "../config.js";
import type { Ctx } from "../context.js";
import { LoginError } from "../core/errors.js";
import { type Cookie, inSiteDomain, regionalFromJar } from "./jar.js";

// Interactive login. The user types the password (and whatever else AliExpress
// asks: SMS, Google, captcha) in a real browser window; this code never sees a
// credential and only keeps the resulting cookie jar.
//
// Two things make this work where a naive script fails:
//   1. `storageState`/`context.cookies()` captures the HttpOnly session cookies
//      that `document.cookie` cannot see. Copying document.cookie by hand
//      produces a jar that authenticates nothing.
//   2. "Logged in" is decided by ASKING THE API from inside the page (through
//      the site's own signed MTOP SDK), not by matching a URL or a selector —
//      both change without notice and both are true on pages that are not
//      actually authenticated.

export type LoginResult = {
  cookieCount: number;
  httpOnlyCount: number;
  memberId: string | null;
  region: string;
  locale: string;
  currency: string;
  savedAt: string;
};

export type LoginOptions = {
  timeoutMs?: number;
  channel?: BrowserChannel;
  /** Wipe the persistent profile first (start from a clean browser). */
  fresh?: boolean;
  report?: (message: string) => void;
};

/** Minimal slice of Playwright we depend on, so tests need no browser. */
export type PageLike = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  url(): string;
  waitForLoadState?(state: string, options?: Record<string, unknown>): Promise<unknown>;
};
export type BrowserContextLike = {
  newPage(): Promise<PageLike>;
  cookies(): Promise<Cookie[]>;
  close(): Promise<void>;
};
export type PlaywrightLike = {
  chromium: {
    launchPersistentContext(
      profileDir: string,
      options: Record<string, unknown>,
    ): Promise<BrowserContextLike>;
  };
};

export type LoginDeps = {
  importPlaywright?: () => Promise<PlaywrightLike>;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2_000;
const REPORT_EVERY_MS = 30_000;

export const PLAYWRIGHT_HINT =
  "O `login` precisa do playwright-core resolvível — no binário compilado ele " +
  "fica de fora de propósito (150 MB que só este comando usa). Rode " +
  "`bun install -g playwright-core`, ou faça o login de dentro do repositório " +
  "(`bun run login`), ou use `aliexpress login --from-browser chrome`, que não " +
  "abre navegador nenhum. Se o problema for o navegador e não o pacote: " +
  "instale o Google Chrome, ou `bunx playwright install chromium` com " +
  "ALIEXPRESS_BROWSER_CHANNEL=chromium.";

/**
 * Runs inside the page. Uses the site's own MTOP SDK, so the call is signed and
 * authenticated exactly like the site's, and a SUCCESS proves the session
 * really works — not just that some page rendered.
 *
 * It probes `order.list`, NOT `order.count`: count answers SUCCESS with zeros
 * to an unauthenticated caller (observed 2026-09-07), so it would report a
 * logged-out browser as logged in.
 */
export const LOGIN_PROBE_SCRIPT = `(async () => {
  try {
    if (!window.lib || !window.lib.mtop) return false;
    const match = /(?:^|;\\s*)aep_usuc_f=([^;]*)/.exec(document.cookie);
    const params = new URLSearchParams(decodeURIComponent(match ? match[1] : ""));
    const response = await window.lib.mtop.request({
      api: "mtop.aliexpress.trade.buyer.order.list",
      v: "1.0",
      type: "GET",
      needLogin: true,
      dataType: "json",
      data: {
        statusTab: "all",
        renderType: "init",
        clientPlatform: "pc",
        shipToCountry: params.get("region") || "US",
        _lang: params.get("b_locale") || "en_US",
      },
    });
    return String((response && response.ret && response.ret[0]) || "").startsWith("SUCCESS");
  } catch (error) {
    return false;
  }
})()`;

export function launchOptions(channel: BrowserChannel): Record<string, unknown> {
  return {
    channel,
    headless: false,
    locale: "pt-BR",
    viewport: null,
    // Headless or not, Chrome reports navigator.webdriver=true unless this is
    // set, and anti-fraud SDKs read it.
    args: ["--disable-blink-features=AutomationControlled"],
    // Drops the "controlled by automated software" banner from the window.
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

async function loadPlaywright(deps: LoginDeps): Promise<PlaywrightLike> {
  if (deps.importPlaywright) return deps.importPlaywright();
  try {
    // Dynamic: playwright-core is an optional dependency and the MCP path must
    // never load it.
    return (await import("playwright-core")) as unknown as PlaywrightLike;
  } catch (error) {
    throw new LoginError(
      `Não consegui carregar o playwright-core. ${PLAYWRIGHT_HINT}\nDetalhe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function runLogin(
  ctx: Ctx,
  options: LoginOptions = {},
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const { config } = ctx;
  const report = options.report ?? ((message: string) => ctx.log.info(message));
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const channel = options.channel ?? config.browserChannel;

  if (options.fresh) rmSync(config.browserProfileDir, { recursive: true, force: true });
  mkdirSync(config.browserProfileDir, { recursive: true, mode: 0o700 });

  const sleep = deps.sleep ?? realSleep;
  const playwright = await loadPlaywright(deps);
  let context: BrowserContextLike;
  try {
    context = await playwright.chromium.launchPersistentContext(
      config.browserProfileDir,
      launchOptions(channel),
    );
  } catch (error) {
    throw new LoginError(
      `Não consegui abrir o navegador (canal: ${channel}). ${PLAYWRIGHT_HINT}\nDetalhe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const page = await context.newPage();
    const ordersUrl = `${config.siteBaseUrl}/p/order/index.html`;
    await page.goto(ordersUrl);
    report(
      "Faça login na janela do navegador (senha, SMS, Google, captcha — o que o AliExpress pedir). Aguardando…",
    );

    const startedAt = ctx.now();
    const deadline = startedAt + timeoutMs;
    let lastReport = startedAt;
    for (;;) {
      if (await isLoggedIn(page)) break;
      if (ctx.now() >= deadline) {
        throw new LoginError(
          `Login não concluído em ${Math.round(timeoutMs / 60_000)} minutos. Rode \`aliexpress login\` de novo.`,
        );
      }
      if (ctx.now() - lastReport >= REPORT_EVERY_MS) {
        report(`Ainda aguardando o login… (${Math.round((ctx.now() - startedAt) / 1000)} s)`);
        lastReport = ctx.now();
      }
      await sleep(POLL_MS);
    }

    // Land on the orders page once more: it is what makes the server issue the
    // HttpOnly cookies the API calls need.
    await page.goto(ordersUrl);
    await page.waitForLoadState?.("networkidle", { timeout: 30_000 }).catch(() => undefined);

    const host = new URL(config.siteBaseUrl).hostname;
    const registrable = host.split(".").slice(-2).join(".");
    const cookies = (await context.cookies()).filter((cookie) =>
      inSiteDomain(cookie.domain, registrable),
    );
    const userAgent = String(await page.evaluate("navigator.userAgent"));
    const regional = {
      ...regionalFromJar(cookies),
      ...(config.region ? { region: config.region } : {}),
      ...(config.locale ? { locale: config.locale } : {}),
      ...(config.currency ? { currency: config.currency } : {}),
    };
    const savedAt = ctx.now();
    ctx.session.save({ version: 1, cookies, userAgent, regional, savedAt });
    ctx.http.resetSession();

    return {
      cookieCount: cookies.length,
      httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
      memberId: regional.memberId,
      region: regional.region,
      locale: regional.locale,
      currency: regional.currency,
      savedAt: new Date(savedAt).toISOString(),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function isLoggedIn(page: PageLike): Promise<boolean> {
  try {
    return (await page.evaluate(LOGIN_PROBE_SCRIPT)) === true;
  } catch {
    // The page may still be navigating; try again on the next tick.
    return false;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
