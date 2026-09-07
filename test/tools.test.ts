import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { runTool } from "../src/tools/define.js";
import { toolByName } from "../src/tools/registry.js";
import type { AuthStatus } from "../src/tools/auth.js";
import { createMemorySessionStore } from "../src/session/store.js";
import {
  type ScriptedFetch,
  fakeClock,
  jsonResponse,
  scriptedFetch,
  sessionData,
  silentLogger,
} from "./helpers.js";

function context(
  script: Parameters<typeof scriptedFetch>[0],
  session: ReturnType<typeof sessionData> | null = sessionData({}, ".acme.test"),
): { ctx: Ctx; fetch: ScriptedFetch } {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
  const config = loadConfig({
    ALIEXPRESS_CONFIG_DIR: "/nonexistent/aliexpress-mcp-test",
    ALIEXPRESS_ACS_BASE_URL: "https://acs.acme.test",
    ALIEXPRESS_SITE_BASE_URL: "https://www.acme.test",
    ALIEXPRESS_MIN_INTERVAL_MS: "0",
    ALIEXPRESS_JITTER_MS: "0",
  });
  const ctx = createContext(config, {
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    session: createMemorySessionStore(session),
    log: silentLogger(),
  });
  return { ctx, fetch };
}

const call = (name: string, args: Record<string, unknown>, ctx: Ctx) =>
  runTool(toolByName(name) as never, args, ctx);

const mtopOk = (data: unknown) =>
  jsonResponse({ api: "mtop.demo", v: "1.0", ret: ["SUCCESS::调用成功"], data });

describe("auth_status", () => {
  test("without a session reports loggedIn:false and never touches the network", async () => {
    const { ctx, fetch } = context([], null);
    const status = (await call("auth_status", {}, ctx)) as AuthStatus;
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toMatch(/aliexpress login/);
    expect(fetch.calls).toHaveLength(0);
  });

  test("reports the regional settings without spending a request", async () => {
    const { ctx, fetch } = context([]);
    const status = (await call("auth_status", {}, ctx)) as AuthStatus;
    expect(status).toMatchObject({
      loggedIn: true,
      region: "BR",
      locale: "pt_BR",
      currency: "BRL",
      memberId: "1234567890",
      breaker: "ok",
    });
    expect(status.cookieCount).toBe(3);
    expect(fetch.calls).toHaveLength(0);
  });

  test("never returns a cookie value", async () => {
    const { ctx } = context([]);
    const status = await call("auth_status", {}, ctx);
    expect(JSON.stringify(status)).not.toContain("session-secret-value-0001");
  });

  test("verify=true probes order.list, not order.count", async () => {
    // order.count answers SUCCESS with zeros to a logged-out caller (observed
    // 2026-09-07), so verifying with it reports a dead session as healthy.
    const { ctx, fetch } = context([
      mtopOk({
        hierarchy: {
          root: "page",
          structure: { page: ["body"], body: ["order_1", "order_2"] },
        },
        data: {
          page: { tag: "pc_om_list_page", fields: {} },
          body: { tag: "pc_om_list_body", fields: { pageIndex: 1, hasMore: true } },
          order_1: { tag: "pc_om_list_order", fields: { orderId: "1" } },
          order_2: { tag: "pc_om_list_order", fields: { orderId: "2" } },
        },
      }),
    ]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toContain("mtop.aliexpress.trade.buyer.order.list");
    expect(fetch.calls[0]?.url).not.toContain("order.count");
    expect(status.verified).toBe(true);
    expect(status.firstPageOrders).toBe(2);
    expect(status.hasMore).toBe(true);
  });

  test("an expired session is a status, not a thrown error", async () => {
    const { ctx } = context([
      jsonResponse({ api: "x", v: "1.0", ret: ["FAIL_SYS_SESSION_EXPIRED::x"], data: {} }),
    ]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(status.loggedIn).toBe(false);
    expect(status.verified).toBe(false);
    expect(status.error).toMatch(/aliexpress login/);
  });

  test("an anti-bot verdict is reported with the tripped breaker", async () => {
    const { ctx } = context([
      jsonResponse({ api: "x", v: "1.0", ret: ["FAIL_SYS_USER_VALIDATE::x"], data: {} }),
    ]);
    const status = (await call("auth_status", { verify: true }, ctx)) as AuthStatus;
    expect(status.breaker).toBe("tripped");
    expect(status.error).toMatch(/anti-bot/);
  });
});

describe("raw_get", () => {
  test("refuses an api outside the AliExpress MTOP namespace", async () => {
    const { ctx, fetch } = context([]);
    await expect(call("raw_get", { api: "mtop.taobao.something" }, ctx)).rejects.toThrow(
      /fora do escopo/,
    );
    await expect(call("raw_get", { api: "../../etc/passwd" }, ctx)).rejects.toThrow(
      /fora do escopo/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test("refuses every write api even though the signature would work", async () => {
    const { ctx, fetch } = context([]);
    for (const api of [
      "mtop.aliexpress.trade.buyer.order.operation",
      "mtop.aliexpress.buyer.reverse.submit",
      "mtop.ae.order.cancel",
    ]) {
      await expect(call("raw_get", { api }, ctx)).rejects.toThrow(/somente leitura/);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test("passes a read api through and reports the ret", async () => {
    const { ctx, fetch } = context([mtopOk({ module: { shipped: "2" } })]);
    const result = (await call(
      "raw_get",
      { api: "mtop.aliexpress.trade.buyer.order.count" },
      ctx,
    )) as { ret: string[]; truncated: boolean; data: unknown };
    expect(fetch.calls).toHaveLength(1);
    expect(result.ret[0]).toContain("SUCCESS");
    expect(result.truncated).toBe(false);
    expect(result.data).toEqual({ module: { shipped: "2" } });
  });

  test("truncates a big payload instead of flooding the context", async () => {
    const { ctx } = context([mtopOk({ blob: "x".repeat(5000) })]);
    const result = (await call(
      "raw_get",
      { api: "mtop.aliexpress.demo.big", max_bytes: 1024 },
      ctx,
    )) as { truncated: boolean; data: unknown; bytes: number };
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(1024);
    expect(String(result.data)).toHaveLength(1025);
  });
});
