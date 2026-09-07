import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fetchOrderCount, fetchOrderListInit } from "../../src/ae/orders.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { normalizeOrderList } from "../../src/domain/normalize.js";

// One gated test against the REAL account, aimed at the single assumption the
// whole project rests on: that a browser-captured session, replayed by Bun
// outside the browser with a hand-built MTOP signature, is accepted.
//
// Everything else is covered by fixtures. This one costs two requests and only
// runs when explicitly asked for, so it never runs in CI.

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const enabled = process.env.ALIEXPRESS_LIVE === "1" && config !== null && existsSync(config.sessionPath);
const gated = enabled ? describe : describe.skip;

if (!enabled) {
  console.error(
    "integração ao vivo pulada — precisa de ALIEXPRESS_LIVE=1 e de uma sessão salva (`aliexpress login`)",
  );
}

gated("live account", () => {
  const ctx = () => createContext(loadConfig());

  test(
    "the signature is accepted outside the browser",
    async () => {
      const context = ctx();
      try {
        const counts = await fetchOrderCount(context);
        // Values come back as strings; the point is that MTOP answered SUCCESS.
        expect(counts).toBeTypeOf("object");
      } finally {
        context.dispose();
      }
    },
    30_000,
  );

  test(
    "the order list really requires the session and comes back parseable",
    async () => {
      const context = ctx();
      try {
        const page = await fetchOrderListInit(context, { statusTab: "all", timeOption: "all" });
        const orders = normalizeOrderList(page, { statusTab: "all" });
        expect(orders.length).toBeGreaterThan(0);
        // Every order must have a readable date, a total, and a mapped status:
        // an unmapped one means AliExpress introduced a label we do not know.
        for (const order of orders) {
          expect(order.orderId).toMatch(/^\d+$/);
          expect(order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(order.total?.cents).toBeGreaterThan(0);
          expect(order.status).not.toBe("unknown");
        }
      } finally {
        context.dispose();
      }
    },
    30_000,
  );
});
