import type { Money } from "./money.js";
import type { OrderStatus, StatusTab } from "./status.js";

// The normalised model the tools expose. The value of this project is handing
// over clean data, not raw Ultron. Rules baked into these types:
//   - money is integer cents inside `Money`, converted only at the boundary;
//   - every localised string keeps its original next to the parsed value;
//   - anything that could not be parsed is `null`, never a guess.

export type { Money } from "./money.js";

export type Store = { name: string | null; storeId: string | null; url: string | null };

export type SkuAttr = { name: string; value: string };

export type OrderLine = {
  orderLineId: string | null;
  productId: string | null;
  title: string | null;
  quantity: number;
  /** Per unit — verified against the Subtotal row (2 × R$13,90 = R$27,80). */
  unitPrice: Money | null;
  /** unitPrice × quantity. What actually adds up to the Subtotal. */
  lineTotal: Money | null;
  skuId: string | null;
  skuAttrs: SkuAttr[];
  imageUrl: string | null;
  productUrl: string | null;
};

/** Canonical key for a price row, so reports do not group by a translated label. */
export type PriceKey =
  | "subtotal"
  | "shipping"
  | "tax"
  | "store_coupon"
  | "ae_coupon"
  | "coins"
  | "payment_discount"
  | "spend_save"
  | "other";

export type PriceRow = {
  key: PriceKey;
  /** The label exactly as AliExpress wrote it, in the account's language. */
  label: string;
  amount: Money | null;
  /** AliExpress collapses some rows behind a "details" toggle. */
  hidden: boolean;
};

export type ShippingAddress = {
  contactName: string | null;
  phone: string | null;
  country: string | null;
  line1: string | null;
  line2: string | null;
  postCode: string | null;
  region: string | null;
};

export type OrderSummary = {
  orderId: string;
  /** ISO `YYYY-MM-DD`, or null when the localised text could not be read. */
  orderDate: string | null;
  orderDateText: string | null;
  status: OrderStatus;
  /** Original, localised — kept for auditing. */
  statusText: string | null;
  statusTab: StatusTab | null;
  total: Money | null;
  store: Store;
  /** Payment transaction id: the hook for reconciling against a card statement. */
  paymentOutId: string | null;
  itemCount: number;
  lines: OrderLine[];
};

export type TimelineStep = { label: string; date: string | null; dateText: string | null };

export type OrderDetail = OrderSummary & {
  createdAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  finishedAt: string | null;
  paymentMethod: string | null;
  /**
   * ALWAYS null. AliExpress does not expose the instalment count or amount in
   * any API of the site — verified, including the wallet bundle. `paymentMethod`
   * is the only signal; cross-reference the card statement.
   */
  installments: null;
  /** `global.orderStatus`: locale-independent, but only partially mapped. */
  statusCode: number | null;
  /** Snapshot of the address AT THE TIME OF THE ORDER, not the current one. */
  shippingAddress: ShippingAddress | null;
  priceBreakdown: PriceRow[];
  timeline: TimelineStep[];
};

export type TrackingEvent = {
  at: string | null;
  atText: string | null;
  description: string | null;
  /** Stage label, localised. */
  stage: string | null;
  /** Stable code — key events by this, not by the description. */
  primaryCode: string | null;
  secondCode: string | null;
};

export type PackageItem = {
  productId: string | null;
  title: string | null;
  skuId: string | null;
  skuDesc: string | null;
  count: number;
};

export type PackageInfo = {
  /** Local carrier code (Correios in Brazil). */
  trackingNumber: string | null;
  /** AliExpress logistics code. */
  originTrackingNumber: string | null;
  carrier: string | null;
  etaText: string | null;
  etaStart: string | null;
  etaEnd: string | null;
  createdAt: string | null;
  items: PackageItem[];
  /** Newest first, as AliExpress returns them. */
  events: TrackingEvent[];
};

export type RefundRecord = {
  reverseOrderId: string | null;
  reverseOrderLineId: string | null;
  orderId: string | null;
  orderLineId: string | null;
  /** RETURN | REFUND | … */
  type: string | null;
  status: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  storeName: string | null;
  item: {
    productId: string | null;
    title: string | null;
    count: number;
    unitPrice: Money | null;
  };
};
