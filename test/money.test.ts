import { describe, expect, test } from "bun:test";
import { parseAmount, parseMoneyText, parsePricePipe, toDecimal } from "../src/domain/money.js";

describe("parsePricePipe", () => {
  test("reads the exact cents from the pipe format", () => {
    expect(parsePricePipe("R$132,74|132|74")).toBe(13274);
    expect(parsePricePipe("R$61.25|61|25")).toBe(6125);
    expect(parsePricePipe("R$1.234,05|1234|05")).toBe(123405);
  });

  test("handles whole amounts and a negative first field", () => {
    expect(parsePricePipe("R$5,00|5|00")).toBe(500);
    expect(parsePricePipe("-R$30,00|30|00")).toBe(-3000);
  });

  test("returns null when the format is not the pipe format", () => {
    expect(parsePricePipe("R$132,74")).toBeNull();
    expect(parsePricePipe(undefined)).toBeNull();
    expect(parsePricePipe("")).toBeNull();
  });
});

describe("parseMoneyText", () => {
  test("reads the comma-decimal form the Ultron endpoints use", () => {
    expect(parseMoneyText("R$126,59")).toBe(12659);
    expect(parseMoneyText("-R$5,66")).toBe(-566);
    expect(parseMoneyText("R$1.234,56")).toBe(123456);
  });

  test("reads the dot-decimal form the refund endpoint uses for the SAME account", () => {
    expect(parseMoneyText("R$61.25")).toBe(6125);
    expect(parseMoneyText("$1,234.56")).toBe(123456);
  });

  test("treats a lone separator with three digits as grouping, not decimals", () => {
    expect(parseMoneyText("R$1.234")).toBe(123400);
    expect(parseMoneyText("R$1,234")).toBe(123400);
  });

  test("free shipping is zero, in both languages", () => {
    expect(parseMoneyText("Free shipping")).toBe(0);
    expect(parseMoneyText("Frete grátis")).toBe(0);
  });

  test("an amount with no decimals still works", () => {
    expect(parseMoneyText("R$5")).toBe(500);
  });

  test("returns null when there is no amount — never a silent zero", () => {
    expect(parseMoneyText("")).toBeNull();
    expect(parseMoneyText(null)).toBeNull();
    expect(parseMoneyText("Pagamento a Prazo")).toBeNull();
  });
});

describe("parseAmount", () => {
  test("prefers the pipe format and falls back to the display string", () => {
    expect(parseAmount("R$132,74|132|74", "R$999,99")).toBe(13274);
    expect(parseAmount(undefined, "R$126,59")).toBe(12659);
    expect(parseAmount(undefined, undefined)).toBeNull();
  });
});

describe("toDecimal", () => {
  test("converts cents at the boundary without drifting", () => {
    expect(toDecimal(13274)).toBe(132.74);
    expect(toDecimal(-566)).toBe(-5.66);
    expect(toDecimal(0)).toBe(0);
    // The whole point of integer cents: this sum is exact.
    const cents = [1010, 1010, 1010];
    expect(toDecimal(cents.reduce((a, b) => a + b, 0))).toBe(30.3);
  });
});

describe("the real breakdown", () => {
  test("the fixture's rows add up to its total, to the cent", () => {
    const rows = ["R$126,59", "Free shipping", "-R$5,66", "-R$10,80", "R$22,61"];
    const sum = rows.reduce((total, row) => total + (parseMoneyText(row) as number), 0);
    expect(sum).toBe(parsePricePipe("R$132,74|132|74") as number);
  });
});
