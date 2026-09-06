import { ParseError } from "../core/errors.js";
import type { TaggedComponent, UltronResponse } from "./types.js";

// Reading the Ultron graph. Two rules the whole file exists to enforce:
//
//  1. Select components by `tag`, never by the literal key. Keys look like
//     `pc_om_list_order_8212379857492017` or `pc_om_list_body_109702` — the
//     numeric suffix is an id in AliExpress's CMS and can change on their side.
//  2. Order comes from `hierarchy.structure`, never from `Object.keys(data)`.
//     Object key order is arbitrary here, and iterating it silently scrambles
//     the order of the user's purchases.

/** Depth-first walk of the component graph, in display order. */
export function orderedKeys(response: UltronResponse): string[] {
  const structure = response.hierarchy?.structure;
  const root = response.hierarchy?.root;
  if (!structure || !root) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return; // the graph is a tree in practice; do not trust it
    seen.add(key);
    out.push(key);
    for (const child of structure[key] ?? []) visit(child);
  };
  visit(root);
  return out;
}

/** Every component with `tag`, in display order. */
export function byTag(response: UltronResponse, tag: string): TaggedComponent[] {
  const data = response.data ?? {};
  const ordered = orderedKeys(response).filter((key) => data[key]?.tag === tag);
  // A component present in `data` but missing from `structure` would otherwise
  // vanish; keep it, after the ordered ones.
  const extra = Object.keys(data).filter((key) => data[key]?.tag === tag && !ordered.includes(key));
  return [...ordered, ...extra].map((key) => ({ ...(data[key] as TaggedComponent), key }));
}

/** The first component with `tag`, or undefined. */
export function firstByTag(response: UltronResponse, tag: string): TaggedComponent | undefined {
  return byTag(response, tag)[0];
}

/** The key of the first component with `tag`. Throws when the layout changed. */
export function keyOfTag(response: UltronResponse, tag: string): string {
  const found = firstByTag(response, tag);
  if (!found) {
    throw new ParseError(`O AliExpress não devolveu o componente "${tag}" que a página usa.`);
  }
  return found.key;
}

/** `fields` of the first component with `tag`, or an empty object. */
export function fieldsOf(response: UltronResponse, tag: string): Record<string, unknown> {
  return firstByTag(response, tag)?.fields ?? {};
}

export const LIST_BODY_TAG = "pc_om_list_body";
export const LIST_HEADER_ACTION_TAG = "pc_om_list_header_action";
export const LIST_ORDER_TAG = "pc_om_list_order";

/** Order components of a list page, in the order the user sees them. */
export function listOrders(response: UltronResponse): TaggedComponent[] {
  return byTag(response, LIST_ORDER_TAG);
}

/** Whether the list body says another page exists. */
export function hasMore(response: UltronResponse): boolean {
  return fieldsOf(response, LIST_BODY_TAG).hasMore === true;
}

export function pageIndexOf(response: UltronResponse): number | null {
  const value = fieldsOf(response, LIST_BODY_TAG).pageIndex;
  return typeof value === "number" ? value : null;
}

/**
 * The numeric, locale-independent order status (`8` = completed). Preferred
 * over the translated `statusText`.
 */
export function orderStatusCode(response: UltronResponse): number | null {
  const value = response.global?.orderStatus;
  return typeof value === "number" ? value : null;
}

export type PagePayloadOptions = {
  pageIndex: number;
  /** Fields merged into the header component: statusTab, timeOption, searchOption, searchInput. */
  headerFields?: Record<string, unknown>;
};

/**
 * Builds the `params` of the paging POST from the PREVIOUS page's response.
 *
 * The server does not take a page number: the client resends the component
 * state with `pageIndex` bumped, plus `linkage`, `hierarchy` and `endpoint`
 * verbatim. `linkage` rotates on every response, so each page must be built
 * from the page right before it.
 */
export function buildPagePayload(
  previous: UltronResponse,
  options: PagePayloadOptions,
): Record<string, string> {
  if (previous.linkage === undefined || previous.linkage === null) {
    // Sending the POST without it answers SUCCESS with an empty `data`, which
    // reads exactly like "no more orders". Fail loudly instead.
    throw new ParseError(
      "A resposta anterior do AliExpress não trouxe `linkage`; paginar sem ele devolve uma página vazia.",
    );
  }
  const bodyKey = keyOfTag(previous, LIST_BODY_TAG);
  const headerKey = keyOfTag(previous, LIST_HEADER_ACTION_TAG);

  const body = structuredClone(previous.data[bodyKey]);
  const header = structuredClone(previous.data[headerKey]);
  if (!body || !header) throw new ParseError("Componentes de paginação ausentes na resposta.");

  body.fields = { ...body.fields, pageIndex: options.pageIndex };
  header.fields = { ...header.fields, ...(options.headerFields ?? {}) };

  return {
    data: JSON.stringify({ [bodyKey]: body, [headerKey]: header }),
    linkage: JSON.stringify(previous.linkage),
    hierarchy: JSON.stringify(previous.hierarchy),
    endpoint: JSON.stringify(previous.endpoint ?? {}),
    // Which component triggered the action.
    operator: bodyKey,
  };
}

/**
 * Guards a paging response: SUCCESS with no order component means the request
 * was malformed (almost always a missing `linkage`), not that the history ended.
 */
export function assertPageUsable(response: UltronResponse, pageIndex: number): TaggedComponent[] {
  const orders = listOrders(response);
  if (orders.length === 0 && Object.keys(response.data ?? {}).length === 0) {
    throw new ParseError(
      `A página ${pageIndex} de pedidos voltou vazia (sem componentes). Isso costuma ser \`linkage\` ausente ou inválido.`,
    );
  }
  return orders;
}
