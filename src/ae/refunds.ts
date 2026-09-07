import type { Ctx } from "../context.js";
import type { RawRefundPage } from "./types.js";

// Returns and refunds. Two things this endpoint does differently from every
// other one, both verified against the live account:
//   - the country parameter is `shipTo`, NOT `shipToCountry`;
//   - `reverseStatus` is required and its domain is narrow.

export const REFUND_LIST_API = "mtop.aliexpress.buyer.reverse.queryreverseorderpagelistforbuyer";

/**
 * `1` is the full history, despite the name suggesting a single state. `2` and
 * `3` are the in-progress tabs, `4` the completed one; `0` and `5` are outside
 * the domain and answer `UNKNOWN_FAIL_CODE`.
 */
export const REVERSE_STATUS = {
  all: 1,
  in_progress: 2,
  awaiting_return: 3,
  completed: 4,
} as const;

export type RefundFilter = keyof typeof REVERSE_STATUS;

export const REFUND_PAGE_SIZE = 10;

export async function fetchRefundPage(
  ctx: Ctx,
  options: { filter?: RefundFilter; pageNo?: number; orderId?: string; storeName?: string } = {},
): Promise<RawRefundPage> {
  const regional = ctx.http.regional();
  const response = await ctx.mtop.request<{ module?: RawRefundPage }>({
    api: REFUND_LIST_API,
    method: "POST",
    data: {
      pageNo: options.pageNo ?? 1,
      size: REFUND_PAGE_SIZE,
      sortOrder: "DESC",
      // Not `shipToCountry`, unlike every other endpoint.
      shipTo: regional.region,
      reverseStatus: REVERSE_STATUS[options.filter ?? "all"],
      shopName: options.storeName ?? "",
      tradeOrderId: options.orderId ?? "",
    },
  });
  return response.data?.module ?? {};
}

/**
 * Every refund page. `module.pages` came back as 0 with 3 real results, so the
 * loop counts what it received against `total` instead of trusting it.
 */
export async function fetchAllRefunds(
  ctx: Ctx,
  options: { filter?: RefundFilter } = {},
  maxPages = 20,
): Promise<RawRefundPage> {
  const first = await fetchRefundPage(ctx, options);
  const items = [...(first.items ?? [])];
  const total = typeof first.total === "number" ? first.total : items.length;

  for (let pageNo = 2; pageNo <= maxPages; pageNo += 1) {
    const seen = items.reduce((sum, item) => sum + (item.reverseOrderLines?.length ?? 0), 0);
    if (seen >= total) break;
    const page = await fetchRefundPage(ctx, { ...options, pageNo });
    const next = page.items ?? [];
    if (next.length === 0) break;
    items.push(...next);
  }
  return { ...first, items };
}
