import type { Ctx } from "../context.js";
import { ParseError } from "../core/errors.js";
import { timeZoneParam } from "../mtop/client.js";
import type { StatusTab } from "../domain/status.js";
import { assertPageUsable, buildPagePayload, hasMore } from "../ultron/parse.js";
import type { TaggedComponent, UltronResponse } from "../ultron/types.js";
import type { RawOrderCount } from "./types.js";

// Typed wrappers over the three order endpoints. They return the RAW payload;
// turning it into the domain model is src/domain/normalize.ts's job, so a
// layout change breaks exactly one file.

export const ORDER_COUNT_API = "mtop.aliexpress.trade.buyer.order.count";
export const ORDER_LIST_API = "mtop.aliexpress.trade.buyer.order.list";
export const ORDER_DETAIL_API = "mtop.aliexpress.trade.buyer.order.detail";

/** Windows the API offers. `all` really does reach the oldest order. */
export const TIME_OPTIONS = ["all", "6m", "1y", "2y"] as const;
export type TimeOption = (typeof TIME_OPTIONS)[number];

export type ListFilters = {
  statusTab?: StatusTab;
  timeOption?: TimeOption;
  /** Free-text search: order id, product or store (`order`) or tracking code (`track`). */
  searchInput?: string;
  searchOption?: "order" | "track";
};

const timeZoneOf = (ctx: Ctx): string => timeZoneParam(new Date(ctx.now()));

/**
 * Cheap counters per tab. NOTE: this endpoint answers SUCCESS with zeros to an
 * unauthenticated caller, so it is useless as a session probe — use the list.
 */
export async function fetchOrderCount(ctx: Ctx): Promise<RawOrderCount> {
  const response = await ctx.mtop.request<{ module?: RawOrderCount }>({
    api: ORDER_COUNT_API,
    data: { clientPlatform: "pc" },
  });
  return response.data?.module ?? {};
}

/** Page 1. A plain GET; the response seeds the paging POSTs. */
export async function fetchOrderListInit(
  ctx: Ctx,
  filters: ListFilters = {},
): Promise<UltronResponse> {
  const response = await ctx.mtop.request<UltronResponse>({
    api: ORDER_LIST_API,
    data: {
      statusTab: filters.statusTab ?? "all",
      renderType: "init",
      clientPlatform: "pc",
      timeZone: timeZoneOf(ctx),
      ...(filters.timeOption ? { timeOption: filters.timeOption } : {}),
      ...(filters.searchInput ? { searchInput: filters.searchInput } : {}),
      ...(filters.searchOption ? { searchOption: filters.searchOption } : {}),
    },
  });
  return response.data;
}

/**
 * Pages 2..N. The server takes no page number: the previous page's component
 * state is resent with `pageIndex` bumped, wrapped together with `linkage`,
 * `hierarchy` and `endpoint`. Drop `linkage` and the answer is SUCCESS with an
 * empty `data` — which reads exactly like "no more orders".
 */
export async function fetchOrderListPage(
  ctx: Ctx,
  previous: UltronResponse,
  pageIndex: number,
  filters: ListFilters = {},
): Promise<UltronResponse> {
  const headerFields: Record<string, unknown> = {};
  if (filters.statusTab) headerFields.statusTab = filters.statusTab;
  if (filters.timeOption) headerFields.timeOption = filters.timeOption;
  if (filters.searchInput !== undefined) headerFields.searchInput = filters.searchInput;
  if (filters.searchOption) headerFields.searchOption = filters.searchOption;

  const params = buildPagePayload(previous, { pageIndex, headerFields });
  const response = await ctx.mtop.request<UltronResponse>({
    api: ORDER_LIST_API,
    method: "POST",
    data: { params: JSON.stringify(params) },
  });
  return response.data;
}

/**
 * Order detail.
 *
 * Two things this call gets wrong if you follow the obvious path:
 *  - the parameter is `tradeOrderId`; passing `orderId` answers SUCCESS with an
 *    empty page skeleton, which is easy to mistake for a deleted order;
 *  - without `channel: "tracking"` the backend leaves out the logistics block.
 */
export async function fetchOrderDetail(ctx: Ctx, tradeOrderId: string): Promise<UltronResponse> {
  const response = await ctx.mtop.request<UltronResponse>({
    api: ORDER_DETAIL_API,
    data: {
      tradeOrderId,
      clientPlatform: "pc",
      timeZone: timeZoneOf(ctx),
      channel: "tracking",
    },
  });
  const page = response.data;
  assertDetailUsable(page, tradeOrderId);
  return page;
}

/** The tags a real detail always carries; their absence means the empty skeleton. */
const DETAIL_MARKERS = ["detail_simple_order_info_component", "detail_product_block"];

export function assertDetailUsable(page: UltronResponse, tradeOrderId: string): void {
  const tags = new Set(Object.values(page.data ?? {}).map((component) => component.tag));
  if (DETAIL_MARKERS.some((tag) => tags.has(tag))) return;
  throw new ParseError(
    `O detalhe do pedido ${tradeOrderId} voltou vazio (só o esqueleto da página). ` +
      "Isso acontece quando o parâmetro não é `tradeOrderId` ou quando o pedido não existe nesta conta.",
  );
}

export type OrderPage = {
  index: number;
  orders: TaggedComponent[];
  hasMore: boolean;
  response: UltronResponse;
};

/**
 * Walks the order list page by page, newest first, yielding each page. The
 * caller decides when to stop (an incremental sync stops early; a full sync
 * runs to the end), and `maxPages` is a hard stop against a server that keeps
 * answering `hasMore: true`.
 */
export async function* walkOrderPages(
  ctx: Ctx,
  filters: ListFilters = {},
  maxPages = 100,
): AsyncGenerator<OrderPage> {
  let response = await fetchOrderListInit(ctx, filters);
  let index = 1;
  for (;;) {
    const orders = assertPageUsable(response, index);
    yield { index, orders, hasMore: hasMore(response), response };
    if (!hasMore(response) || index >= maxPages) return;
    const next = await fetchOrderListPage(ctx, response, index + 1, filters);
    const nextOrders = assertPageUsable(next, index + 1);
    // Guard against a server that keeps saying hasMore while returning nothing.
    if (nextOrders.length === 0) return;
    response = next;
    index += 1;
  }
}
