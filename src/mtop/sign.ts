import { createHash } from "node:crypto";

// MTOP request signature. Verified against the live API and against the
// official H5 SDK (`.../cosmos/<version>/pc/mtop.js`).
//
//   sign = md5(`${token}&${t}&${appKey}&${data}`)
//
// The classic trap is signing one JSON string and sending another: the payload
// must be serialised ONCE and the very same string used for both. `signedCall`
// below is the only place that builds a call, so it cannot drift.

/** AliExpress H5 app key. Constant, confirmed at runtime. */
export const APP_KEY = "12574478";
export const JSV = "2.5.1";

export function mtopSign(token: string, t: string, data: string): string {
  return createHash("md5").update(`${token}&${t}&${APP_KEY}&${data}`).digest("hex");
}

export type SignedCall = {
  url: string;
  /** Serialised payload — identical to what was signed. */
  data: string;
  /** Form body for POST; undefined for GET (the payload rides in the query). */
  body: string | undefined;
  t: string;
  sign: string;
};

/**
 * Builds one signed MTOP call. `data` must already be the serialised payload so
 * the caller can re-sign the exact same string with a fresh token without
 * risking a different key order.
 */
export function signedCall(params: {
  acsBaseUrl: string;
  api: string;
  v: string;
  method: "GET" | "POST";
  token: string;
  t: string;
  data: string;
}): SignedCall {
  const { acsBaseUrl, api, v, method, token, t, data } = params;
  const sign = mtopSign(token, t, data);
  const query = new URLSearchParams({
    jsv: JSV,
    appKey: APP_KEY,
    t,
    sign,
    api,
    v,
    // `originaljson` gives plain JSON; the page itself uses `originaljsonp`.
    type: "originaljson",
    dataType: "json",
    timeout: "15000",
    ecode: "1",
    needLogin: "true",
  });
  if (method === "GET") query.set("data", data);
  return {
    url: `${acsBaseUrl}/h5/${api}/${v}/?${query.toString()}`,
    data,
    body: method === "POST" ? `data=${encodeURIComponent(data)}` : undefined,
    t,
    sign,
  };
}
