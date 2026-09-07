import { fetchLogistics } from "../ae/logistics.js";
import { fetchOrderDetail, walkOrderPages } from "../ae/orders.js";
import { fetchAllRefunds } from "../ae/refunds.js";
import type { Ctx } from "../context.js";
import { AuthError, CaptchaError, MtopError, ParseError, RateLimitError } from "../core/errors.js";
import {
  normalizeLogistics,
  normalizeOrderDetail,
  normalizeOrderList,
  normalizeRefundPage,
} from "../domain/normalize.js";
import type { OrderSummary } from "../domain/types.js";
import type { UltronResponse } from "../ultron/types.js";
import type { CacheRepo } from "./repo.js";

// Filling the cache. Chunked and resumable because a tool call has a client
// timeout and AliExpress is only comfortable at roughly one request per second.
//
// Phase A (the order list) always runs to completion inside one chunk: Ultron
// paging needs the PREVIOUS page's response in memory to build the next POST,
// so a cursor could not resume mid-list without persisting a 50 KB payload.
// It is also the cheap half — 7 requests, ~3.5 s for a 70-order history. The
// expensive half is the details (one request per order), and that is what the
// budget actually rations.

/** Bump when a parser changes: cached details are re-parsed on the next sync. */
export const PARSER_VERSION = 2;

export const META_CURSOR = "sync.cursor";
export const META_LAST_SYNC = "sync.last_completed_at";
export const META_LAST_FULL = "sync.last_full_at";

/** How long a non-final order's detail stays fresh. */
export const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;

export type SyncMode = "incremental" | "full" | "reparse";

export type SyncOptions = {
  mode?: SyncMode;
  maxRequests?: number;
  withDetails?: boolean;
  withTracking?: boolean;
  withRefunds?: boolean;
  maxPages?: number;
};

export type SyncReport = {
  done: boolean;
  mode: SyncMode;
  requestsUsed: number;
  pagesFetched: number;
  ordersSeen: number;
  ordersNew: number;
  ordersChanged: number;
  detailsFetched: number;
  detailErrors: number;
  pendingDetails: number;
  trackingFetched: number;
  refundsFetched: number;
  reparsed: number;
  durationMs: number;
  warnings: string[];
  hint?: string;
};

type Cursor = { mode: SyncMode; listDone: boolean; startedAt: number };

function readCursor(cache: CacheRepo): Cursor | null {
  const raw = cache.getMeta(META_CURSOR);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Cursor;
  } catch {
    return null;
  }
}

/**
 * One chunk of work. Call it again with the same arguments while it answers
 * `done: false` — the cursor lives in the cache, so a new process (or the CLI
 * after the MCP server gave up) picks up exactly where it stopped.
 */
export async function runSyncChunk(ctx: Ctx, options: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = ctx.now();
  const cache = ctx.cache();
  const budget = options.maxRequests ?? 40;
  const withDetails = options.withDetails ?? true;
  const withTracking = options.withTracking ?? true;
  const withRefunds = options.withRefunds ?? true;

  const cursor = readCursor(cache);
  const mode = resolveMode(cache, options.mode, cursor);

  const report: SyncReport = {
    done: false,
    mode,
    requestsUsed: 0,
    pagesFetched: 0,
    ordersSeen: 0,
    ordersNew: 0,
    ordersChanged: 0,
    detailsFetched: 0,
    detailErrors: 0,
    pendingDetails: 0,
    trackingFetched: 0,
    refundsFetched: 0,
    reparsed: 0,
    durationMs: 0,
    warnings: [],
  };

  if (mode === "reparse") {
    report.reparsed = reparseAll(ctx, cache);
    cache.rebuildFts();
    report.done = true;
    report.durationMs = ctx.now() - startedAt;
    return report;
  }

  let listDone = cursor?.listDone === true && cursor.mode === mode;

  // ---- Phase A: the order list -------------------------------------------
  if (!listDone) {
    if (mode === "full") cache.resetDetailErrors();
    let seenNothingNew = false;
    for await (const page of walkOrderPages(ctx, { statusTab: "all", timeOption: "all" }, options.maxPages ?? 100)) {
      report.pagesFetched += 1;
      report.requestsUsed += 1;
      const orders = normalizeOrderList(page.response, { statusTab: "all" });
      let newOnPage = 0;
      for (const order of orders) {
        report.ordersSeen += 1;
        const result = cache.upsertSummary(order);
        if (result.inserted) report.ordersNew += 1;
        if (result.changed) {
          report.ordersChanged += 1;
          newOnPage += 1;
        }
      }
      // An incremental sync stops at the first page where nothing is new or
      // changed: everything older than that is already known and immutable.
      if (mode === "incremental" && newOnPage === 0 && orders.length > 0) {
        seenNothingNew = true;
        break;
      }
    }
    listDone = true;
    if (seenNothingNew) report.warnings.push("incremental: parou na primeira página sem novidades");
    cache.setMeta(META_CURSOR, JSON.stringify({ mode, listDone, startedAt } satisfies Cursor));
  }

  const staleBefore = new Date(ctx.now() - DETAIL_TTL_MS).toISOString();

  // ---- Phase B: the order details ----------------------------------------
  if (withDetails) {
    while (report.requestsUsed < budget) {
      const orderId = cache.nextPendingDetail(staleBefore);
      if (!orderId) break;
      try {
        const page = await fetchOrderDetail(ctx, orderId);
        report.requestsUsed += 1;
        const summary = summaryOf(cache, orderId);
        cache.upsertDetail(normalizeOrderDetail(page, summary), JSON.stringify(page), PARSER_VERSION);
        report.detailsFetched += 1;
      } catch (error) {
        report.requestsUsed += 1;
        // A session or anti-bot failure is fatal for the whole run; anything
        // else parks that one order so the queue keeps moving.
        if (error instanceof AuthError || error instanceof CaptchaError) throw error;
        if (error instanceof MtopError || error instanceof ParseError || error instanceof RateLimitError) {
          cache.markDetailError(orderId, error.message);
          report.detailErrors += 1;
          continue;
        }
        throw error;
      }
    }
    report.pendingDetails = cache.pendingDetailCount(staleBefore);
  }

  // ---- Phase C: tracking for packages still moving ------------------------
  if (withTracking && report.requestsUsed < budget) {
    const remaining = budget - report.requestsUsed;
    for (const orderId of cache.ordersNeedingTracking(remaining)) {
      if (report.requestsUsed >= budget) break;
      try {
        const module = await fetchLogistics(ctx, orderId);
        report.requestsUsed += 1;
        cache.upsertPackages(orderId, normalizeLogistics(module));
        report.trackingFetched += 1;
      } catch (error) {
        report.requestsUsed += 1;
        if (error instanceof AuthError || error instanceof CaptchaError) throw error;
        report.warnings.push(`rastreio de ${orderId}: ${messageOf(error)}`);
      }
    }
  }

  // ---- Phase D: refunds ---------------------------------------------------
  if (withRefunds && report.requestsUsed < budget) {
    try {
      const before = ctx.mtop.calls();
      const page = await fetchAllRefunds(ctx);
      report.requestsUsed += ctx.mtop.calls() - before;
      report.refundsFetched = cache.upsertRefunds(normalizeRefundPage(page));
    } catch (error) {
      if (error instanceof AuthError || error instanceof CaptchaError) throw error;
      report.warnings.push(`devoluções: ${messageOf(error)}`);
    }
  }

  report.pendingDetails = withDetails ? cache.pendingDetailCount(staleBefore) : 0;
  report.done = listDone && report.pendingDetails === 0;

  if (report.done) {
    cache.rebuildFts();
    cache.setMeta(META_CURSOR, null);
    const finishedAt = new Date(ctx.now()).toISOString();
    cache.setMeta(META_LAST_SYNC, finishedAt);
    if (mode === "full") cache.setMeta(META_LAST_FULL, finishedAt);
  } else {
    cache.setMeta(META_CURSOR, JSON.stringify({ mode, listDone, startedAt } satisfies Cursor));
    report.hint = `Faltam ${report.pendingDetails} detalhes. Chame \`sync\` de novo com os mesmos parâmetros até \`done: true\`.`;
  }

  report.durationMs = ctx.now() - startedAt;
  return report;
}

/**
 * An incremental sync only makes sense on top of a completed full one: without
 * that, "stop at the first page with nothing new" would leave the history with
 * a hole. An interrupted full sync also stays full until it finishes.
 */
function resolveMode(cache: CacheRepo, requested: SyncMode | undefined, cursor: Cursor | null): SyncMode {
  if (requested === "reparse" || requested === "full") return requested;
  if (cursor && cursor.mode === "full") return "full";
  return cache.getMeta(META_LAST_FULL) === null ? "full" : "incremental";
}

/** Rebuilds the domain rows from the stored payloads. No network at all. */
function reparseAll(ctx: Ctx, cache: CacheRepo): number {
  let count = 0;
  for (const row of cache.ordersToReparse(PARSER_VERSION)) {
    let page: UltronResponse;
    try {
      page = JSON.parse(row.raw_detail) as UltronResponse;
    } catch {
      continue;
    }
    try {
      const summary = summaryOf(cache, row.order_id);
      cache.upsertDetail(normalizeOrderDetail(page, summary), row.raw_detail, PARSER_VERSION);
      count += 1;
    } catch (error) {
      ctx.log.warn(`reparse ${row.order_id}: ${messageOf(error)}`);
    }
  }
  return count;
}

/**
 * The summary the detail normaliser folds into. The list row is the only place
 * that carries the total and the store for an order whose detail is missing
 * those, so it is read back from the cache rather than reconstructed.
 */
function summaryOf(cache: CacheRepo, orderId: string): OrderSummary {
  const row = cache.getOrder(orderId);
  const lines = cache.getLines(orderId);
  return {
    orderId,
    orderDate: row?.order_date ?? null,
    orderDateText: row?.order_date_text ?? null,
    status: (row?.status ?? "unknown") as OrderSummary["status"],
    statusText: row?.status_text ?? null,
    statusTab: (row?.status_tab ?? null) as OrderSummary["statusTab"],
    total:
      row?.total_cents === null || row?.total_cents === undefined
        ? null
        : { cents: row.total_cents, currency: row.currency ?? "", text: "" },
    store: { name: row?.store_name ?? null, storeId: row?.store_id ?? null, url: null },
    paymentOutId: row?.payment_out_id ?? null,
    itemCount: row?.item_count ?? 0,
    lines: lines.map((line) => ({
      orderLineId: line.order_line_id,
      productId: line.product_id,
      title: line.title,
      quantity: line.quantity,
      unitPrice:
        line.unit_cents === null
          ? null
          : { cents: line.unit_cents, currency: line.currency ?? "", text: "" },
      lineTotal:
        line.line_cents === null
          ? null
          : { cents: line.line_cents, currency: line.currency ?? "", text: "" },
      skuId: line.sku_id,
      skuAttrs: line.sku_attrs ? (JSON.parse(line.sku_attrs) as OrderSummary["lines"][number]["skuAttrs"]) : [],
      imageUrl: line.image_url,
      productUrl: line.product_url,
    })),
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
