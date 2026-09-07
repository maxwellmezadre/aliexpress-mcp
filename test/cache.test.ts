import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCache } from "../src/cache/db.js";
import { createCacheRepo, ftsQuery } from "../src/cache/repo.js";
import { normalizeOrderDetail, normalizeOrderList } from "../src/domain/normalize.js";
import type { OrderSummary, PackageInfo } from "../src/domain/types.js";
import { normalizeLogistics, normalizeRefundPage } from "../src/domain/normalize.js";
import type { UltronResponse } from "../src/ultron/types.js";

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const LIST = fixture<{ data: UltronResponse }>("order-list-init").data;
const DETAIL = fixture<{ data: UltronResponse }>("order-detail").data;
const LOGISTICS = fixture<{ data: { module: unknown } }>("logistics-querydetail").data.module;
const REFUNDS = fixture<{ data: { module: unknown } }>("refund-list").data.module;

const summaries = normalizeOrderList(LIST, { statusTab: "all" });

let db: Database | undefined;
const repo = () => {
  db = openCache(":memory:");
  return createCacheRepo(db, () => 1_757_000_000_000);
};
afterEach(() => db?.close());

describe("migrations", () => {
  test("are idempotent and record the schema version", () => {
    const cache = openCache(":memory:");
    const version = cache.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe("1");
    cache.close();
  });
});

describe("upsertSummary", () => {
  test("stores an order with its lines and reports it as new", () => {
    const cache = repo();
    const result = cache.upsertSummary(summaries[0] as OrderSummary);
    expect(result.inserted).toBe(true);
    expect(result.changed).toBe(true);
    const row = cache.getOrder((summaries[0] as OrderSummary).orderId);
    expect(row?.total_cents).toBe((summaries[0] as OrderSummary).total?.cents as number);
    expect(cache.getLines(row?.order_id as string).length).toBeGreaterThan(0);
  });

  test("running it twice changes nothing and does not duplicate lines", () => {
    const cache = repo();
    const order = summaries[0] as OrderSummary;
    cache.upsertSummary(order);
    const before = cache.getLines(order.orderId).length;
    const second = cache.upsertSummary(order);
    expect(second.inserted).toBe(false);
    expect(second.changed).toBe(false);
    expect(cache.getLines(order.orderId)).toHaveLength(before);
    expect(cache.stats().orders).toBe(1);
  });

  test("reports a status change, which is what makes an incremental sync stop or continue", () => {
    const cache = repo();
    const order = summaries.find((candidate) => candidate.status === "completed") as OrderSummary;
    cache.upsertSummary(order);
    expect(cache.upsertSummary(order).changed).toBe(false);
    const moved = cache.upsertSummary({ ...order, status: "shipped" });
    expect(moved.changed).toBe(true);
    expect(cache.getOrder(order.orderId)?.is_final).toBe(0);
  });

  test("a refined total alone is NOT a change — otherwise incremental never settles", () => {
    // The detail refines the amount the list showed; if that counted as a
    // change, every incremental sync would think the whole page was new.
    const cache = repo();
    const order = summaries[0] as OrderSummary;
    cache.upsertSummary(order);
    const refined = cache.upsertSummary({
      ...order,
      total: { cents: 999_99, currency: "BRL", text: "R$999,99" },
    });
    expect(refined.changed).toBe(false);
    expect(cache.getOrder(order.orderId)?.total_cents).toBe(999_99);
  });

  test("marks terminal statuses as final so their detail is never refetched", () => {
    const cache = repo();
    for (const order of summaries) cache.upsertSummary(order);
    const finals = summaries.filter((order) => order.status === "completed");
    expect(finals.length).toBeGreaterThan(0);
    expect(cache.getOrder(finals[0]?.orderId as string)?.is_final).toBe(1);
  });
});

describe("upsertDetail", () => {
  const seeded = () => {
    const cache = repo();
    for (const order of summaries) cache.upsertSummary(order);
    const summary = summaries[2] as OrderSummary;
    const detail = normalizeOrderDetail(DETAIL, summary);
    cache.upsertDetail(detail, JSON.stringify(DETAIL), 1);
    return { cache, summary, detail };
  };

  test("writes the dates, the address and the breakdown the list never had", () => {
    const { cache, summary } = seeded();
    const row = cache.getOrder(summary.orderId);
    expect(row?.paid_at).toBe("2026-07-15");
    expect(row?.payment_method).toBe("Credit/Debit card");
    expect(JSON.parse(row?.address_json as string).postCode).toBe("00000-000");
    expect(cache.getPriceLines(summary.orderId).map((line) => line.key)).toEqual([
      "subtotal",
      "shipping",
      "store_coupon",
      "ae_coupon",
      "tax",
    ]);
  });

  test("keeps the raw payload so a better parser can be re-run offline", () => {
    const { cache, summary } = seeded();
    const row = cache.getOrder(summary.orderId);
    expect(row?.raw_detail).toBeTruthy();
    expect(row?.parser_version).toBe(1);
    expect(cache.ordersToReparse(2).map((item) => item.order_id)).toContain(summary.orderId);
    expect(cache.ordersToReparse(1)).toHaveLength(0);
  });

  test("the stored breakdown still adds up to the stored total", () => {
    const { cache, summary } = seeded();
    const rows = cache.getPriceLines(summary.orderId);
    const sum = rows.reduce((total, row) => total + (row.amount_cents ?? 0), 0);
    expect(sum).toBe(cache.getOrder(summary.orderId)?.total_cents as number);
  });
});

describe("the detail queue", () => {
  test("hands out orders without a detail and skips the ones that failed", () => {
    const cache = repo();
    for (const order of summaries) cache.upsertSummary(order);
    const stale = "2100-01-01T00:00:00.000Z";
    expect(cache.pendingDetailCount(stale)).toBe(summaries.length);
    const first = cache.nextPendingDetail(stale) as string;
    cache.markDetailError(first, "boom");
    expect(cache.nextPendingDetail(stale)).not.toBe(first);
    expect(cache.pendingDetailCount(stale)).toBe(summaries.length - 1);
    cache.resetDetailErrors();
    expect(cache.pendingDetailCount(stale)).toBe(summaries.length);
  });

  test("a finished order is fetched once and never again; one in flight is refreshed", () => {
    const cache = repo();
    const done = summaries.find((order) => order.status === "completed") as OrderSummary;
    const moving = summaries.find((order) => order.status === "shipped") as OrderSummary;
    cache.upsertSummary(done);
    cache.upsertSummary(moving);
    const detail = normalizeOrderDetail(DETAIL, done);
    cache.upsertDetail({ ...detail, orderId: done.orderId }, "{}", 1);
    cache.upsertDetail({ ...detail, orderId: moving.orderId, status: "shipped" }, "{}", 1);
    // Both were just fetched: nothing pending.
    expect(cache.pendingDetailCount("2020-01-01T00:00:00.000Z")).toBe(0);
    // Later, only the one still moving comes back into the queue.
    const stale = "2100-01-01T00:00:00.000Z";
    expect(cache.pendingDetailCount(stale)).toBe(1);
    expect(cache.nextPendingDetail(stale)).toBe(moving.orderId);
  });
});

describe("listing and counting", () => {
  const seeded = () => {
    const cache = repo();
    for (const order of summaries) cache.upsertSummary(order);
    return cache;
  };

  test("excludes orders where no money was ever paid, by default", () => {
    const cache = seeded();
    const withUnpaid = { ...(summaries[0] as OrderSummary), orderId: "999", status: "expired" as const };
    cache.upsertSummary(withUnpaid);
    expect(cache.countOrders()).toBe(summaries.length);
    expect(cache.countOrders({ includeUnpaid: true })).toBe(summaries.length + 1);
    expect(cache.countOrders({ status: "expired" })).toBe(1);
  });

  test("filters by date range and by store, newest first", () => {
    const cache = seeded();
    const rows = cache.listOrders({ from: "2026-07-01", to: "2026-07-31" });
    expect(rows.every((row) => (row.order_date as string).startsWith("2026-07"))).toBe(true);
    expect(rows[0]?.order_date).toBe("2026-07-15");
    const store = summaries[0]?.store.name as string;
    expect(cache.listOrders({ store: store.slice(0, 4) }).length).toBeGreaterThan(0);
  });

  test("a store filter with a LIKE wildcard is taken literally", () => {
    const cache = seeded();
    expect(cache.listOrders({ store: "%" })).toHaveLength(0);
  });

  test("paginates", () => {
    const cache = seeded();
    const page1 = cache.listOrders({ limit: 3 });
    const page2 = cache.listOrders({ limit: 3, offset: 3 });
    expect(page1).toHaveLength(3);
    expect(page1.map((row) => row.order_id)).not.toEqual(page2.map((row) => row.order_id));
  });
});

describe("full text search", () => {
  test("finds an accented title from an unaccented query", () => {
    const cache = repo();
    const order = { ...(summaries[0] as OrderSummary) };
    order.lines = [
      { ...(order.lines[0] as OrderSummary["lines"][number]), title: "Cabo de Café Rápido" },
    ];
    cache.upsertSummary(order);
    cache.rebuildFts();
    expect(cache.searchLines("cafe")).toHaveLength(1);
    expect(cache.searchLines("CAFÉ")).toHaveLength(1);
    expect(cache.searchLines("guarda-chuva")).toHaveLength(0);
  });

  test("quotes the terms so a query can never break FTS syntax", () => {
    expect(ftsQuery('cabo "hdmi')).toBe('"cabo" "hdmi"');
    const cache = repo();
    cache.upsertSummary(summaries[0] as OrderSummary);
    cache.rebuildFts();
    expect(() => cache.searchLines('OR AND "')).not.toThrow();
  });

  test("rebuilding twice does not duplicate the index", () => {
    const cache = repo();
    cache.upsertSummary(summaries[0] as OrderSummary);
    cache.rebuildFts();
    const before = cache.searchLines(summaries[0]?.lines[0]?.title?.split(" ")[0] ?? "a").length;
    cache.rebuildFts();
    expect(cache.searchLines(summaries[0]?.lines[0]?.title?.split(" ")[0] ?? "a")).toHaveLength(before);
  });
});

describe("spending", () => {
  const seeded = () => {
    const cache = repo();
    for (const order of summaries) cache.upsertSummary(order);
    return cache;
  };

  test("groups by month and matches the sum of the totals", () => {
    const cache = seeded();
    const rows = cache.spendingSummary("month");
    const total = rows.reduce((sum, row) => sum + row.totalCents, 0);
    const expected = summaries.reduce((sum, order) => sum + (order.total?.cents ?? 0), 0);
    expect(total).toBe(expected);
    expect(rows[0]?.key).toBe("2026-09");
  });

  test("groups by year and by store", () => {
    const cache = seeded();
    expect(cache.spendingSummary("year")[0]?.key).toBe("2026");
    expect(cache.spendingSummary("store").length).toBeGreaterThan(1);
  });

  test("leaves unpaid orders out of the totals", () => {
    const cache = seeded();
    const before = cache.spendingSummary("year")[0]?.totalCents as number;
    cache.upsertSummary({
      ...(summaries[0] as OrderSummary),
      orderId: "999",
      status: "cancelled",
    });
    expect(cache.spendingSummary("year")[0]?.totalCents).toBe(before);
    expect(cache.spendingSummary("year", { includeUnpaid: true })[0]?.totalCents).toBeGreaterThan(
      before,
    );
  });

  test("breaks the money down into what it was spent on", () => {
    const cache = seeded();
    const summary = summaries[2] as OrderSummary;
    cache.upsertDetail(normalizeOrderDetail(DETAIL, summary), "{}", 1);
    const rows = cache.spendingBreakdown();
    const keys = rows.map((row) => row.key);
    expect(keys).toContain("tax");
    expect(keys).toContain("subtotal");
    expect(rows.find((row) => row.key === "tax")?.totalCents).toBe(2261);
  });
});

describe("packages and refunds", () => {
  test("stores the timeline and reads it back whole", () => {
    const cache = repo();
    cache.upsertSummary(summaries[0] as OrderSummary);
    const packages = normalizeLogistics(LOGISTICS as never);
    cache.upsertPackages((summaries[0] as OrderSummary).orderId, packages);
    const back = cache.getPackages((summaries[0] as OrderSummary).orderId);
    expect(back).toHaveLength(1);
    expect((back[0] as PackageInfo).events).toHaveLength(26);
  });

  test("a delivered package is not queued for another tracking call", () => {
    const cache = repo();
    const moving = summaries.find((order) => order.status === "shipped") as OrderSummary;
    cache.upsertSummary(moving);
    expect(cache.ordersNeedingTracking(10)).toEqual([moving.orderId]);
    cache.upsertPackages(moving.orderId, normalizeLogistics(LOGISTICS as never));
    expect(cache.ordersNeedingTracking(10)).toEqual([]);
  });

  test("upserts refunds without duplicating them", () => {
    const cache = repo();
    const refunds = normalizeRefundPage(REFUNDS as never);
    expect(cache.upsertRefunds(refunds)).toBe(3);
    cache.upsertRefunds(refunds);
    expect(cache.stats().refunds).toBe(3);
    expect(cache.listRefunds()[0]?.unit_cents).toBe(6125);
  });
});

describe("meta", () => {
  test("round trips and deletes", () => {
    const cache = repo();
    expect(cache.getMeta("sync.cursor")).toBeNull();
    cache.setMeta("sync.cursor", '{"offset":2}');
    expect(cache.getMeta("sync.cursor")).toBe('{"offset":2}');
    cache.setMeta("sync.cursor", null);
    expect(cache.getMeta("sync.cursor")).toBeNull();
  });
});
