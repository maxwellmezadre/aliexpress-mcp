import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listOrders, orderedKeys } from "../../src/ultron/parse.js";
import type { UltronResponse } from "../../src/ultron/types.js";

// Golden corpus over the RAW captures (task/captures/, gitignored). It asserts
// against the untouched payloads, so it catches anything the anonymiser might
// have papered over. Skips itself when the captures are not on this machine.

const DIR = join(import.meta.dir, "..", "..", "task", "captures");
const available = existsSync(join(DIR, "order-list-init.json"));
const gated = available ? describe : describe.skip;

const load = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as T;

gated("raw captures", () => {
  test("the list order comes from hierarchy.structure, never from Object.keys", () => {
    const page = load<{ data: UltronResponse }>("order-list-init").data;
    const dates = listOrders(page).map((order) => String(order.fields.orderDateText));
    const parsed = dates.map((text) => Date.parse(text));
    // Newest first: the sequence is non-increasing.
    for (let index = 1; index < parsed.length; index += 1) {
      expect(parsed[index] as number).toBeLessThanOrEqual(parsed[index - 1] as number);
    }
    // And Object.keys really is scrambled — the guard is not theoretical.
    const objectOrder = Object.entries(page.data)
      .filter(([, component]) => component.tag === "pc_om_list_order")
      .map(([, component]) => String(component.fields.orderDateText));
    expect(objectOrder).not.toEqual(dates);
  });

  test("every component referenced by the hierarchy exists in data", () => {
    for (const name of ["order-list-init", "order-detail"]) {
      const page = load<{ data: UltronResponse }>(name).data;
      for (const key of orderedKeys(page)) expect(page.data[key]).toBeDefined();
    }
  });

  test("the price breakdown adds up to the total, to the cent", () => {
    const detail = load<{ data: UltronResponse }>("order-detail").data;
    const block = Object.values(detail.data).find(
      (component) => component.tag === "detail_order_price_block",
    );
    const rows = block?.fields.priceDetails as Array<{ title: string; value: string }>;
    const total = block?.fields.totalPrice as { value: string };
    const cents = (text: string): number => {
      if (!/\d/.test(text)) return 0; // "Free shipping"
      const negative = text.trim().startsWith("-");
      const digits = text.replace(/[^\d,]/g, "").replace(",", "");
      return negative ? -Number(digits) : Number(digits);
    };
    expect(rows.reduce((sum, row) => sum + cents(row.value), 0)).toBe(cents(total.value));
  });
});
