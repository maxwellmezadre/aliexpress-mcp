// Shapes of the Ultron/DX protocol, the component-graph format `order.list` and
// `order.detail` answer with. The page is described as a graph: `hierarchy`
// says which component contains which (and in what display order), and `data`
// holds each component's state. The business data lives in `data[key].fields`.

export type UltronComponent = {
  /** Component type, e.g. `pc_om_list_order`. Stable — select by this. */
  tag: string;
  type?: string;
  /** Usually the order id for `pc_om_list_order`. */
  id?: string;
  position?: string;
  status?: string;
  fields: Record<string, unknown>;
};

export type UltronHierarchy = {
  root: string;
  /** Tags present in the response. Informational. */
  component?: string[];
  /** Parent key → child keys, in DISPLAY ORDER. The only ordering source. */
  structure: Record<string, string[]>;
};

export type UltronResponse = {
  hierarchy: UltronHierarchy;
  data: Record<string, UltronComponent>;
  /**
   * Opaque blob carrying a signature and gzip+base64 payloads. Never interpret
   * it; pass it back verbatim. Omitting it on a paging POST returns SUCCESS
   * with an EMPTY `data` — a silent failure.
   */
  linkage?: unknown;
  endpoint?: unknown;
  global?: Record<string, unknown>;
  container?: unknown;
  reload?: unknown;
};

/** A component plus the key it lives under in `data`. */
export type TaggedComponent = UltronComponent & { key: string };
