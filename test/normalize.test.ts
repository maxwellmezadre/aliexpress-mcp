import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawLogistics, RawRefundPage } from "../src/ae/types.js";
import {
  breakdownTotal,
  normalizeLogistics,
  normalizeOrderDetail,
  normalizeOrderList,
  normalizeRefundPage,
  orderIdOfDetail,
  priceKeyOf,
  storeIdFromUrl,
} from "../src/domain/normalize.js";
import type { UltronResponse } from "../src/ultron/types.js";

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const LIST = fixture<{ data: UltronResponse }>("order-list-init").data;
const DETAIL = fixture<{ data: UltronResponse }>("order-detail").data;
const LOGISTICS = fixture<{ data: { module: RawLogistics } }>("logistics-querydetail").data.module;
const REFUNDS = fixture<{ data: { module: RawRefundPage } }>("refund-list").data.module;

describe("helpers", () => {
  test("pulls the store id out of the store url", () => {
    expect(storeIdFromUrl("//www.aliexpress.com/store/1105289621")).toBe("1105289621");
    expect(storeIdFromUrl("https://www.aliexpress.com/store/1105289621/x")).toBe("1105289621");
    expect(storeIdFromUrl("//www.aliexpress.com/item/1.html")).toBeNull();
    expect(storeIdFromUrl(undefined)).toBeNull();
  });

  test("maps the price labels of both languages onto one key", () => {
    expect(priceKeyOf("Subtotal")).toBe("subtotal");
    expect(priceKeyOf("Shipping")).toBe("shipping");
    expect(priceKeyOf("Enviando")).toBe("shipping");
    expect(priceKeyOf("Tax")).toBe("tax");
    expect(priceKeyOf("Imposto")).toBe("tax");
    expect(priceKeyOf("Store Coupon")).toBe("store_coupon");
    expect(priceKeyOf("Cupom da Loja")).toBe("store_coupon");
    expect(priceKeyOf("AliExpress Coupons")).toBe("ae_coupon");
    expect(priceKeyOf("Cupom AliExpress")).toBe("ae_coupon");
    expect(priceKeyOf("Moedas")).toBe("coins");
    expect(priceKeyOf("Desconto no pagamento")).toBe("payment_discount");
    expect(priceKeyOf("Gaste e Economize")).toBe("spend_save");
    // Unknown labels are kept, not dropped: they still count towards the total.
    expect(priceKeyOf("Alguma taxa nova")).toBe("other");
  });
});

describe("normalizeOrderList", () => {
  const orders = normalizeOrderList(LIST, { statusTab: "all" });

  test("keeps the display order and every order", () => {
    expect(orders).toHaveLength(10);
    expect(orders.map((order) => order.orderDate)).toEqual([
      "2026-09-01",
      "2026-09-01",
      "2026-07-15",
      "2026-07-15",
      "2026-06-26",
      "2026-05-27",
      "2026-05-18",
      "2026-04-23",
      "2026-04-19",
      "2026-04-08",
    ]);
  });

  test("resolves the status from the label and keeps the original", () => {
    const statuses = new Set(orders.map((order) => order.status));
    expect([...statuses].sort()).toEqual(["completed", "shipped"]);
    expect(orders.every((order) => order.statusText !== null)).toBe(true);
  });

  test("reads the total as exact cents from the pipe format", () => {
    for (const order of orders) {
      expect(order.total?.cents).toBeGreaterThan(0);
      expect(order.total?.currency).toBe("BRL");
    }
  });

  test("item prices are per unit, and the line total multiplies by quantity", () => {
    const multi = orders.find((order) => order.lines.some((line) => line.quantity > 1));
    const line = multi?.lines.find((candidate) => candidate.quantity > 1);
    expect(line).toBeDefined();
    expect(line?.lineTotal?.cents).toBe((line?.unitPrice?.cents as number) * (line?.quantity as number));
  });

  test("itemCount is the sum of the quantities, not the number of lines", () => {
    const multi = orders.find((order) => order.lines.some((line) => line.quantity > 1));
    expect(multi?.itemCount).toBeGreaterThan(multi?.lines.length as number);
  });

  test("reads the store and its id", () => {
    expect(orders.every((order) => order.store.name !== null)).toBe(true);
    expect(orders.some((order) => order.store.storeId !== null)).toBe(true);
  });

  test("reads the readable variation pairs, not the raw sku keys", () => {
    const withSku = orders.flatMap((order) => order.lines).find((line) => line.skuAttrs.length > 0);
    expect(withSku?.skuAttrs[0]).toHaveProperty("name");
    expect(withSku?.skuAttrs[0]).toHaveProperty("value");
    // Never the raw `skuAttrKeys` form ("14:193;5:9050340520").
    for (const attr of withSku?.skuAttrs ?? []) {
      expect(attr.value).not.toMatch(/^\d+:\d+/);
      expect(attr.name).not.toMatch(/^\d+$/);
    }
  });
});

describe("normalizeOrderDetail", () => {
  const summary = normalizeOrderList(LIST)[2] as ReturnType<typeof normalizeOrderList>[number];
  const detail = normalizeOrderDetail(DETAIL, summary);

  test("reads every date the detail carries", () => {
    expect(detail.createdAt).toBe("2026-07-15");
    expect(detail.paidAt).toBe("2026-07-15");
    expect(detail.finishedAt).toBe("2026-07-28");
  });

  test("the breakdown adds up to the total, to the cent", () => {
    expect(breakdownTotal(detail.priceBreakdown)?.cents).toBe(detail.total?.cents);
  });

  test("classifies every row of the real breakdown", () => {
    expect(detail.priceBreakdown.map((row) => row.key)).toEqual([
      "subtotal",
      "shipping",
      "store_coupon",
      "ae_coupon",
      "tax",
    ]);
    // "Free shipping" is zero, not a failed parse.
    expect(detail.priceBreakdown[1]?.amount?.cents).toBe(0);
    // Coupons are negative.
    expect(detail.priceBreakdown[2]?.amount?.cents).toBeLessThan(0);
  });

  test("installments is always null — AliExpress exposes no instalment data", () => {
    expect(detail.installments).toBeNull();
    expect(detail.paymentMethod).toBe("Credit/Debit card");
  });

  test("takes the seller from the detail, which the list does not carry", () => {
    expect(detail.store.name).toBeTruthy();
    expect(detail.store.storeId).toMatch(/^\d+$/);
  });

  test("keeps the address as the historical snapshot it is", () => {
    expect(detail.shippingAddress?.contactName).toBe("Comprador Exemplo");
    expect(detail.shippingAddress?.postCode).toBe("00000-000");
  });

  test("reads the numeric status code and the timeline", () => {
    expect(detail.statusCode).toBe(9);
    expect(detail.status).toBe("completed");
    expect(detail.timeline[0]).toEqual({
      label: "Paid",
      date: "2026-07-15",
      dateText: "Jul 15, 2026",
    });
  });

  test("finds the order id the detail carries as a number", () => {
    expect(orderIdOfDetail(DETAIL)).toMatch(/^\d+$/);
  });

  test("falls back to the summary when a block is missing", () => {
    const bare: UltronResponse = { hierarchy: { root: "r", structure: {} }, data: {} };
    const fallback = normalizeOrderDetail(bare, summary);
    expect(fallback.lines).toEqual(summary.lines);
    expect(fallback.total).toEqual(summary.total);
    expect(fallback.priceBreakdown).toEqual([]);
    expect(fallback.shippingAddress).toBeNull();
  });
});

describe("normalizeLogistics", () => {
  const packages = normalizeLogistics(LOGISTICS);

  test("reads both tracking codes and the carrier", () => {
    expect(packages).toHaveLength(1);
    expect(packages[0]?.trackingNumber).toBe("AA000000000BR");
    expect(packages[0]?.originTrackingNumber).toBe("LP00000000000000");
    expect(packages[0]?.carrier).toBeTruthy();
  });

  test("keeps the whole timeline, newest first, keyed by the stable code", () => {
    const events = packages[0]?.events ?? [];
    expect(events.length).toBe(26);
    expect(events[0]?.primaryCode).toBe("AE_GTMS_SIGNED");
    expect(events[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const first = Date.parse(events[0]?.at as string);
    const second = Date.parse(events[1]?.at as string);
    expect(first).toBeGreaterThanOrEqual(second);
  });

  test("reads the eta window and the package contents", () => {
    expect(packages[0]?.etaText).toBeTruthy();
    expect(packages[0]?.etaStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(packages[0]?.items[0]?.count).toBeGreaterThan(0);
  });

  test("an empty module yields no packages instead of throwing", () => {
    expect(normalizeLogistics(undefined)).toEqual([]);
    expect(normalizeLogistics({})).toEqual([]);
  });
});

describe("normalizeRefundPage", () => {
  const refunds = normalizeRefundPage(REFUNDS);

  test("flattens the store groups into records", () => {
    expect(refunds).toHaveLength(3);
    expect(refunds.every((refund) => refund.storeName !== null)).toBe(true);
  });

  test("keeps the link back to the original order", () => {
    expect(refunds[0]?.orderId).toMatch(/^\d+$/);
    expect(refunds[0]?.orderLineId).toMatch(/^\d+$/);
  });

  test("uses the numeric cents this endpoint uniquely provides", () => {
    // The display string here is dot-decimal ("R$61.25") while the Ultron
    // endpoints are comma-decimal; `cent` sidesteps the whole question.
    expect(refunds[0]?.item.unitPrice?.cents).toBe(6125);
    expect(refunds[0]?.item.unitPrice?.currency).toBe("BRL");
  });

  test("parses the ISO timestamps this endpoint answers with", () => {
    expect(refunds[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(refunds[0]?.type).toBe("RETURN");
  });

  test("an empty module yields no records", () => {
    expect(normalizeRefundPage(undefined)).toEqual([]);
    expect(normalizeRefundPage({ total: 0, items: [] })).toEqual([]);
  });
});
