import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { ParseError } from "../src/core/errors.js";
import {
  fetchOrderCount,
  fetchOrderDetail,
  fetchOrderListInit,
  fetchOrderListPage,
  walkOrderPages,
} from "../src/aliexpress/orders.js";
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

const raw = (name: string): { data: unknown } =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as {
    data: unknown;
  };

const LIST = raw("order-list-init");
const DETAIL = raw("order-detail");
const COUNT = raw("order-count");

const ok = (payload: unknown) =>
  jsonResponse({ api: "mtop.demo", v: "1.0", ret: ["SUCCESS::调用成功"], data: payload });

function context(script: Parameters<typeof scriptedFetch>[0]): {
  ctx: Ctx;
  fetch: ScriptedFetch;
} {
  const clock = fakeClock();
  const fetch = scriptedFetch(script);
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
    },
  );
  return { ctx, fetch };
}

const payloadOf = (url: string): Record<string, unknown> =>
  JSON.parse(new URL(url).searchParams.get("data") as string) as Record<string, unknown>;

const bodyPayloadOf = (body: string): Record<string, unknown> =>
  JSON.parse(decodeURIComponent(body.slice("data=".length))) as Record<string, unknown>;

describe("fetchOrderCount", () => {
  test("unwraps the module, which answers with strings", async () => {
    const { ctx, fetch } = context([ok(COUNT.data)]);
    const counts = await fetchOrderCount(ctx);
    expect(fetch.calls[0]?.url).toContain("mtop.aliexpress.trade.buyer.order.count");
    expect(typeof counts.shipped).toBe("string");
  });
});

describe("fetchOrderListInit", () => {
  test("sends the init payload the page sends, timezone included", async () => {
    const { ctx, fetch } = context([ok(LIST.data)]);
    await fetchOrderListInit(ctx);
    const payload = payloadOf(fetch.calls[0]?.url as string);
    expect(payload).toMatchObject({
      statusTab: "all",
      renderType: "init",
      clientPlatform: "pc",
      shipToCountry: "BR",
      _lang: "pt_BR",
    });
    expect(String(payload.timeZone)).toMatch(/^GMT[+-]\d/);
    expect(fetch.calls[0]?.init.method).toBe("GET");
  });

  test("passes the filters through", async () => {
    const { ctx, fetch } = context([ok(LIST.data)]);
    await fetchOrderListInit(ctx, {
      statusTab: "completed",
      timeOption: "1y",
      searchInput: "cabo",
      searchOption: "order",
    });
    expect(payloadOf(fetch.calls[0]?.url as string)).toMatchObject({
      statusTab: "completed",
      timeOption: "1y",
      searchInput: "cabo",
      searchOption: "order",
    });
  });
});

describe("fetchOrderListPage", () => {
  test("POSTs the previous state with pageIndex bumped and linkage attached", async () => {
    const { ctx, fetch } = context([ok(LIST.data)]);
    await fetchOrderListPage(ctx, LIST.data as UltronResponse, 2);
    const call = fetch.calls[0];
    expect(call?.init.method).toBe("POST");
    const params = JSON.parse(
      bodyPayloadOf(call?.init.body as string).params as string,
    ) as Record<string, string>;
    expect(Object.keys(params).sort()).toEqual([
      "data",
      "endpoint",
      "hierarchy",
      "linkage",
      "operator",
    ]);
    const body = JSON.parse(params.data as string) as Record<
      string,
      { tag: string; fields: Record<string, unknown> }
    >;
    const bodyComponent = Object.values(body).find(
      (component) => component.tag === "pc_om_list_body",
    );
    expect(bodyComponent?.fields.pageIndex).toBe(2);
    expect(params.operator).toContain("pc_om_list_body");
  });

  test("refuses to page a response with no linkage instead of returning an empty page", async () => {
    const { ctx, fetch } = context([]);
    const withoutLinkage = { ...(LIST.data as UltronResponse), linkage: undefined };
    await expect(fetchOrderListPage(ctx, withoutLinkage, 2)).rejects.toThrow(ParseError);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("fetchOrderDetail", () => {
  test("uses tradeOrderId and asks for the tracking channel", async () => {
    const { ctx, fetch } = context([ok(DETAIL.data)]);
    await fetchOrderDetail(ctx, "8212313961591322");
    const payload = payloadOf(fetch.calls[0]?.url as string);
    expect(payload.tradeOrderId).toBe("8212313961591322");
    expect(payload.orderId).toBeUndefined();
    expect(payload.channel).toBe("tracking");
  });

  test("detects the empty page skeleton you get from the wrong parameter", async () => {
    const skeleton: UltronResponse = {
      hierarchy: { root: "detail_root_container_1", structure: { detail_root_container_1: [] } },
      data: { detail_root_container_1: { tag: "detail_root_container", fields: {} } },
    };
    const { ctx } = context([ok(skeleton)]);
    await expect(fetchOrderDetail(ctx, "123")).rejects.toThrow(/tradeOrderId/);
  });
});

describe("walkOrderPages", () => {
  test("walks until hasMore is false and keeps the display order", async () => {
    const page2 = structuredClone(LIST.data) as UltronResponse;
    for (const component of Object.values(page2.data)) {
      if (component.tag === "pc_om_list_body") component.fields.hasMore = false;
    }
    const { ctx, fetch } = context([ok(LIST.data), ok(page2)]);
    const pages = [];
    for await (const page of walkOrderPages(ctx)) pages.push(page);
    expect(pages.map((page) => page.index)).toEqual([1, 2]);
    expect(pages[0]?.orders).toHaveLength(10);
    expect(pages[1]?.hasMore).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  test("stops at maxPages even when the server keeps saying hasMore", async () => {
    const { ctx, fetch } = context([ok(LIST.data), ok(LIST.data), ok(LIST.data)]);
    const pages = [];
    for await (const page of walkOrderPages(ctx, {}, 2)) pages.push(page);
    expect(pages).toHaveLength(2);
    expect(fetch.calls).toHaveLength(2);
  });

  test("stops when a page comes back with no orders at all", async () => {
    const empty = structuredClone(LIST.data) as UltronResponse;
    for (const [key, component] of Object.entries(empty.data)) {
      if (component.tag === "pc_om_list_order") delete empty.data[key];
    }
    const { ctx } = context([ok(LIST.data), ok(empty)]);
    const pages = [];
    for await (const page of walkOrderPages(ctx)) pages.push(page);
    expect(pages).toHaveLength(1);
  });
});
