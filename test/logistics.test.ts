import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLogistics } from "../src/ae/logistics.js";
import { REVERSE_STATUS, fetchAllRefunds, fetchRefundPage } from "../src/ae/refunds.js";
import { loadConfig } from "../src/config.js";
import { type Ctx, createContext } from "../src/context.js";
import { createMemorySessionStore } from "../src/session/store.js";
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

const LOGISTICS = fixture<{ data: unknown }>("logistics-querydetail").data;
const REFUNDS = fixture<{ data: { module: { items: unknown[]; total: number; pages: number } } }>(
  "refund-list",
).data;

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

const queryPayload = (url: string): Record<string, unknown> =>
  JSON.parse(new URL(url).searchParams.get("data") as string) as Record<string, unknown>;

const bodyPayload = (body: string): Record<string, unknown> =>
  JSON.parse(decodeURIComponent(body.slice("data=".length))) as Record<string, unknown>;

describe("fetchLogistics", () => {
  test("sends the payload the tracking page sends", async () => {
    const { ctx, fetch } = context([ok(LOGISTICS)]);
    await fetchLogistics(ctx, "8214565334582017");
    const payload = queryPayload(fetch.calls[0]?.url as string);
    expect(fetch.calls[0]?.url).toContain("mtop.ae.ld.querydetail");
    expect(payload).toMatchObject({
      tradeOrderId: "8214565334582017",
      tradeOrderLineId: "",
      terminalType: "PC",
      needPageDisplayInfo: true,
      _currency: "BRL",
      shipToCountry: "BR",
    });
  });

  test("can narrow to a single order line", async () => {
    const { ctx, fetch } = context([ok(LOGISTICS)]);
    await fetchLogistics(ctx, "1", "2");
    expect(queryPayload(fetch.calls[0]?.url as string).tradeOrderLineId).toBe("2");
  });

  test("an empty module is an empty object, not a crash", async () => {
    const { ctx } = context([ok({})]);
    expect(await fetchLogistics(ctx, "1")).toEqual({});
  });
});

describe("fetchRefundPage", () => {
  test("uses shipTo (not shipToCountry) and the full-history status", async () => {
    const { ctx, fetch } = context([ok(REFUNDS)]);
    await fetchRefundPage(ctx);
    const call = fetch.calls[0];
    expect(call?.init.method).toBe("POST");
    const payload = bodyPayload(call?.init.body as string);
    expect(payload.shipTo).toBe("BR");
    expect(payload.reverseStatus).toBe(1);
    expect(payload.pageNo).toBe(1);
    expect(payload.size).toBe(10);
  });

  test("maps the filter names onto the numeric domain the API accepts", () => {
    // 0 and 5 answer UNKNOWN_FAIL_CODE; only these four are valid.
    expect(REVERSE_STATUS).toEqual({
      all: 1,
      in_progress: 2,
      awaiting_return: 3,
      completed: 4,
    });
  });

  test("passes the optional filters through", async () => {
    const { ctx, fetch } = context([ok(REFUNDS)]);
    await fetchRefundPage(ctx, { filter: "completed", orderId: "42", storeName: "Loja" });
    const payload = bodyPayload(fetch.calls[0]?.init.body as string);
    expect(payload).toMatchObject({ reverseStatus: 4, tradeOrderId: "42", shopName: "Loja" });
  });
});

describe("fetchAllRefunds", () => {
  test("stops after one page when it already has everything", async () => {
    const { ctx, fetch } = context([ok(REFUNDS)]);
    const page = await fetchAllRefunds(ctx);
    // The reference account has 3 refunds; `pages` came back as 0, so the loop
    // must count what it received rather than trust that field.
    expect(REFUNDS.module.pages).toBe(0);
    expect(page.items).toHaveLength(3);
    expect(fetch.calls).toHaveLength(1);
  });

  test("keeps paging while fewer lines than `total` have arrived", async () => {
    const line = { reverseOrderLineId: "1" };
    const first = { module: { total: 4, pages: 0, items: [{ shopName: "A", reverseOrderLines: [line, line] }] } };
    const second = { module: { total: 4, pages: 0, items: [{ shopName: "B", reverseOrderLines: [line, line] }] } };
    const { ctx, fetch } = context([ok(first), ok(second)]);
    const page = await fetchAllRefunds(ctx);
    expect(fetch.calls).toHaveLength(2);
    expect(bodyPayload(fetch.calls[1]?.init.body as string).pageNo).toBe(2);
    expect(page.items).toHaveLength(2);
  });

  test("stops on an empty page instead of looping to maxPages", async () => {
    const first = { module: { total: 99, items: [{ reverseOrderLines: [{ reverseOrderLineId: "1" }] }] } };
    const { ctx, fetch } = context([ok(first), ok({ module: { total: 99, items: [] } })]);
    await fetchAllRefunds(ctx);
    expect(fetch.calls).toHaveLength(2);
  });
});
