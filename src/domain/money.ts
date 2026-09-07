// Money is kept as INTEGER CENTS everywhere inside the project; the conversion
// to a decimal number happens only at the tool boundary. Summing floats over a
// purchase history drifts, and SQLite has no decimal type.
//
// AliExpress hands money over in three different shapes, and they disagree:
//
//   formatPriceInfo  "R$132,74|132|74"   ← exact, locale-proof. ALWAYS prefer.
//   display strings  "R$126,59"          ← Ultron, comma decimal (pt-BR config)
//   display strings  "R$61.25"           ← the reverse/refund API, DOT decimal
//   cent             6125                ← the refund API only; already cents
//
// The two display shapes were observed in the same account on the same day, so
// the parser cannot assume a locale — it decides from the string itself.

export type Money = {
  /** Integer cents. */
  cents: number;
  currency: string;
  /** The original text, kept for auditing when a parse looks surprising. */
  text: string;
};

/**
 * `"R$132,74|132|74"` → `13274`. The pipe format carries the integer part and
 * the cents as separate fields, so it needs no locale knowledge at all.
 */
export function parsePricePipe(value: string | undefined | null): number | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length < 3) return null;
  const whole = parts[1]?.replace(/\D/g, "") ?? "";
  const fraction = parts[2]?.replace(/\D/g, "") ?? "";
  if (whole === "" && fraction === "") return null;
  const negative = (parts[0] ?? "").trim().startsWith("-");
  const cents = Number(whole || "0") * 100 + Number((fraction || "0").padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

/** Text that means "no charge" rather than a missing value. */
const FREE_PATTERNS = [/free shipping/i, /frete gr[áa]tis/i, /^free$/i, /^gr[áa]tis$/i];

/**
 * `"-R$1.234,56"` → `-123456`. Returns null when there is no amount at all, so
 * a caller can tell "zero" from "could not parse" — a missing value must never
 * silently become 0 in a spending report.
 */
export function parseMoneyText(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  if (text === "") return null;
  if (FREE_PATTERNS.some((pattern) => pattern.test(text))) return 0;

  const negative = /^-|^\(.*\)$/.test(text) || text.includes("-R$") || text.startsWith("−");
  const digits = text.replace(/[^\d.,]/g, "");
  if (digits === "") return null;

  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators: the LAST one is the decimal point ("1.234,56" / "1,234.56").
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = Math.max(lastDot, lastComma);
    // A lone separator is decimal only when exactly two digits follow it;
    // otherwise it is grouping ("1.234" is one thousand, not 1.23).
    if (digits.length - only - 1 === 2) decimalAt = only;
  }

  const whole = (decimalAt >= 0 ? digits.slice(0, decimalAt) : digits).replace(/\D/g, "");
  const fraction = decimalAt >= 0 ? digits.slice(decimalAt + 1).replace(/\D/g, "") : "";
  if (whole === "" && fraction === "") return null;
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

/** The pipe format when present, the display string otherwise. */
export function parseAmount(
  formatPriceInfo: string | undefined | null,
  text: string | undefined | null,
): number | null {
  return parsePricePipe(formatPriceInfo) ?? parseMoneyText(text);
}

export function money(cents: number | null, currency: string, text: string): Money | null {
  return cents === null ? null : { cents, currency, text };
}

/** Cents → the decimal number tools expose. Rounded, never accumulated. */
export const toDecimal = (cents: number): number => Math.round(cents) / 100;
