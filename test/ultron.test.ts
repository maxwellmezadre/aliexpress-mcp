import { describe, expect, test } from "bun:test";
import { ParseError } from "../src/core/errors.js";
import {
  assertPageUsable,
  buildPagePayload,
  byTag,
  fieldsOf,
  hasMore,
  keyOfTag,
  listOrders,
  orderStatusCode,
  orderedKeys,
  pageIndexOf,
} from "../src/ultron/parse.js";
import type { UltronResponse } from "../src/ultron/types.js";

const component = (tag: string, fields: Record<string, unknown> = {}) => ({ tag, type: tag, fields });

/** A list page shaped like the real one, with CMS suffixes on every key. */
function listPage(orderIds: string[], overrides: Partial<UltronResponse> = {}): UltronResponse {
  const orderKeys = orderIds.map((id) => `pc_om_list_order_${id}`);
  return {
    hierarchy: {
      root: "pc_om_list_page_109694",
      component: ["pc_om_list_body", "pc_om_list_order"],
      structure: {
        pc_om_list_page_109694: [
          "pc_om_list_header_110551",
          "pc_om_list_body_109702",
        ],
        pc_om_list_header_110551: ["pc_om_list_header_action_110846"],
        pc_om_list_body_109702: orderKeys,
      },
    },
    data: {
      pc_om_list_page_109694: component("pc_om_list_page"),
      pc_om_list_header_110551: component("pc_om_list_header"),
      pc_om_list_header_action_110846: component("pc_om_list_header_action", {
        statusTab: "all",
        timeOption: "all",
      }),
      pc_om_list_body_109702: component("pc_om_list_body", { pageIndex: 1, hasMore: true }),
      ...Object.fromEntries(
        orderIds.map((id) => [
          `pc_om_list_order_${id}`,
          { ...component("pc_om_list_order", { orderId: id }), id },
        ]),
      ),
    },
    linkage: { common: {}, signature: { s: "opaque" } },
    endpoint: { droplet: true, mode: "pc" },
    global: { orderStatus: 8 },
    ...overrides,
  };
}

describe("ordering", () => {
  test("follows hierarchy.structure, not Object.keys(data)", () => {
    const page = listPage(["300", "100", "200"]);
    // Rebuild `data` in a different key order — a real risk after JSON.parse.
    const scrambled: UltronResponse = {
      ...page,
      data: Object.fromEntries(Object.entries(page.data).reverse()),
    };
    expect(listOrders(scrambled).map((order) => order.fields.orderId)).toEqual([
      "300",
      "100",
      "200",
    ]);
  });

  test("orderedKeys walks depth first from the root", () => {
    expect(orderedKeys(listPage(["1"]))).toEqual([
      "pc_om_list_page_109694",
      "pc_om_list_header_110551",
      "pc_om_list_header_action_110846",
      "pc_om_list_body_109702",
      "pc_om_list_order_1",
    ]);
  });

  test("survives a cyclic structure instead of hanging", () => {
    const page = listPage(["1"]);
    page.hierarchy.structure.pc_om_list_order_1 = ["pc_om_list_page_109694"];
    expect(() => orderedKeys(page)).not.toThrow();
    expect(orderedKeys(page)).toHaveLength(5);
  });

  test("still returns a component that structure forgot", () => {
    const page = listPage(["1"]);
    page.data.pc_om_list_order_999 = { ...component("pc_om_list_order", { orderId: "999" }) };
    expect(listOrders(page).map((order) => order.fields.orderId)).toEqual(["1", "999"]);
  });
});

describe("selection by tag", () => {
  test("ignores the CMS suffix on the key", () => {
    expect(keyOfTag(listPage(["1"]), "pc_om_list_body")).toBe("pc_om_list_body_109702");
    expect(byTag(listPage(["1", "2"]), "pc_om_list_order")).toHaveLength(2);
  });

  test("keeps the key alongside the component", () => {
    const [first] = byTag(listPage(["42"]), "pc_om_list_order");
    expect(first?.key).toBe("pc_om_list_order_42");
    expect(first?.id).toBe("42");
  });

  test("a missing component is an actionable ParseError, not undefined", () => {
    expect(() => keyOfTag(listPage(["1"]), "detail_order_price_block")).toThrow(ParseError);
    expect(() => keyOfTag(listPage(["1"]), "nope")).toThrow(/doctor/);
  });

  test("fieldsOf returns an empty object for an absent component", () => {
    expect(fieldsOf(listPage(["1"]), "nope")).toEqual({});
  });
});

describe("page state", () => {
  test("reads hasMore and pageIndex from the body component", () => {
    expect(hasMore(listPage(["1"]))).toBe(true);
    expect(pageIndexOf(listPage(["1"]))).toBe(1);
  });

  test("reads the locale-independent status code from global", () => {
    expect(orderStatusCode(listPage(["1"]))).toBe(8);
    expect(orderStatusCode({ ...listPage(["1"]), global: {} })).toBeNull();
  });
});

describe("buildPagePayload", () => {
  test("bumps pageIndex and passes linkage, hierarchy and endpoint through", () => {
    const previous = listPage(["1"]);
    const params = buildPagePayload(previous, { pageIndex: 2 });
    const data = JSON.parse(params.data as string);
    expect(data.pc_om_list_body_109702.fields.pageIndex).toBe(2);
    expect(params.operator).toBe("pc_om_list_body_109702");
    expect(JSON.parse(params.linkage as string)).toEqual(previous.linkage);
    expect(JSON.parse(params.hierarchy as string)).toEqual(previous.hierarchy);
    expect(JSON.parse(params.endpoint as string)).toEqual(previous.endpoint);
  });

  test("merges the header filters without dropping the existing ones", () => {
    const params = buildPagePayload(listPage(["1"]), {
      pageIndex: 2,
      headerFields: { searchInput: "cabo", searchOption: "order" },
    });
    const header = JSON.parse(params.data as string).pc_om_list_header_action_110846.fields;
    expect(header).toEqual({
      statusTab: "all",
      timeOption: "all",
      searchInput: "cabo",
      searchOption: "order",
    });
  });

  test("does not mutate the previous response", () => {
    const previous = listPage(["1"]);
    buildPagePayload(previous, { pageIndex: 5 });
    expect(previous.data.pc_om_list_body_109702?.fields.pageIndex).toBe(1);
  });

  test("refuses to build a page without linkage — that returns an empty page", () => {
    const previous = listPage(["1"], { linkage: undefined });
    expect(() => buildPagePayload(previous, { pageIndex: 2 })).toThrow(ParseError);
    expect(() => buildPagePayload(previous, { pageIndex: 2 })).toThrow(/linkage/);
  });
});

describe("assertPageUsable", () => {
  test("accepts a page with orders", () => {
    expect(assertPageUsable(listPage(["1", "2"]), 2)).toHaveLength(2);
  });

  test("accepts an empty last page that still has components", () => {
    expect(assertPageUsable(listPage([]), 8)).toEqual([]);
  });

  test("rejects a SUCCESS with a completely empty data — the silent linkage failure", () => {
    const empty: UltronResponse = {
      hierarchy: { root: "x", structure: {} },
      data: {},
      linkage: {},
    };
    expect(() => assertPageUsable(empty, 3)).toThrow(/linkage/);
  });
});
