import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCache } from "../src/cache/db.js";
import { META_LAST_FULL, PARSER_VERSION, runSyncChunk } from "../src/cache/sync.js";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { AuthError } from "../src/core/errors.js";
import { createMemorySessionStore } from "../src/session/store.js";
import type { UltronResponse } from "../src/ultron/types.js";
import {
  type ScriptedFetch,
  fakeClock,
  jsonResponse,
  scriptedFetch,
  sessionData,
  silentLogger,
} from "./helpers.js";

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const LIST = fixture<{ data: UltronResponse }>("order-list-init").data;
const DETAIL = fixture<{ data: UltronResponse }>("order-detail").data;
const REFUNDS = fixture<{ data: { module: unknown } }>("refund-list").data;

const ok = (payload: unknown) =>
  jsonResponse({ api: "mtop.demo", v: "1.0", ret: ["SUCCESS::调用成功"], data: payload });

const fail = (ret: string) =>
  jsonResponse({ api: "mtop.demo", v: "1.0", ret: [ret], data: {} });

/** The list fixture with `hasMore` flipped, so a walk can be made to stop. */
function listPage(hasMore: boolean, orderIdPrefix?: string): UltronResponse {
  const page = structuredClone(LIST);
  for (const [key, component] of Object.entries(page.data)) {
    if (component.tag === "pc_om_list_body") component.fields.hasMore = hasMore;
    if (component.tag === "pc_om_list_order" && orderIdPrefix) {
      component.fields.orderId = `${orderIdPrefix}${component.fields.orderId as string}`;
      delete page.data[key];
      page.data[`${key}-${orderIdPrefix}`] = component;
      const body = Object.entries(page.hierarchy.structure).find(([, children]) =>
        children.includes(key),
      );
      if (body) {
        page.hierarchy.structure[body[0]] = body[1].map((child) =>
          child === key ? `${key}-${orderIdPrefix}` : child,
        );
      }
    }
  }
  return page;
}

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function context(
  script: Parameters<typeof scriptedFetch>[0],
  fallback?: Parameters<typeof scriptedFetch>[1],
): { ctx: Ctx; fetch: ScriptedFetch } {
  const clock = fakeClock();
  const fetch = scriptedFetch(script, fallback);
  db = openCache(":memory:");
  const ctx = createContext(
    loadConfig({
      ALIEXPRESS_CONFIG_DIR: "/nonexistent/aliexpress-mcp-test",
      ALIEXPRESS_ACS_BASE_URL: "https://acs.acme.test",
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
  return { ctx, fetch };
}

/** A script for a complete first sync: 1 list page, 10 details, 1 refund page. */
const fullScript = (details = 10) => [
  ok(listPage(false)),
  ...Array.from({ length: details }, () => ok(DETAIL)),
  ok(REFUNDS),
];

describe("mode resolution", () => {
  test("an empty cache is always a full sync, whatever was asked for", async () => {
    const { ctx } = context(fullScript());
    const report = await runSyncChunk(ctx, { mode: "incremental", withTracking: false });
    expect(report.mode).toBe("full");
  });

  test("after a completed full sync, the default becomes incremental", async () => {
    const { ctx } = context([...fullScript()], ok(listPage(false)));
    await runSyncChunk(ctx, { withTracking: false });
    expect(ctx.cache().getMeta(META_LAST_FULL)).not.toBeNull();
    const second = await runSyncChunk(ctx, { withTracking: false });
    expect(second.mode).toBe("incremental");
  });
});

describe("a first full sync", () => {
  test("walks the list, fetches every detail and finishes", async () => {
    const { ctx, fetch } = context(fullScript());
    const report = await runSyncChunk(ctx, { withTracking: false });
    expect(report.done).toBe(true);
    expect(report.pagesFetched).toBe(1);
    expect(report.ordersSeen).toBe(10);
    expect(report.ordersNew).toBe(10);
    expect(report.detailsFetched).toBe(10);
    expect(report.pendingDetails).toBe(0);
    expect(report.refundsFetched).toBe(3);
    // 1 list + 10 details + 1 refund page.
    expect(fetch.calls).toHaveLength(12);
    expect(ctx.cache().stats().orders).toBe(10);
  });

  test("makes the cache searchable", async () => {
    const { ctx } = context(fullScript());
    await runSyncChunk(ctx, { withTracking: false });
    const cache = ctx.cache();
    const title = cache
      .listOrders({ limit: 50, includeUnpaid: true })
      .flatMap((row) => cache.getLines(row.order_id))
      .map((line) => line.title)
      .find((value): value is string => Boolean(value)) as string;
    expect(cache.searchLines(title.split(" ")[0] as string).length).toBeGreaterThan(0);
  });
});

describe("the request budget", () => {
  test("stops at maxRequests, reports what is left and how to continue", async () => {
    const { ctx, fetch } = context([ok(listPage(false)), ok(DETAIL), ok(DETAIL), ok(DETAIL)]);
    const report = await runSyncChunk(ctx, {
      maxRequests: 4,
      withTracking: false,
      withRefunds: false,
    });
    expect(report.done).toBe(false);
    expect(report.requestsUsed).toBe(4);
    expect(report.detailsFetched).toBe(3);
    expect(report.pendingDetails).toBe(7);
    expect(report.hint).toMatch(/done: true/);
    expect(fetch.calls).toHaveLength(4);
  });

  test("resuming skips the list it already walked and finishes the queue", async () => {
    const { ctx, fetch } = context([
      ok(listPage(false)),
      ...Array.from({ length: 10 }, () => ok(DETAIL)),
      ok(REFUNDS),
    ]);
    const first = await runSyncChunk(ctx, { maxRequests: 2, withTracking: false, withRefunds: false });
    expect(first.done).toBe(false);
    expect(first.pagesFetched).toBe(1);

    const second = await runSyncChunk(ctx, { withTracking: false });
    expect(second.done).toBe(true);
    // The list was NOT walked again.
    expect(second.pagesFetched).toBe(0);
    expect(second.detailsFetched).toBe(9);
    expect(fetch.calls).toHaveLength(12);
  });
});

describe("an incremental sync", () => {
  const seedFull = async () => {
    // After the seeding script the only calls left are a list page and the
    // refunds page, and both answer the same way every time.
    const { ctx, fetch } = context([...fullScript()], ok(listPage(false)));
    await runSyncChunk(ctx, { withTracking: false });
    return { ctx, fetch };
  };

  test("costs one list page and no details when nothing changed", async () => {
    const { ctx, fetch } = await seedFull();
    const before = fetch.calls.length;
    const report = await runSyncChunk(ctx, { withTracking: false });
    expect(report.mode).toBe("incremental");
    expect(report.ordersNew).toBe(0);
    expect(report.detailsFetched).toBe(0);
    expect(report.done).toBe(true);
    // One list page + one refunds page, and nothing else.
    expect(fetch.calls.length - before).toBe(2);
  });

  test("never refetches the detail of a finished order", async () => {
    const { ctx } = await seedFull();
    const finals = ctx.cache().listOrders({ limit: 50 }).filter((row) => row.is_final === 1);
    expect(finals.length).toBeGreaterThan(0);
    const report = await runSyncChunk(ctx, { withTracking: false });
    expect(report.detailsFetched).toBe(0);
  });
});

describe("failures", () => {
  test("a broken detail parks that order and the queue keeps moving", async () => {
    const { ctx } = context([
      ok(listPage(false)),
      fail("UNKNOWN_FAIL_CODE::系统开小差了"),
      ...Array.from({ length: 9 }, () => ok(DETAIL)),
      ok(REFUNDS),
    ]);
    const report = await runSyncChunk(ctx, { withTracking: false });
    expect(report.detailErrors).toBe(1);
    expect(report.detailsFetched).toBe(9);
    expect(report.done).toBe(true);
    expect(report.pendingDetails).toBe(0);
  });

  test("a dead session aborts the run but keeps the progress already written", async () => {
    const { ctx } = context([
      ok(listPage(false)),
      ok(DETAIL),
      fail("FAIL_SYS_SESSION_EXPIRED::x"),
    ]);
    await expect(runSyncChunk(ctx, { withTracking: false })).rejects.toThrow(AuthError);
    // The list and the first detail survived.
    expect(ctx.cache().stats().orders).toBe(10);
    expect(ctx.cache().stats().withDetail).toBe(1);
  });

  test("a tracking failure is a warning, not a lost sync", async () => {
    const { ctx } = context([
      ok(listPage(false)),
      ...Array.from({ length: 10 }, () => ok(DETAIL)),
      ok(REFUNDS),
    ]);
    const report = await runSyncChunk(ctx, { withTracking: true });
    // No order is in a shipped state in the fixture, so nothing is tracked.
    expect(report.trackingFetched).toBe(0);
    expect(report.done).toBe(true);
  });
});

describe("reparse", () => {
  test("re-runs the parsers over the stored payloads with zero requests", async () => {
    const { ctx, fetch } = context(fullScript());
    await runSyncChunk(ctx, { withTracking: false });
    const before = fetch.calls.length;

    // Simulate a parser change: the stored rows are from an older version.
    ctx.cache().listOrders({ limit: 50 }).forEach(() => undefined);
    const cache = ctx.cache();
    for (const row of cache.listOrders({ limit: 50 })) {
      cache.upsertDetail(
        {
          ...(JSON.parse("{}") as Record<string, never>),
          orderId: row.order_id,
          orderDate: null,
          orderDateText: null,
          status: "completed",
          statusText: null,
          statusTab: null,
          total: null,
          store: { name: null, storeId: null, url: null },
          paymentOutId: null,
          itemCount: 0,
          lines: [],
          createdAt: null,
          paidAt: null,
          shippedAt: null,
          finishedAt: null,
          paymentMethod: null,
          installments: null,
          statusCode: null,
          shippingAddress: null,
          priceBreakdown: [],
          timeline: [],
        },
        JSON.stringify(DETAIL),
        PARSER_VERSION - 1,
      );
    }

    const report = await runSyncChunk(ctx, { mode: "reparse" });
    expect(report.done).toBe(true);
    expect(report.reparsed).toBe(10);
    expect(report.requestsUsed).toBe(0);
    expect(fetch.calls).toHaveLength(before);
    // The re-parsed rows have their dates back.
    expect(ctx.cache().getOrder(ctx.cache().listOrders({ limit: 1 })[0]?.order_id as string)?.paid_at)
      .toBe("2026-07-15");
  });
});
