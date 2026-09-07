import type {
  RawLogistics,
  RawOrder,
  RawOrderInfo,
  RawOrderLine,
  RawPriceBlock,
  RawPriceRow,
  RawProductBlock,
  RawProgressBar,
  RawRefundLine,
  RawRefundPage,
  RawTrackingEvent,
  RawTrackingLine,
} from "../aliexpress/types.js";
import { fieldsOf, firstByTag, listOrders, orderStatusCode } from "../ultron/parse.js";
import type { TaggedComponent, UltronResponse } from "../ultron/types.js";
import { dayFromEpochMs, isoFromEpochMs, parseLocalisedDate } from "./dates.js";
import { type Money, money, parseAmount, parseMoneyText } from "./money.js";
import { cleanStatusText, resolveStatus, type StatusTab } from "./status.js";
import type {
  OrderDetail,
  OrderLine,
  OrderSummary,
  PackageInfo,
  PriceKey,
  PriceRow,
  RefundRecord,
  ShippingAddress,
  Store,
  TimelineStep,
  TrackingEvent,
} from "./types.js";

// The ONLY layer that knows Ultron component names and AliExpress field names.
// If the site changes its layout, this file is what breaks — everything above
// it works on the domain model.

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** `"//www.aliexpress.com/store/1105289621"` → `"1105289621"`. */
export function storeIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = /\/store\/(\d{4,})/.exec(url);
  return match?.[1] ?? null;
}

const absoluteUrl = (url: string | undefined | null): string | null => {
  const value = text(url);
  if (!value) return null;
  return value.startsWith("//") ? `https:${value}` : value;
};

/**
 * Canonical key for a price row. The label is translated, so it is matched
 * case-insensitively against both languages; anything unknown lands in `other`
 * and keeps its original label rather than being dropped from the total.
 */
export function priceKeyOf(label: string | undefined | null): PriceKey {
  const value = (label ?? "").trim().toLowerCase();
  if (value === "subtotal") return "subtotal";
  if (/^(shipping|enviando|frete)/.test(value)) return "shipping";
  if (/^(tax|imposto|duty)/.test(value)) return "tax";
  // Not documented anywhere, but present on 24 of the 70 reference orders.
  if (/installment.*fee|taxa.*parcel|juros/.test(value)) return "installment_fee";
  if (/store coupon|cupom da loja/.test(value)) return "store_coupon";
  if (/aliexpress coupon|cupom aliexpress/.test(value)) return "ae_coupon";
  if (/promo code|c[óo]digo promocional/.test(value)) return "promo_code";
  if (/store discount|desconto da loja/.test(value)) return "store_discount";
  if (/^(coins|moedas)/.test(value)) return "coins";
  if (/payment discount|desconto no pagamento/.test(value)) return "payment_discount";
  if (/spend .*save|gaste e economize/.test(value)) return "spend_save";
  return "other";
}

export function normalizePriceRow(row: RawPriceRow, currency: string): PriceRow {
  const label = text(row.title) ?? "";
  return {
    key: priceKeyOf(label),
    label,
    amount: money(parseMoneyText(row.value), currency, text(row.value) ?? ""),
    hidden: row.hide === true,
  };
}

export function normalizeSkuAttrs(line: RawOrderLine): { name: string; value: string }[] {
  // `skuAttrs` is the readable pair list; `skuAttrKeys` ("14:193;5:9050340520")
  // is the raw internal form and is never shown to a human.
  return (line.skuAttrs ?? [])
    .map((attr) => ({ name: text(attr.name) ?? "", value: text(attr.text) ?? "" }))
    .filter((attr) => attr.name !== "" || attr.value !== "");
}

export function normalizeOrderLine(line: RawOrderLine, currency: string): OrderLine {
  const quantity = typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 1;
  const unitCents = parseAmount(line.formatPriceInfo, line.itemPriceText);
  return {
    orderLineId: text(line.orderLineId),
    productId: text(line.productId),
    title: text(line.itemTitle),
    quantity,
    unitPrice: money(unitCents, currency, text(line.itemPriceText) ?? ""),
    // Verified against the Subtotal row: 2 × R$13,90 = R$27,80.
    lineTotal: money(unitCents === null ? null : unitCents * quantity, currency, ""),
    skuId: text(line.skuId),
    skuAttrs: normalizeSkuAttrs(line),
    imageUrl: absoluteUrl(line.itemImgUrl),
    productUrl: absoluteUrl(line.itemDetailUrl),
  };
}

function storeOf(order: RawOrder): Store {
  return {
    name: text(order.storeName),
    storeId: storeIdFromUrl(order.storePageUrl),
    url: absoluteUrl(order.storePageUrl),
  };
}

/** One `pc_om_list_order` component → an order summary. */
export function normalizeOrderSummary(
  component: TaggedComponent,
  options: { statusTab?: StatusTab | undefined } = {},
): OrderSummary | null {
  const order = component.fields as RawOrder;
  // The component id is the order id; the field is the authority, the id the
  // fallback (a component without either is not an order).
  const orderId = text(order.orderId) ?? text(component.id);
  if (!orderId) return null;

  const currency = text(order.currencyCode) ?? "";
  const statusText = cleanStatusText(order.statusText);
  const lines = (order.orderLines ?? []).map((line) => normalizeOrderLine(line, currency));

  return {
    orderId,
    orderDate: parseLocalisedDate(order.orderDateText),
    orderDateText: text(order.orderDateText),
    status: resolveStatus({ tab: options.statusTab, text: statusText }),
    statusText: statusText === "" ? null : statusText,
    statusTab: options.statusTab ?? null,
    total: money(
      parseAmount(order.formatPriceInfo, order.totalPriceText),
      currency,
      text(order.totalPriceText) ?? "",
    ),
    store: storeOf(order),
    paymentOutId: text(order.paymentOutId),
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    lines,
  };
}

/** A whole list page → its order summaries, in display order. */
export function normalizeOrderList(
  page: UltronResponse,
  options: { statusTab?: StatusTab | undefined } = {},
): OrderSummary[] {
  return listOrders(page)
    .map((component) => normalizeOrderSummary(component, options))
    .filter((order): order is OrderSummary => order !== null);
}

function addressOf(info: RawOrderInfo): ShippingAddress | null {
  const address = info.addressVO;
  if (!address) return null;
  return {
    contactName: text(address.contactName),
    phone: text(address.fullPhoneNo),
    country: text(address.countryCode),
    line1: text(address.detailAddress),
    line2: text(address.detailAddress2),
    postCode: text(address.postCode),
    region: text(address.regionAddress),
  };
}

function timelineOf(progress: RawProgressBar): TimelineStep[] {
  return (progress.nodes ?? []).map((node) => ({
    label: text(node.text) ?? "",
    date: parseLocalisedDate(node.time),
    dateText: text(node.time),
  }));
}

/**
 * An order detail page → the full model. `summary` is the row from the list,
 * when the caller has it: the list is the only place that carries the store and
 * the total, and the detail is the only place that carries dates, address and
 * the price breakdown. Neither is a superset of the other.
 */
export function normalizeOrderDetail(
  page: UltronResponse,
  summary: OrderSummary,
): OrderDetail {
  const info = fieldsOf(page, "detail_simple_order_info_component") as RawOrderInfo;
  const priceBlock = fieldsOf(page, "detail_order_price_block") as RawPriceBlock;
  const productBlock = fieldsOf(page, "detail_product_block") as RawProductBlock;
  const progress = fieldsOf(page, "detail_service_progress_bar") as RawProgressBar;
  const statusBlock = fieldsOf(page, "detail_order_status_block") as { title?: string };

  const currency = text(priceBlock.totalPrice?.currencyCode) ?? summary.total?.currency ?? "";
  const detailTotal = money(
    parseAmount(priceBlock.totalPrice?.formatPriceInfo, priceBlock.totalPrice?.value),
    currency,
    text(priceBlock.totalPrice?.value) ?? "",
  );

  // The detail's product block is a superset of the list's lines (it adds the
  // ETA and the legal snapshot), so it wins when present.
  const detailLines = (productBlock.productVOList ?? []).map((line) =>
    normalizeOrderLine(line, currency),
  );
  const lines = detailLines.length > 0 ? detailLines : summary.lines;

  const statusText = cleanStatusText(statusBlock.title) || (summary.statusText ?? "");
  const statusCode = orderStatusCode(page);

  const priceBreakdown = (priceBlock.priceDetails ?? []).map((row) =>
    normalizePriceRow(row, currency),
  );
  const seller = productBlock.sellerVO;
  const store: Store = seller
    ? {
        name: text(seller.sellerName) ?? summary.store.name,
        storeId: storeIdFromUrl(seller.storeUrl) ?? summary.store.storeId,
        url: absoluteUrl(seller.storeUrl) ?? summary.store.url,
      }
    : summary.store;

  return {
    ...summary,
    store,
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    total: detailTotal ?? summary.total,
    status: resolveStatus({
      tab: summary.statusTab ?? undefined,
      code: statusCode,
      text: statusText,
    }),
    statusText: statusText === "" ? summary.statusText : statusText,
    statusCode,
    createdAt: parseLocalisedDate(info.orderCreatTime),
    paidAt: parseLocalisedDate(info.payTime),
    shippedAt: parseLocalisedDate(info.orderShipTime),
    finishedAt: parseLocalisedDate(info.orderEndTime),
    paymentMethod: text(info.paymentMethod),
    // Not a shortcut: no API of the site exposes the count. See docs/DATA-MODEL.md.
    installments: null,
    installmentFee:
      priceBreakdown.find((row) => row.key === "installment_fee")?.amount ?? null,
    shippingAddress: addressOf(info),
    priceBreakdown,
    timeline: timelineOf(progress),
  };
}

/** Detail pages carry the order id as a NUMBER in one place and a string elsewhere. */
export function orderIdOfDetail(page: UltronResponse): string | null {
  const info = firstByTag(page, "detail_simple_order_info_component")?.fields as
    | RawOrderInfo
    | undefined;
  const value = info?.tradeOrderId;
  return value === undefined || value === null ? null : String(value);
}

function normalizeEvent(event: RawTrackingEvent): TrackingEvent {
  return {
    at: isoFromEpochMs(event.time),
    atText: text(event.timeText),
    description: text(event.trackingDetailDesc),
    stage: text(event.trackingName),
    primaryCode: text(event.trackingPrimaryCode),
    secondCode: text(event.trackingSecondCode),
  };
}

export function normalizePackage(line: RawTrackingLine): PackageInfo {
  return {
    trackingNumber: line.blockMailNo === true ? null : text(line.mailNo),
    originTrackingNumber: text(line.originMailNo),
    carrier: text(line.logisticsCarrierName),
    etaText: text(line.etaInfo?.etaTimeText),
    etaStart: dayFromEpochMs(line.etaInfo?.beginEtaTime),
    etaEnd: dayFromEpochMs(line.etaInfo?.endEtaTime),
    createdAt: isoFromEpochMs(line.packageMinCreateTime),
    items: (line.packageItemList ?? []).map((item) => ({
      productId: text(item.itemId),
      title: text(item.itemTitle),
      skuId: text(item.skuId),
      skuDesc: text(item.skuDesc),
      count: typeof item.count === "number" ? item.count : 1,
    })),
    events: (line.detailList ?? []).map(normalizeEvent),
  };
}

export function normalizeLogistics(module: RawLogistics | undefined | null): PackageInfo[] {
  return (module?.trackingDetailLineList ?? []).map(normalizePackage);
}

export function normalizeRefund(line: RawRefundLine, storeName: string | null): RefundRecord {
  const item = line.aeItemDTO;
  const price = item?.itemUnitPrice;
  return {
    reverseOrderId: text(line.reverseOrderId),
    reverseOrderLineId: text(line.reverseOrderLineId),
    orderId: text(line.tradeOrderId),
    orderLineId: text(line.tradeOrderLineId),
    type: text(line.reverseType),
    status: typeof line.reverseStatus === "number" ? line.reverseStatus : null,
    createdAt: parseLocalisedDate(line.gmtCreateFormat),
    updatedAt: parseLocalisedDate(line.gmtModifiedFormat),
    storeName,
    item: {
      productId: text(item?.itemId),
      title: text(item?.itemTitle),
      count: typeof item?.itemCount === "number" ? item.itemCount : 1,
      // The one place in the whole API where money arrives already numeric.
      unitPrice:
        typeof price?.cent === "number"
          ? { cents: price.cent, currency: text(price.currency) ?? "", text: text(price.formatMoney) ?? "" }
          : null,
    },
  };
}

export function normalizeRefundPage(module: RawRefundPage | undefined | null): RefundRecord[] {
  return (module?.items ?? []).flatMap((item) =>
    (item.reverseOrderLines ?? []).map((line) => normalizeRefund(line, text(item.shopName))),
  );
}

/**
 * Sum of the breakdown rows, for the invariant `Σ rows === total`. Returns null
 * when any row failed to parse — a partial sum would be a lie.
 */
export function breakdownTotal(rows: PriceRow[]): Money | null {
  if (rows.length === 0) return null;
  let cents = 0;
  let currency = "";
  for (const row of rows) {
    if (!row.amount) return null;
    cents += row.amount.cents;
    currency = currency || row.amount.currency;
  }
  return { cents, currency, text: "" };
}
