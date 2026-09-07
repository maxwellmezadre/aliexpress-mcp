import type { Database } from "bun:sqlite";
import type { OrderStatus, StatusTab } from "../domain/status.js";
import { isFinalStatus } from "../domain/status.js";
import type {
  OrderDetail,
  OrderLine,
  OrderSummary,
  PackageInfo,
  PriceRow,
  RefundRecord,
} from "../domain/types.js";
import { Where, escapeLike, inTx } from "../core/sqlite.js";

// All SQL lives here. Rows are the storage shape (integer cents, ISO day
// strings); the mapping back to the domain model happens on read, so a better
// parser can be re-run over `raw_detail` without another crawl.

export type OrderRow = {
  order_id: string;
  order_date: string | null;
  order_date_text: string | null;
  status: string;
  status_text: string | null;
  status_tab: string | null;
  status_code: number | null;
  total_cents: number | null;
  currency: string | null;
  store_name: string | null;
  store_id: string | null;
  payment_out_id: string | null;
  payment_method: string | null;
  item_count: number;
  created_at: string | null;
  paid_at: string | null;
  shipped_at: string | null;
  finished_at: string | null;
  address_json: string | null;
  timeline_json: string | null;
  is_final: number;
  detail_fetched_at: string | null;
  detail_error: string | null;
  raw_detail: string | null;
  parser_version: number | null;
  updated_at: string;
};

export type LineRow = {
  order_line_id: string;
  order_id: string;
  position: number;
  product_id: string | null;
  title: string | null;
  quantity: number;
  unit_cents: number | null;
  line_cents: number | null;
  currency: string | null;
  sku_id: string | null;
  sku_attrs: string | null;
  image_url: string | null;
  product_url: string | null;
};

export type OrderFilters = {
  status?: OrderStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  store?: string | undefined;
  includeUnpaid?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type SpendingGroup = "month" | "year" | "store" | "payment_method" | "breakdown";

export type SpendingRow = {
  key: string;
  orders: number;
  items: number;
  totalCents: number;
};

export type CacheStats = {
  orders: number;
  lines: number;
  packages: number;
  refunds: number;
  withDetail: number;
  pendingDetail: number;
  oldestOrder: string | null;
  newestOrder: string | null;
};

export type CacheRepo = ReturnType<typeof createCacheRepo>;

/** Statuses where no money left the account; excluded from spending by default. */
const UNPAID_STATUSES = ["cancelled", "expired", "unpaid"] as const;

export function createCacheRepo(db: Database, now: () => number) {
  const iso = (): string => new Date(now()).toISOString();

  const lineToRow = (line: OrderLine, orderId: string, position: number): LineRow => ({
    order_line_id: line.orderLineId ?? `${orderId}-${position}`,
    order_id: orderId,
    position,
    product_id: line.productId,
    title: line.title,
    quantity: line.quantity,
    unit_cents: line.unitPrice?.cents ?? null,
    line_cents: line.lineTotal?.cents ?? null,
    currency: line.unitPrice?.currency ?? null,
    sku_id: line.skuId,
    sku_attrs: line.skuAttrs.length > 0 ? JSON.stringify(line.skuAttrs) : null,
    image_url: line.imageUrl,
    product_url: line.productUrl,
  });

  function replaceLines(orderId: string, lines: OrderLine[]): void {
    db.query("DELETE FROM order_lines WHERE order_id = ?").run(orderId);
    const insert = db.query(
      `INSERT INTO order_lines
         (order_line_id, order_id, position, product_id, title, quantity, unit_cents,
          line_cents, currency, sku_id, sku_attrs, image_url, product_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_line_id) DO UPDATE SET
         order_id = excluded.order_id, position = excluded.position,
         product_id = excluded.product_id, title = excluded.title,
         quantity = excluded.quantity, unit_cents = excluded.unit_cents,
         line_cents = excluded.line_cents, currency = excluded.currency,
         sku_id = excluded.sku_id, sku_attrs = excluded.sku_attrs,
         image_url = excluded.image_url, product_url = excluded.product_url`,
    );
    lines.forEach((line, position) => {
      const row = lineToRow(line, orderId, position);
      insert.run(
        row.order_line_id,
        row.order_id,
        row.position,
        row.product_id,
        row.title,
        row.quantity,
        row.unit_cents,
        row.line_cents,
        row.currency,
        row.sku_id,
        row.sku_attrs,
        row.image_url,
        row.product_url,
      );
    });
  }

  function replacePriceLines(orderId: string, rows: PriceRow[]): void {
    db.query("DELETE FROM order_price_lines WHERE order_id = ?").run(orderId);
    const insert = db.query(
      `INSERT INTO order_price_lines (order_id, position, key, label, amount_cents)
       VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, position) => {
      insert.run(orderId, position, row.key, row.label, row.amount?.cents ?? null);
    });
  }

  return {
    /**
     * Upsert from a LIST row. It must never clobber what the detail
     * established: the list has no dates, no address and no breakdown, so those
     * columns are only ever written by `upsertDetail`.
     */
    upsertSummary(order: OrderSummary): { inserted: boolean; changed: boolean } {
      return inTx(db, () => {
        const previous = db
          .query("SELECT status FROM orders WHERE order_id = ?")
          .get(order.orderId) as { status: string } | null;

        db.query(
          `INSERT INTO orders
             (order_id, order_date, order_date_text, status, status_text, status_tab,
              total_cents, currency, store_name, store_id, payment_out_id, item_count,
              is_final, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id) DO UPDATE SET
             order_date = excluded.order_date,
             order_date_text = excluded.order_date_text,
             status = excluded.status,
             status_text = excluded.status_text,
             status_tab = excluded.status_tab,
             total_cents = COALESCE(excluded.total_cents, orders.total_cents),
             currency = COALESCE(excluded.currency, orders.currency),
             store_name = COALESCE(excluded.store_name, orders.store_name),
             store_id = COALESCE(excluded.store_id, orders.store_id),
             payment_out_id = COALESCE(excluded.payment_out_id, orders.payment_out_id),
             item_count = excluded.item_count,
             is_final = excluded.is_final,
             updated_at = excluded.updated_at`,
        ).run(
          order.orderId,
          order.orderDate,
          order.orderDateText,
          order.status,
          order.statusText,
          order.statusTab,
          order.total?.cents ?? null,
          order.total?.currency ?? null,
          order.store.name,
          order.store.storeId,
          order.paymentOutId,
          order.itemCount,
          isFinalStatus(order.status) ? 1 : 0,
          iso(),
        );

        if (order.lines.length > 0) replaceLines(order.orderId, order.lines);

        return {
          inserted: previous === null,
          // Deliberately status-only. Comparing the total would report a change
          // on every incremental sync of an order whose detail refined the
          // amount the list showed, and the "stop at the first page with
          // nothing new" rule would then never stop.
          changed: previous === null || previous.status !== order.status,
        };
      });
    },

    /** Upsert from a DETAIL page: the only writer of dates, address and breakdown. */
    upsertDetail(detail: OrderDetail, rawDetail: string, parserVersion: number): void {
      inTx(db, () => {
        db.query(
          `UPDATE orders SET
             status = ?, status_text = ?, status_code = ?,
             total_cents = COALESCE(?, total_cents),
             currency = COALESCE(?, currency),
             store_name = COALESCE(?, store_name),
             store_id = COALESCE(?, store_id),
             payment_method = ?, item_count = ?,
             created_at = ?, paid_at = ?, shipped_at = ?, finished_at = ?,
             address_json = ?, timeline_json = ?,
             is_final = ?, detail_fetched_at = ?, detail_error = NULL,
             raw_detail = ?, parser_version = ?, updated_at = ?
           WHERE order_id = ?`,
        ).run(
          detail.status,
          detail.statusText,
          detail.statusCode,
          detail.total?.cents ?? null,
          detail.total?.currency ?? null,
          detail.store.name,
          detail.store.storeId,
          detail.paymentMethod,
          detail.itemCount,
          detail.createdAt,
          detail.paidAt,
          detail.shippedAt,
          detail.finishedAt,
          detail.shippingAddress ? JSON.stringify(detail.shippingAddress) : null,
          detail.timeline.length > 0 ? JSON.stringify(detail.timeline) : null,
          isFinalStatus(detail.status) ? 1 : 0,
          iso(),
          rawDetail,
          parserVersion,
          iso(),
          detail.orderId,
        );
        if (detail.lines.length > 0) replaceLines(detail.orderId, detail.lines);
        replacePriceLines(detail.orderId, detail.priceBreakdown);
      });
    },

    markDetailError(orderId: string, message: string): void {
      db.query("UPDATE orders SET detail_error = ?, updated_at = ? WHERE order_id = ?").run(
        message.slice(0, 500),
        iso(),
        orderId,
      );
    },

    resetDetailErrors(): void {
      db.query("UPDATE orders SET detail_error = NULL WHERE detail_error IS NOT NULL").run();
    },

    /**
     * The queue for the detail phase: never fetched, or fetched while the order
     * was still in flight. A finished order is fetched once and never again.
     */
    nextPendingDetail(staleBefore: string): string | null {
      const row = db
        .query(
          `SELECT order_id FROM orders
            WHERE detail_error IS NULL
              AND (detail_fetched_at IS NULL OR (is_final = 0 AND detail_fetched_at < ?))
            ORDER BY order_date DESC
            LIMIT 1`,
        )
        .get(staleBefore) as { order_id: string } | null;
      return row?.order_id ?? null;
    },

    pendingDetailCount(staleBefore: string): number {
      const row = db
        .query(
          `SELECT COUNT(*) AS n FROM orders
            WHERE detail_error IS NULL
              AND (detail_fetched_at IS NULL OR (is_final = 0 AND detail_fetched_at < ?))`,
        )
        .get(staleBefore) as { n: number };
      return row.n;
    },

    /** Orders whose cached detail was parsed by an older parser. */
    ordersToReparse(parserVersion: number): Array<{ order_id: string; raw_detail: string }> {
      return db
        .query(
          `SELECT order_id, raw_detail FROM orders
            WHERE raw_detail IS NOT NULL
              AND (parser_version IS NULL OR parser_version <> ?)`,
        )
        .all(parserVersion) as Array<{ order_id: string; raw_detail: string }>;
    },

    getOrder(orderId: string): OrderRow | null {
      return (db.query("SELECT * FROM orders WHERE order_id = ?").get(orderId) as OrderRow) ?? null;
    },

    getLines(orderId: string): LineRow[] {
      return db
        .query("SELECT * FROM order_lines WHERE order_id = ? ORDER BY position")
        .all(orderId) as LineRow[];
    },

    getPriceLines(orderId: string): Array<{
      key: string;
      label: string;
      amount_cents: number | null;
    }> {
      return db
        .query(
          "SELECT key, label, amount_cents FROM order_price_lines WHERE order_id = ? ORDER BY position",
        )
        .all(orderId) as Array<{ key: string; label: string; amount_cents: number | null }>;
    },

    listOrders(filters: OrderFilters = {}): OrderRow[] {
      const where = new Where();
      where.maybe(filters.status, "status = ?", filters.status);
      where.maybe(filters.from, "order_date >= ?", filters.from);
      where.maybe(filters.to, "order_date <= ?", filters.to);
      where.maybe(filters.store, "store_name LIKE ? ESCAPE '\\'", `%${escapeLike(filters.store ?? "")}%`);
      if (filters.includeUnpaid !== true && filters.status === undefined) {
        where.add(`status NOT IN (${UNPAID_STATUSES.map(() => "?").join(",")})`, ...UNPAID_STATUSES);
      }
      return db
        .query(
          `SELECT * FROM orders ${where.sql()}
            ORDER BY order_date DESC, order_id DESC
            LIMIT ? OFFSET ?`,
        )
        .all(...where.values, filters.limit ?? 50, filters.offset ?? 0) as OrderRow[];
    },

    countOrders(filters: OrderFilters = {}): number {
      const where = new Where();
      where.maybe(filters.status, "status = ?", filters.status);
      where.maybe(filters.from, "order_date >= ?", filters.from);
      where.maybe(filters.to, "order_date <= ?", filters.to);
      where.maybe(filters.store, "store_name LIKE ? ESCAPE '\\'", `%${escapeLike(filters.store ?? "")}%`);
      if (filters.includeUnpaid !== true && filters.status === undefined) {
        where.add(`status NOT IN (${UNPAID_STATUSES.map(() => "?").join(",")})`, ...UNPAID_STATUSES);
      }
      const row = db.query(`SELECT COUNT(*) AS n FROM orders ${where.sql()}`).get(...where.values) as {
        n: number;
      };
      return row.n;
    },

    /** Rebuilds the FTS index from the lines. Cheap enough to redo after a sync. */
    rebuildFts(): void {
      inTx(db, () => {
        db.exec("DELETE FROM order_lines_fts");
        db.exec(
          `INSERT INTO order_lines_fts (rowid, title, sku_attrs, store_name)
             SELECT l.rowid, COALESCE(l.title, ''), COALESCE(l.sku_attrs, ''), COALESCE(o.store_name, '')
               FROM order_lines l JOIN orders o ON o.order_id = l.order_id`,
        );
      });
    },

    searchLines(
      query: string,
      filters: { from?: string | undefined; to?: string | undefined; limit?: number | undefined } = {},
    ): Array<LineRow & { order_date: string | null; store_name: string | null; status: string }> {
      const where = new Where().add("l.rowid IN (SELECT rowid FROM order_lines_fts WHERE order_lines_fts MATCH ?)", ftsQuery(query));
      where.maybe(filters.from, "o.order_date >= ?", filters.from);
      where.maybe(filters.to, "o.order_date <= ?", filters.to);
      return db
        .query(
          `SELECT l.*, o.order_date, o.store_name, o.status
             FROM order_lines l JOIN orders o ON o.order_id = l.order_id
             ${where.sql()}
             ORDER BY o.order_date DESC
             LIMIT ?`,
        )
        .all(...where.values, filters.limit ?? 50) as Array<
        LineRow & { order_date: string | null; store_name: string | null; status: string }
      >;
    },

    spendingSummary(
      group: Exclude<SpendingGroup, "breakdown">,
      filters: { from?: string | undefined; to?: string | undefined; includeUnpaid?: boolean | undefined } = {},
    ): SpendingRow[] {
      const expression: Record<typeof group, string> = {
        month: "substr(order_date, 1, 7)",
        year: "substr(order_date, 1, 4)",
        store: "COALESCE(store_name, 'unknown')",
        payment_method: "COALESCE(payment_method, 'unknown')",
      };
      const where = new Where().add("order_date IS NOT NULL");
      where.maybe(filters.from, "order_date >= ?", filters.from);
      where.maybe(filters.to, "order_date <= ?", filters.to);
      if (filters.includeUnpaid !== true) {
        where.add(`status NOT IN (${UNPAID_STATUSES.map(() => "?").join(",")})`, ...UNPAID_STATUSES);
      }
      return db
        .query(
          `SELECT ${expression[group]} AS key,
                  COUNT(*) AS orders,
                  COALESCE(SUM(item_count), 0) AS items,
                  COALESCE(SUM(total_cents), 0) AS totalCents
             FROM orders ${where.sql()}
            GROUP BY key
            ORDER BY key DESC`,
        )
        .all(...where.values) as SpendingRow[];
    },

    /** What the money went on: tax, shipping, coupons — from the detail rows. */
    spendingBreakdown(
      filters: { from?: string | undefined; to?: string | undefined; includeUnpaid?: boolean | undefined } = {},
    ): SpendingRow[] {
      const where = new Where().add("o.order_date IS NOT NULL");
      where.maybe(filters.from, "o.order_date >= ?", filters.from);
      where.maybe(filters.to, "o.order_date <= ?", filters.to);
      if (filters.includeUnpaid !== true) {
        where.add(`o.status NOT IN (${UNPAID_STATUSES.map(() => "?").join(",")})`, ...UNPAID_STATUSES);
      }
      return db
        .query(
          `SELECT p.key AS key,
                  COUNT(DISTINCT p.order_id) AS orders,
                  0 AS items,
                  COALESCE(SUM(p.amount_cents), 0) AS totalCents
             FROM order_price_lines p JOIN orders o ON o.order_id = p.order_id
             ${where.sql()}
            GROUP BY p.key
            ORDER BY totalCents DESC`,
        )
        .all(...where.values) as SpendingRow[];
    },

    upsertPackages(orderId: string, packages: PackageInfo[]): void {
      inTx(db, () => {
        db.query("DELETE FROM packages WHERE order_id = ?").run(orderId);
        const insert = db.query(
          `INSERT INTO packages
             (order_id, tracking_number, origin_tracking_no, carrier, eta_text, eta_start,
              eta_end, created_at, delivered, payload_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const pkg of packages) {
          insert.run(
            orderId,
            pkg.trackingNumber ?? pkg.originTrackingNumber ?? `${orderId}-pkg`,
            pkg.originTrackingNumber,
            pkg.carrier,
            pkg.etaText,
            pkg.etaStart,
            pkg.etaEnd,
            pkg.createdAt,
            isDelivered(pkg) ? 1 : 0,
            JSON.stringify(pkg),
            iso(),
          );
        }
      });
    },

    getPackages(orderId: string): PackageInfo[] {
      const rows = db
        .query("SELECT payload_json FROM packages WHERE order_id = ?")
        .all(orderId) as Array<{ payload_json: string }>;
      return rows.map((row) => JSON.parse(row.payload_json) as PackageInfo);
    },

    /** Orders whose packages are worth refreshing: none cached, or still moving. */
    ordersNeedingTracking(limit: number): string[] {
      return (
        db
          .query(
            `SELECT o.order_id FROM orders o
               LEFT JOIN packages p ON p.order_id = o.order_id
              WHERE o.status IN ('shipped', 'processing')
                AND (p.order_id IS NULL OR p.delivered = 0)
              GROUP BY o.order_id
              ORDER BY o.order_date DESC
              LIMIT ?`,
          )
          .all(limit) as Array<{ order_id: string }>
      ).map((row) => row.order_id);
    },

    upsertRefunds(refunds: RefundRecord[]): number {
      return inTx(db, () => {
        const insert = db.query(
          `INSERT INTO refunds
             (reverse_order_line_id, reverse_order_id, order_id, order_line_id, type, status,
              created_at, updated_at, store_name, product_id, title, count, unit_cents,
              currency, updated_row_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(reverse_order_line_id) DO UPDATE SET
             status = excluded.status, updated_at = excluded.updated_at,
             updated_row_at = excluded.updated_row_at`,
        );
        let written = 0;
        for (const refund of refunds) {
          const id = refund.reverseOrderLineId ?? refund.reverseOrderId;
          if (!id) continue;
          insert.run(
            id,
            refund.reverseOrderId,
            refund.orderId,
            refund.orderLineId,
            refund.type,
            refund.status,
            refund.createdAt,
            refund.updatedAt,
            refund.storeName,
            refund.item.productId,
            refund.item.title,
            refund.item.count,
            refund.item.unitPrice?.cents ?? null,
            refund.item.unitPrice?.currency ?? null,
            iso(),
          );
          written += 1;
        }
        return written;
      });
    },

    listRefunds(limit = 50): Array<Record<string, unknown>> {
      return db
        .query("SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Array<Record<string, unknown>>;
    },

    getMeta(key: string): string | null {
      const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
        | { value: string }
        | null;
      return row?.value ?? null;
    },

    setMeta(key: string, value: string | null): void {
      if (value === null) {
        db.query("DELETE FROM meta WHERE key = ?").run(key);
        return;
      }
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
    },

    stats(): CacheStats {
      const one = <T,>(sql: string): T => db.query(sql).get() as T;
      const counts = one<{
        orders: number;
        withDetail: number;
        oldest: string | null;
        newest: string | null;
      }>(
        `SELECT COUNT(*) AS orders,
                SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS withDetail,
                MIN(order_date) AS oldest, MAX(order_date) AS newest
           FROM orders`,
      );
      return {
        orders: counts.orders,
        withDetail: counts.withDetail ?? 0,
        pendingDetail: one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM orders WHERE detail_fetched_at IS NULL AND detail_error IS NULL",
        ).n,
        lines: one<{ n: number }>("SELECT COUNT(*) AS n FROM order_lines").n,
        packages: one<{ n: number }>("SELECT COUNT(*) AS n FROM packages").n,
        refunds: one<{ n: number }>("SELECT COUNT(*) AS n FROM refunds").n,
        oldestOrder: counts.oldest,
        newestOrder: counts.newest,
      };
    },
  };
}

/** A package is done when its newest event says it was signed for/delivered. */
function isDelivered(pkg: PackageInfo): boolean {
  const code = pkg.events[0]?.primaryCode ?? "";
  return /SIGNED|DELIVERED|POD/i.test(code);
}

/** Quotes each term so user input can never break FTS5 syntax. */
export function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(" ");
}

export type { StatusTab };
