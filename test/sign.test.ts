import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { APP_KEY, JSV, mtopSign, signedCall } from "../src/mtop/sign.js";

describe("mtopSign", () => {
  test("md5 is the real thing (known vector)", () => {
    expect(createHash("md5").update("abc").digest("hex")).toBe(
      "900150983cd24fb0d6963f7d28e17f72",
    );
  });

  test("signs token&t&appKey&data in that exact order", () => {
    const data = '{"clientPlatform":"pc"}';
    const expected = createHash("md5")
      .update(`tok&1757000000000&${APP_KEY}&${data}`)
      .digest("hex");
    expect(mtopSign("tok", "1757000000000", data)).toBe(expected);
  });

  test("an empty token is a valid signature — that is how the server issues one", () => {
    expect(mtopSign("", "1", "{}")).toHaveLength(32);
  });

  test("any change to the payload changes the signature", () => {
    const a = mtopSign("tok", "1", '{"a":1,"b":2}');
    const b = mtopSign("tok", "1", '{"b":2,"a":1}');
    expect(a).not.toBe(b);
  });
});

describe("signedCall", () => {
  const base = {
    acsBaseUrl: "https://acs.acme.test",
    api: "mtop.aliexpress.trade.buyer.order.count",
    v: "1.0",
    token: "tok0123456789",
    t: "1757000000000",
    data: '{"clientPlatform":"pc","shipToCountry":"BR"}',
  };

  test("GET carries the payload in the query and no body", () => {
    const call = signedCall({ ...base, method: "GET" });
    const url = new URL(call.url);
    expect(url.pathname).toBe(`/h5/${base.api}/1.0/`);
    expect(url.searchParams.get("data")).toBe(base.data);
    expect(call.body).toBeUndefined();
  });

  test("POST carries the payload form-encoded in the body and not in the query", () => {
    const call = signedCall({ ...base, method: "POST" });
    expect(new URL(call.url).searchParams.get("data")).toBeNull();
    expect(call.body).toBe(`data=${encodeURIComponent(base.data)}`);
  });

  test("the signed string and the transported string are byte-identical", () => {
    for (const method of ["GET", "POST"] as const) {
      const call = signedCall({ ...base, method });
      const transported =
        method === "GET"
          ? (new URL(call.url).searchParams.get("data") as string)
          : decodeURIComponent((call.body as string).slice("data=".length));
      expect(transported).toBe(base.data);
      expect(call.sign).toBe(mtopSign(base.token, base.t, transported));
    }
  });

  test("declares the constants the API requires", () => {
    const url = new URL(signedCall({ ...base, method: "GET" }).url);
    expect(url.searchParams.get("appKey")).toBe("12574478");
    expect(url.searchParams.get("jsv")).toBe(JSV);
    expect(url.searchParams.get("type")).toBe("originaljson");
    expect(url.searchParams.get("dataType")).toBe("json");
    expect(url.searchParams.get("ecode")).toBe("1");
    expect(url.searchParams.get("needLogin")).toBe("true");
    expect(url.searchParams.get("t")).toBe(base.t);
  });
});
