import { describe, expect, test } from "bun:test";
import { dayFromEpochMs, isoFromEpochMs, parseLocalisedDate } from "../src/domain/dates.js";

describe("parseLocalisedDate", () => {
  test("reads the en_US form the account answers with", () => {
    expect(parseLocalisedDate("Jul 15, 2026")).toBe("2026-07-15");
    expect(parseLocalisedDate("Sep 1, 2026")).toBe("2026-09-01");
    expect(parseLocalisedDate("Apr 8, 2026")).toBe("2026-04-08");
  });

  test("reads the pt_BR form", () => {
    expect(parseLocalisedDate("24 nov, 2023")).toBe("2023-11-24");
    expect(parseLocalisedDate("3 de julho de 2024")).toBe("2024-07-03");
    expect(parseLocalisedDate("1 set. 2026")).toBe("2026-09-01");
  });

  test("distinguishes the months that differ between the two languages", () => {
    expect(parseLocalisedDate("5 fev, 2024")).toBe("2024-02-05"); // pt fev = feb
    expect(parseLocalisedDate("Feb 5, 2024")).toBe("2024-02-05");
    expect(parseLocalisedDate("5 ago, 2024")).toBe("2024-08-05"); // pt ago = aug
    expect(parseLocalisedDate("5 dez, 2024")).toBe("2024-12-05"); // pt dez = dec
    expect(parseLocalisedDate("5 mai, 2024")).toBe("2024-05-05"); // pt mai = may
  });

  test("accepts the ISO form the refund endpoint answers with", () => {
    expect(parseLocalisedDate("2022-03-23 21:19:58")).toBe("2022-03-23");
  });

  test("returns null instead of inventing a date", () => {
    expect(parseLocalisedDate("qualquer coisa")).toBeNull();
    expect(parseLocalisedDate("Xxx 15, 2026")).toBeNull();
    expect(parseLocalisedDate("")).toBeNull();
    expect(parseLocalisedDate(undefined)).toBeNull();
  });
});

describe("epoch helpers", () => {
  test("converts epoch milliseconds", () => {
    expect(isoFromEpochMs(1785274783000)).toBe("2026-07-28T21:39:43.000Z");
    expect(dayFromEpochMs(1785274783000)).toBe("2026-07-28");
  });

  test("treats 0 and negatives as absent, not as 1970", () => {
    expect(isoFromEpochMs(0)).toBeNull();
    expect(isoFromEpochMs(-1)).toBeNull();
    expect(isoFromEpochMs(undefined)).toBeNull();
    expect(dayFromEpochMs(null)).toBeNull();
  });
});
