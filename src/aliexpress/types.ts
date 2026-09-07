// Raw payload shapes of the AliExpress internal API. Everything is optional:
// this is an undocumented surface and a missing field must degrade a single
// value, never throw. The normalisation into the domain model lives in
// src/domain/normalize.ts — this file only describes what comes off the wire.

export type RawSkuAttr = { id?: number; vid?: number; name?: string; text?: string };

export type RawOrderLine = {
  orderLineId?: string;
  productId?: string;
  itemTitle?: string;
  itemImgUrl?: string;
  itemDetailUrl?: string;
  itemPriceText?: string;
  /** `"R$126,59|126|59"` — the exact amount. */
  formatPriceInfo?: string;
  currencyCode?: string;
  quantity?: number;
  skuId?: string;
  /** Raw variation keys, e.g. `"14:193;5:9050340520"`. Prefer `skuAttrs`. */
  skuAttrKeys?: string;
  skuAttrs?: RawSkuAttr[];
  itemTags?: Array<{ type?: string; richText?: string; desc?: string; href?: string }>;
};

export type RawOrderButton = { type?: string; text?: string; displayType?: string; size?: string };

/** `fields` of a `pc_om_list_order` component. */
export type RawOrder = {
  orderId?: string;
  orderDateText?: string;
  orderDateTitle?: string;
  statusText?: string;
  statusTitle?: string;
  totalPriceText?: string;
  formatPriceInfo?: string;
  currencyCode?: string;
  /** The seller's own currency; the order is charged in `currencyCode`. */
  baseCurrency?: string;
  intentionCurrency?: string;
  storeName?: string;
  storePageUrl?: string;
  sellerConnectUrl?: string;
  orderDetailUrl?: string;
  /** Payment transaction id, useful for reconciling against a card statement. */
  paymentOutId?: string;
  orderLineSize?: number;
  orderLines?: RawOrderLine[];
  buttons?: RawOrderButton[];
};

/** `fields` of `detail_simple_order_info_component`. */
export type RawOrderInfo = {
  /** Comes as a NUMBER here, as a string everywhere else. */
  tradeOrderId?: number | string;
  orderCreatTime?: string; // sic: "Creat"
  orderCreatTimeTile?: string; // sic: "Tile"
  payTime?: string;
  payTimeTitle?: string;
  orderShipTime?: string;
  orderShipTimeTile?: string;
  orderEndTime?: string;
  orderEndTimeTile?: string;
  /** "Credit/Debit card" | "Parcela" | "Pagamento a Prazo". No instalment count anywhere. */
  paymentMethod?: string;
  paymentMethodTitle?: string;
  orderIdTitle?: string;
  /** Snapshot of the address AT THE TIME OF THE ORDER, not the current one. */
  addressVO?: {
    contactName?: string;
    fullPhoneNo?: string;
    countryCode?: string;
    detailAddress?: string;
    detailAddress2?: string;
    postCode?: string;
    regionAddress?: string;
  };
};

export type RawPriceRow = {
  title?: string;
  value?: string;
  hide?: boolean;
  valueColor?: string;
  tipData?: { title?: string; items?: Array<{ title?: string; content?: string }> };
};

/** `fields` of `detail_order_price_block`. Only `totalPrice` carries the pipe format. */
export type RawPriceBlock = {
  priceDetails?: RawPriceRow[];
  totalPrice?: { title?: string; value?: string; formatPriceInfo?: string; currencyCode?: string };
};

/** `fields` of `detail_product_block`. */
export type RawProductBlock = {
  productVOList?: Array<
    RawOrderLine & {
      etaAndTrack?: { expectDeliveryDateTitle?: string; deliveryDateChangeInfo?: unknown };
      snapshotUrl?: string;
      snapshotText?: string;
      buttonVOS?: RawOrderButton[];
    }
  >;
  /** Seller of the order. Absent from the list payload — only the detail has it. */
  sellerVO?: { sellerName?: string; storeUrl?: string; connectUrl?: string };
};

/** `fields` of `detail_service_progress_bar`. */
export type RawProgressBar = {
  title?: string;
  text?: string;
  currentNode?: number;
  nodes?: Array<{ text?: string; time?: string; icon?: string }>;
};

/** `module` of `mtop.ae.ld.querydetail`. */
export type RawLogistics = {
  isTrackingV2?: boolean;
  logisticsReceiverInfo?: {
    contactName?: string;
    address?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    zipCode?: string;
    phoneCountry?: string;
    phoneNumber?: string;
  };
  trackingDetailLineList?: RawTrackingLine[];
};

export type RawTrackingLine = {
  /** Local carrier code (Correios in Brazil). */
  mailNo?: string;
  /** AliExpress logistics code. */
  originMailNo?: string;
  logisticsCarrierName?: string;
  blockMailNo?: boolean;
  displayQuantity?: number;
  packageMinCreateTime?: number;
  etaInfo?: {
    etaTimeText?: string;
    beginEtaTime?: number;
    endEtaTime?: number;
    etaTimeStamp?: number;
    etaSceneCode?: string;
  };
  packageItemList?: Array<{
    itemId?: string;
    itemTitle?: string;
    itemPic?: string;
    skuId?: string;
    skuDesc?: string;
    count?: number;
  }>;
  /** Newest event first. */
  detailList?: RawTrackingEvent[];
};

export type RawTrackingEvent = {
  time?: number;
  timeText?: string;
  trackingDetailDesc?: string;
  trackingName?: string;
  /** Stable, locale-independent code. Key events by this, not by the description. */
  trackingPrimaryCode?: string;
  trackingSecondCode?: string;
  fulfillStage?: string;
  tags?: string[];
};

/** `module` of the reverse (refunds/returns) endpoint. */
export type RawRefundPage = {
  total?: number;
  pageNum?: number;
  pageSize?: number;
  /** Observed as 0 even with 3 results — do not trust it; count `items`. */
  pages?: number;
  curPagesize?: number;
  items?: Array<{ shopName?: string; reverseOrderLines?: RawRefundLine[] }>;
};

export type RawRefundLine = {
  reverseOrderId?: string;
  reverseOrderLineId?: string;
  tradeOrderId?: string;
  tradeOrderLineId?: string;
  reverseType?: string;
  reverseBizType?: string;
  reverseStatus?: number;
  solutionType?: number;
  gmtCreate?: string;
  gmtCreateFormat?: string;
  gmtModified?: string;
  gmtModifiedFormat?: string;
  aeItemDTO?: {
    itemId?: string;
    itemTitle?: string;
    itemPicUrl?: string;
    itemCount?: number;
    /** The ONLY money field in the whole API that is already numeric cents. */
    itemUnitPrice?: { cent?: number; currency?: string; formatMoney?: string };
    itemDetailUrl?: string;
    tradeSnapshotUrl?: string;
  };
  seller?: { userId?: string; storeId?: string; storeUrl?: string };
};

export type RawOrderCount = { shipped?: string; processing?: string; unpaid?: string };
