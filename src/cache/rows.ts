import { toDecimal } from "../domain/money.js";
import type {
  Money,
  OrderDetail,
  OrderLine,
  OrderSummary,
  PriceRow,
  ShippingAddress,
  TimelineStep,
} from "../domain/types.js";
import type { CacheRepo, LineRow, OrderRow } from "./repo.js";

// Cache rows → domain model → what a tool actually returns. The cache stores
// integer cents; the decimal number only ever appears at this boundary.

const money = (cents: number | null, currency: string | null): Money | null =>
  cents === null ? null : { cents, currency: currency ?? "", text: "" };

const parse = <T,>(json: string | null, fallback: T): T => {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

export function lineFromRow(row: LineRow): OrderLine {
  return {
    orderLineId: row.order_line_id,
    productId: row.product_id,
    title: row.title,
    quantity: row.quantity,
    unitPrice: money(row.unit_cents, row.currency),
    lineTotal: money(row.line_cents, row.currency),
    skuId: row.sku_id,
    skuAttrs: parse<OrderLine["skuAttrs"]>(row.sku_attrs, []),
    imageUrl: row.image_url,
    productUrl: row.product_url,
  };
}

export function summaryFromRow(row: OrderRow, lines: LineRow[]): OrderSummary {
  return {
    orderId: row.order_id,
    orderDate: row.order_date,
    orderDateText: row.order_date_text,
    status: row.status as OrderSummary["status"],
    statusText: row.status_text,
    statusTab: row.status_tab as OrderSummary["statusTab"],
    total: money(row.total_cents, row.currency),
    store: { name: row.store_name, storeId: row.store_id, url: null },
    paymentOutId: row.payment_out_id,
    itemCount: row.item_count,
    lines: lines.map(lineFromRow),
  };
}

export function detailFromCache(cache: CacheRepo, row: OrderRow): OrderDetail {
  const summary = summaryFromRow(row, cache.getLines(row.order_id));
  const priceBreakdown: PriceRow[] = cache.getPriceLines(row.order_id).map((line) => ({
    key: line.key as PriceRow["key"],
    label: line.label,
    amount: money(line.amount_cents, row.currency),
    hidden: false,
  }));
  return {
    ...summary,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    shippedAt: row.shipped_at,
    finishedAt: row.finished_at,
    paymentMethod: row.payment_method,
    installments: null,
    installmentFee:
      priceBreakdown.find((line) => line.key === "installment_fee")?.amount ?? null,
    statusCode: row.status_code,
    shippingAddress: parse<ShippingAddress | null>(row.address_json, null),
    priceBreakdown,
    timeline: parse<TimelineStep[]>(row.timeline_json, []),
  };
}

/** What a Money looks like in a tool's JSON output. */
export type MoneyOut = { amount: number; currency: string } | null;

export const moneyOut = (value: Money | null | undefined): MoneyOut =>
  value ? { amount: toDecimal(value.cents), currency: value.currency } : null;

export type LineOut = {
  orderLineId: string | null;
  productId: string | null;
  title: string | null;
  quantity: number;
  unitPrice: MoneyOut;
  lineTotal: MoneyOut;
  variations: string | null;
  productUrl?: string | null;
  imageUrl?: string | null;
  skuId?: string | null;
};

export function lineOut(line: OrderLine, compact: boolean): LineOut {
  const variations =
    line.skuAttrs.length > 0
      ? line.skuAttrs.map((attr) => `${attr.name}: ${attr.value}`).join(", ")
      : null;
  const base: LineOut = {
    orderLineId: line.orderLineId,
    productId: line.productId,
    title: line.title,
    quantity: line.quantity,
    unitPrice: moneyOut(line.unitPrice),
    lineTotal: moneyOut(line.lineTotal),
    variations,
  };
  if (compact) return base;
  return { ...base, skuId: line.skuId, productUrl: line.productUrl, imageUrl: line.imageUrl };
}

export function summaryOut(order: OrderSummary, compact: boolean) {
  const base = {
    orderId: order.orderId,
    date: order.orderDate,
    status: order.status,
    statusText: order.statusText,
    total: moneyOut(order.total),
    store: order.store.name,
    itemCount: order.itemCount,
    items: order.lines.map((line) => lineOut(line, compact)),
  };
  if (compact) return base;
  return {
    ...base,
    dateText: order.orderDateText,
    storeId: order.store.storeId,
    paymentOutId: order.paymentOutId,
  };
}

export function detailOut(detail: OrderDetail, options: { includeAddress: boolean }) {
  return {
    ...summaryOut(detail, false),
    createdAt: detail.createdAt,
    paidAt: detail.paidAt,
    shippedAt: detail.shippedAt,
    finishedAt: detail.finishedAt,
    paymentMethod: detail.paymentMethod,
    installments: detail.installments,
    installmentFee: moneyOut(detail.installmentFee),
    statusCode: detail.statusCode,
    priceBreakdown: detail.priceBreakdown.map((row) => ({
      key: row.key,
      label: row.label,
      amount: moneyOut(row.amount),
    })),
    timeline: detail.timeline,
    ...(options.includeAddress ? { shippingAddress: detail.shippingAddress } : {}),
  };
}
