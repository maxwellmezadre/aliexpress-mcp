import type { Ctx } from "../context.js";
import { timeZoneParam } from "../mtop/client.js";
import type { RawLogistics } from "./types.js";

// The canonical source for tracking. The order detail carries a summarised
// version of it (`detail_logistic_package_block`, and only when it is asked for
// with `channel: "tracking"` — which the backend still omits for some orders).
// This endpoint always has the full timeline: 26 events on a delivered package
// in the reference account.

export const LOGISTICS_API = "mtop.ae.ld.querydetail";

export async function fetchLogistics(
  ctx: Ctx,
  tradeOrderId: string,
  tradeOrderLineId = "",
): Promise<RawLogistics> {
  const regional = ctx.http.regional();
  const response = await ctx.mtop.request<{ module?: RawLogistics }>({
    api: LOGISTICS_API,
    data: {
      tradeOrderId,
      // Optional: narrows the answer to one item of a multi-package order.
      tradeOrderLineId,
      terminalType: "PC",
      needPageDisplayInfo: true,
      timeZone: timeZoneParam(new Date(ctx.now())),
      _currency: regional.currency,
    },
  });
  return response.data?.module ?? {};
}
