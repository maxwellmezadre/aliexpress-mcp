// AliExpress only ever hands over LOCALISED date text ("Jul 15, 2026" in
// en_US, "24 nov, 2023" in pt_BR) — there is no ISO field anywhere in the
// order APIs. Everything is normalised to `YYYY-MM-DD` here, and the original
// text is always kept next to it: when a parse fails the value is `null`, never
// an invented date.

const MONTHS: Record<string, number> = {};
const register = (names: readonly string[]): void => {
  names.forEach((name, index) => {
    MONTHS[name] = index + 1;
  });
};
// en_US
register(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);
// pt_BR (differs in feb/apr/may/aug/sep/dec)
register(["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]);

const pad = (value: number): string => String(value).padStart(2, "0");

/** Strips accents and the trailing dot some locales add ("set." → "set"). */
const normaliseMonth = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.$/, "")
    .slice(0, 3);

/**
 * `"Jul 15, 2026"` / `"24 nov, 2023"` / `"2022-03-23 21:19:58"` → `"2026-07-15"`.
 * Returns null for anything it cannot read with certainty.
 */
export function parseLocalisedDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = value.trim();
  if (text === "") return null;

  // Already ISO (the refund API answers "2022-03-23 21:19:58").
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "Jul 15, 2026" — month first.
  const monthFirst = /^([\p{L}]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/u.exec(text);
  if (monthFirst) {
    const month = MONTHS[normaliseMonth(monthFirst[1] as string)];
    if (month) return `${monthFirst[3]}-${pad(month)}-${pad(Number(monthFirst[2]))}`;
  }

  // "24 nov, 2023" — day first.
  const dayFirst = /^(\d{1,2})\s+de\s+([\p{L}]{3,})\.?,?\s+(?:de\s+)?(\d{4})$|^(\d{1,2})\s+([\p{L}]{3,})\.?,?\s+(\d{4})$/u.exec(
    text,
  );
  if (dayFirst) {
    const day = dayFirst[1] ?? dayFirst[4];
    const monthName = dayFirst[2] ?? dayFirst[5];
    const year = dayFirst[3] ?? dayFirst[6];
    const month = MONTHS[normaliseMonth(monthName as string)];
    if (month) return `${year}-${pad(month)}-${pad(Number(day))}`;
  }

  return null;
}

/** Epoch milliseconds → ISO 8601. `0` and negatives mean "absent", not 1970. */
export function isoFromEpochMs(value: number | undefined | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

/** Epoch milliseconds → `YYYY-MM-DD` in UTC. */
export function dayFromEpochMs(value: number | undefined | null): string | null {
  return isoFromEpochMs(value)?.slice(0, 10) ?? null;
}
