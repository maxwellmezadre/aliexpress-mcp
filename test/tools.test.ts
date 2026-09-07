import { describe, expect, test } from "bun:test";
import { openCache } from "../src/cache/db.js";
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
  // In-memory cache: no tool may create a database in the user's config dir.
  const memoryDb = openCache(":memory:");
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
    db: memoryDb,
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

// ---------------------------------------------------------------------------
// The cache-backed tools. They run against a database seeded from the real
// (anonymised) fixtures, so the assertions are about real data shapes.

import { runSyncChunk } from "../src/cache/sync.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";

const fixtureOf = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const LIST_PAGE = fixtureOf<{ data: Record<string, unknown> }>("order-list-init").data;
const DETAIL_PAGE = fixtureOf<{ data: Record<string, unknown> }>("order-detail").data;
const LOGISTICS_MODULE = fixtureOf<{ data: unknown }>("logistics-querydetail").data;
const REFUND_MODULE = fixtureOf<{ data: unknown }>("refund-list").data;

function lastPage(): Record<string, unknown> {
  const page = structuredClone(LIST_PAGE) as {
    data: Record<string, { tag: string; fields: Record<string, unknown> }>;
  };
  for (const component of Object.values(page.data)) {
    if (component.tag === "pc_om_list_body") component.fields.hasMore = false;
  }
  return page as unknown as Record<string, unknown>;
}

async function seeded(extra: Parameters<typeof scriptedFetch>[0] = []) {
  const clock = fakeClock();
  const db = openCache(":memory:");
  const exportDir = mkdtempSync(join(tmpdir(), "ae-export-"));
  const fetch = scriptedFetch(
    [
      mtopOk(lastPage()),
      ...Array.from({ length: 10 }, () => mtopOk(DETAIL_PAGE)),
      mtopOk(REFUND_MODULE),
      ...extra,
    ],
    mtopOk(lastPage()),
  );
  const ctx = createContext(
    loadConfig({
      ALIEXPRESS_CONFIG_DIR: "/nonexistent/aliexpress-mcp-test",
      ALIEXPRESS_ACS_BASE_URL: "https://acs.acme.test",
      ALIEXPRESS_EXPORT_DIR: exportDir,
      ALIEXPRESS_MIN_INTERVAL_MS: "0",
      ALIEXPRESS_JITTER_MS: "0",
    }),
    {
      fetch,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
      session: createMemorySessionStore(sessionData({}, ".acme.test")),
      log: silentLogger(),
      db,
    },
  );
  await runSyncChunk(ctx, { withTracking: false });
  return { ctx, fetch, exportDir, cleanup: () => rmSync(exportDir, { recursive: true, force: true }) };
}

describe("list_orders", () => {
  test("answers from the cache with no network at all", async () => {
    const { ctx, fetch, cleanup } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("list_orders", { limit: 5 }, ctx)) as {
      total: number;
      returned: number;
      hasMore: boolean;
      orders: Array<{ orderId: string; total: unknown; items: unknown[] }>;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.returned).toBe(5);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.orders[0]?.total).toHaveProperty("amount");
    cleanup();
  });

  test("compact drops the fields a model rarely needs", async () => {
    const { ctx, cleanup } = await seeded();
    const full = (await call("list_orders", { limit: 1 }, ctx)) as { orders: Array<Record<string, unknown>> };
    const compact = (await call("list_orders", { limit: 1, compact: true }, ctx)) as {
      orders: Array<Record<string, unknown>>;
    };
    expect(full.orders[0]).toHaveProperty("paymentOutId");
    expect(compact.orders[0]).not.toHaveProperty("paymentOutId");
    cleanup();
  });

  test("tells the model to sync when the cache is empty", async () => {
    const { ctx } = context([]);
    const result = (await call("list_orders", {}, ctx)) as { note?: string; total: number };
    expect(result.total).toBe(0);
    expect(result.note).toMatch(/sync/);
  });
});

describe("get_order", () => {
  test("reads from the cache without spending a request", async () => {
    const { ctx, fetch, cleanup } = await seeded();
    const orderId = (
      (await call("list_orders", { limit: 1 }, ctx)) as { orders: Array<{ orderId: string }> }
    ).orders[0]?.orderId as string;
    const before = fetch.calls.length;
    const detail = (await call("get_order", { order_id: orderId }, ctx)) as {
      source: string;
      installments: null;
      priceBreakdown: unknown[];
      shippingAddress?: unknown;
    };
    expect(fetch.calls.length).toBe(before);
    expect(detail.source).toBe("cache");
    expect(detail.installments).toBeNull();
    expect(detail.priceBreakdown.length).toBeGreaterThan(0);
    // The address is private: absent unless asked for.
    expect(detail.shippingAddress).toBeUndefined();
    cleanup();
  });

  test("returns the address only when asked", async () => {
    const { ctx, cleanup } = await seeded();
    const orderId = (
      (await call("list_orders", { limit: 1 }, ctx)) as { orders: Array<{ orderId: string }> }
    ).orders[0]?.orderId as string;
    const detail = (await call("get_order", { order_id: orderId, include_address: true }, ctx)) as {
      shippingAddress: { postCode: string } | null;
    };
    expect(detail.shippingAddress?.postCode).toBe("00000-000");
    cleanup();
  });

  test("fetches once for an order the cache never saw, then serves it from cache", async () => {
    const { ctx, fetch, cleanup } = await seeded([mtopOk(DETAIL_PAGE)]);
    const before = fetch.calls.length;
    const first = (await call("get_order", { order_id: "9999999999999999" }, ctx)) as {
      source: string;
    };
    expect(first.source).toBe("live");
    expect(fetch.calls.length).toBe(before + 1);
    const second = (await call("get_order", { order_id: "9999999999999999" }, ctx)) as {
      source: string;
    };
    expect(second.source).toBe("cache");
    expect(fetch.calls.length).toBe(before + 1);
    cleanup();
  });
});

describe("search_products", () => {
  test("finds a product without accents and without the network", async () => {
    const { ctx, fetch, cleanup } = await seeded();
    const before = fetch.calls.length;
    const title = (
      (await call("list_orders", { limit: 10 }, ctx)) as {
        orders: Array<{ items: Array<{ title: string | null }> }>;
      }
    ).orders.flatMap((order) => order.items).find((item) => item.title)?.title as string;
    const result = (await call("search_products", { query: title.split(" ")[0] as string }, ctx)) as {
      total: number;
    };
    expect(result.total).toBeGreaterThan(0);
    expect(fetch.calls.length).toBe(before);
    cleanup();
  });
});

describe("spending_summary", () => {
  test("groups by month and the rows add up to the grand total", async () => {
    const { ctx, cleanup } = await seeded();
    const result = (await call("spending_summary", { group_by: "month" }, ctx)) as {
      rows: Array<{ key: string; total: number }>;
      grandTotal: number;
      note: string;
    };
    const sum = result.rows.reduce((total, row) => total + row.total, 0);
    expect(Math.abs(sum - result.grandTotal)).toBeLessThan(0.01);
    expect(result.note).toBeTruthy();
    cleanup();
  });

  test("breakdown says where the money went", async () => {
    const { ctx, cleanup } = await seeded();
    const result = (await call("spending_summary", { group_by: "breakdown" }, ctx)) as {
      rows: Array<{ key: string; total: number }>;
    };
    expect(result.rows.map((row) => row.key)).toContain("tax");
    cleanup();
  });
});

describe("export", () => {
  test("writes inside the export dir and reports the path", async () => {
    const { ctx, exportDir, cleanup } = await seeded();
    const result = (await call("export", { format: "csv", scope: "orders" }, ctx)) as {
      path: string;
      rows: number;
    };
    expect(result.path.startsWith(exportDir)).toBe(true);
    expect(result.rows).toBe(10);
    const csv = read(result.path, "utf8");
    expect(csv.split("\n")[0]).toContain("orderId");
    cleanup();
  });

  test("a filename cannot escape the export dir", async () => {
    const { ctx, exportDir, cleanup } = await seeded();
    for (const filename of ["../escape.csv", "/etc/passwd", "..%2Fx", "sub/dir.csv"]) {
      const result = (await call(
        "export",
        { format: "csv", scope: "orders", filename },
        ctx,
      )) as { path: string };
      expect(result.path.startsWith(`${exportDir}/`)).toBe(true);
      expect(result.path).not.toContain("..");
    }
    cleanup();
  });
});

describe("track_order", () => {
  test("always goes to the network and caches what it got", async () => {
    const { ctx, fetch, cleanup } = await seeded([mtopOk(LOGISTICS_MODULE)]);
    const before = fetch.calls.length;
    const orderId = (
      (await call("list_orders", { limit: 1 }, ctx)) as { orders: Array<{ orderId: string }> }
    ).orders[0]?.orderId as string;
    const result = (await call("track_order", { order_id: orderId }, ctx)) as {
      packageCount: number;
      packages: Array<{ trackingNumber: string; events: unknown[] }>;
    };
    expect(fetch.calls.length).toBe(before + 1);
    expect(result.packageCount).toBe(1);
    expect(result.packages[0]?.events).toHaveLength(26);
    expect(ctx.cache().getPackages(orderId)).toHaveLength(1);
    cleanup();
  });
});

describe("list_refunds", () => {
  test("reads the cache and warns that unitPrice is not the refunded amount", async () => {
    const { ctx, fetch, cleanup } = await seeded();
    const before = fetch.calls.length;
    const result = (await call("list_refunds", {}, ctx)) as {
      total: number;
      note: string;
      refunds: Array<{ unitPrice: { amount: number } }>;
    };
    expect(fetch.calls.length).toBe(before);
    expect(result.total).toBe(3);
    expect(result.refunds[0]?.unitPrice.amount).toBe(61.25);
    expect(result.note).toMatch(/não o valor reembolsado/);
    cleanup();
  });
});
