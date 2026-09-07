import { describe, expect, test } from "bun:test";
import {
  type Cookie,
  cookieHeader,
  hostMatches,
  inSiteDomain,
  mergeSetCookie,
  mtopToken,
  parseAepUsucF,
  regionalFromJar,
} from "../src/session/jar.js";

const NOW_MS = 1_757_000_000_000; // 2026-09-04T14:13:20Z
const NOW_S = Math.floor(NOW_MS / 1000);

function cookie(partial: Partial<Cookie> & Pick<Cookie, "name" | "value">): Cookie {
  return {
    domain: ".aliexpress.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    ...partial,
  };
}

describe("hostMatches", () => {
  test("matches the domain itself and its subdomains, with or without the leading dot", () => {
    expect(hostMatches("acs.aliexpress.com", ".aliexpress.com")).toBe(true);
    expect(hostMatches("aliexpress.com", "aliexpress.com")).toBe(true);
    expect(hostMatches("www.aliexpress.com", "aliexpress.com")).toBe(true);
  });

  test("does not match a different registrable domain", () => {
    expect(hostMatches("aliexpress.us", ".aliexpress.com")).toBe(false);
    expect(hostMatches("evilaliexpress.com", "aliexpress.com")).toBe(false);
  });
});

describe("cookieHeader", () => {
  const url = new URL("https://acs.aliexpress.com/h5/mtop.x/1.0/");

  test("keeps only cookies that apply to the request", () => {
    const jar = [
      cookie({ name: "keep", value: "1" }),
      cookie({ name: "other_domain", value: "2", domain: ".aliexpress.us" }),
      cookie({ name: "other_path", value: "3", path: "/nope" }),
      cookie({ name: "expired", value: "4", expires: NOW_S - 1 }),
      cookie({ name: "alive", value: "5", expires: NOW_S + 60 }),
    ];
    expect(cookieHeader(jar, url, NOW_MS)).toBe("keep=1; alive=5");
  });

  test("holds secure cookies back from a plain-http request", () => {
    const jar = [cookie({ name: "s", value: "1" }), cookie({ name: "p", value: "2", secure: false })];
    expect(cookieHeader(jar, new URL("http://acs.aliexpress.com/x"), NOW_MS)).toBe("p=2");
  });
});

describe("mergeSetCookie", () => {
  test("inserts a new cookie and reports the change", () => {
    const result = mergeSetCookie([], ["_m_h5_tk=abc_1700000000000; Path=/; Secure"], "acs.aliexpress.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]?.name).toBe("_m_h5_tk");
    expect(result.cookies[0]?.domain).toBe("acs.aliexpress.com");
  });

  test("replaces the mtop token on renewal — a stale token gets the request rejected", () => {
    const jar = [cookie({ name: "_m_h5_tk", value: "old_1", domain: "acs.aliexpress.com" })];
    const result = mergeSetCookie(jar, ["_m_h5_tk=new_2; Path=/"], "acs.aliexpress.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(mtopToken(result.cookies)).toBe("new");
  });

  test("reports changed=false when the response repeats the same cookie", () => {
    const jar = [cookie({ name: "a", value: "1", domain: "acs.aliexpress.com", secure: false })];
    const result = mergeSetCookie(jar, ["a=1; Path=/"], "acs.aliexpress.com", NOW_MS);
    expect(result.changed).toBe(false);
  });

  test("removes a cookie killed by Max-Age=0", () => {
    const jar = [cookie({ name: "gone", value: "1", domain: "acs.aliexpress.com" })];
    const result = mergeSetCookie(jar, ["gone=; Path=/; Max-Age=0"], "acs.aliexpress.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.cookies).toHaveLength(0);
  });

  test("skips a malformed line instead of dropping the whole response", () => {
    const result = mergeSetCookie([], ["=nonsense", "ok=1; Path=/"], "acs.aliexpress.com", NOW_MS);
    expect(result.skipped).toBe(1);
    expect(result.cookies).toHaveLength(1);
  });
});

describe("mtopToken", () => {
  test("takes only the part before the first underscore", () => {
    const jar = [cookie({ name: "_m_h5_tk", value: "abc123def456_1757000000000" })];
    expect(mtopToken(jar)).toBe("abc123def456");
  });

  test("is an empty string when the cookie is absent — the server then issues one", () => {
    expect(mtopToken([])).toBe("");
  });
});

describe("parseAepUsucF", () => {
  test("reads region, locale and currency from the real cookie shape", () => {
    const raw = encodeURIComponent(
      "isfm=y&site=bra&c_tp=BRL&x_alimid=1234567890&region=BR&b_locale=pt_BR&ae_u_p_s=2",
    );
    expect(parseAepUsucF(raw)).toEqual({
      region: "BR",
      locale: "pt_BR",
      currency: "BRL",
      memberId: "1234567890",
    });
  });

  test("falls back to US/en_US/USD when the cookie is missing", () => {
    expect(parseAepUsucF(undefined).region).toBe("US");
    expect(parseAepUsucF("").locale).toBe("en_US");
  });

  test("maps the seller-side CN site to US (it has no buyer order list)", () => {
    expect(parseAepUsucF("region=CN&b_locale=zh_CN").region).toBe("US");
  });

  test("reads it straight off a jar", () => {
    const jar = [cookie({ name: "aep_usuc_f", value: "region=BR&b_locale=pt_BR&c_tp=BRL" })];
    expect(regionalFromJar(jar).currency).toBe("BRL");
  });
});

describe("inSiteDomain", () => {
  test("keeps every cookie of the registrable domain, subdomains included", () => {
    for (const domain of [
      "aliexpress.com",
      ".aliexpress.com",
      "www.aliexpress.com",
      "acs.aliexpress.com",
      ".pt.aliexpress.com",
    ]) {
      expect(inSiteDomain(domain, "aliexpress.com")).toBe(true);
    }
  });

  test("rejects a different registrable domain", () => {
    expect(inSiteDomain("aliexpress.us", "aliexpress.com")).toBe(false);
    expect(inSiteDomain("evilaliexpress.com", "aliexpress.com")).toBe(false);
  });

  test("is NOT hostMatches with the arguments swapped by accident", () => {
    // hostMatches asks "would this host send this cookie", which drops the
    // host-only cookies of a subdomain when filtering a whole jar.
    expect(hostMatches("aliexpress.com", "www.aliexpress.com")).toBe(false);
    expect(inSiteDomain("www.aliexpress.com", "aliexpress.com")).toBe(true);
  });
});
