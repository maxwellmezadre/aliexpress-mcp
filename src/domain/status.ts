// Order status. `statusText` is translated (and, in pt_BR, comes with a
// trailing space), so it can never be the primary key for anything. Precedence:
//
//   1. the tab the order was listed under — the source of truth, when known;
//   2. `global.orderStatus`, a numeric code that does not depend on the locale;
//   3. the text table below, as a last resort.

export const ORDER_STATUSES = [
  "unpaid",
  "processing",
  "shipped",
  "completed",
  "cancelled",
  /** Never paid: AliExpress closed the order when the payment window ran out. */
  "expired",
  "unknown",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The tabs `order.list` accepts, plus `recycle` (deleted orders). */
export const STATUS_TABS = [
  "all",
  "unpaid",
  "processing",
  "shipped",
  "completed",
  "recycle",
] as const;
export type StatusTab = (typeof STATUS_TABS)[number];

const BY_TAB: Partial<Record<StatusTab, OrderStatus>> = {
  unpaid: "unpaid",
  processing: "processing",
  shipped: "shipped",
  completed: "completed",
};

/**
 * Localised labels observed in the account (en_US) and documented for pt_BR.
 * Keys are lower-cased and trimmed; unknown text falls through to "unknown"
 * rather than being guessed at.
 */
const BY_TEXT: Record<string, OrderStatus> = {
  // en_US
  "to pay": "unpaid",
  "awaiting payment": "unpaid",
  "unpaid": "unpaid",
  "processing": "processing",
  "processed": "shipped",
  "awaiting delivery": "shipped",
  "awaiting shipment": "processing",
  "shipped": "shipped",
  "completed": "completed",
  "finished": "completed",
  "cancelled": "cancelled",
  "canceled": "cancelled",
  "order cancelled": "cancelled",
  "closed": "cancelled",
  // Observed on 3 orders of the reference account: the payment window ran out.
  "expired": "expired",
  "payment expired": "expired",
  // pt_BR
  "a ser pago": "unpaid",
  "aguardando pagamento": "unpaid",
  "processando": "processing",
  "processado": "shipped",
  "aguardando a entrega": "shipped",
  "enviado": "shipped",
  "concluído": "completed",
  "concluido": "completed",
  "finalizado": "completed",
  "cancelado": "cancelled",
  "compra cancelada": "cancelled",
  "pedido cancelado": "cancelled",
  "expirado": "expired",
  "pagamento expirado": "expired",
};

/** `"Concluído "` → `"Concluído"`. AliExpress ships a trailing space in pt_BR. */
export const cleanStatusText = (value: string | undefined | null): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

export function statusFromText(value: string | undefined | null): OrderStatus {
  return BY_TEXT[cleanStatusText(value).toLowerCase()] ?? "unknown";
}

/**
 * Numeric codes seen so far. Deliberately sparse: the full table is not
 * documented anywhere, so an unmapped code falls back to the text rather than
 * being invented. Observed: 9 on a completed order that had a partial refund.
 */
const BY_CODE: Record<number, OrderStatus> = {
  8: "completed",
  9: "completed",
};

export type StatusInput = {
  /** The tab the order was listed under, when the crawl knows it. */
  tab?: StatusTab | undefined;
  /** `global.orderStatus` from the order detail. */
  code?: number | null | undefined;
  text?: string | null | undefined;
};

export function resolveStatus(input: StatusInput): OrderStatus {
  const fromTab = input.tab ? BY_TAB[input.tab] : undefined;
  if (fromTab) return fromTab;
  const fromText = statusFromText(input.text);
  if (fromText !== "unknown") return fromText;
  if (typeof input.code === "number") return BY_CODE[input.code] ?? "unknown";
  return "unknown";
}

/** Terminal statuses never change again: their detail is cached forever. */
export const isFinalStatus = (status: OrderStatus): boolean =>
  status === "completed" || status === "cancelled" || status === "expired";

/**
 * Statuses where no money ever left the account. They are excluded from
 * spending reports by default — counting them would inflate every total.
 */
export const isUnpaidStatus = (status: OrderStatus): boolean =>
  status === "cancelled" || status === "expired" || status === "unpaid";
