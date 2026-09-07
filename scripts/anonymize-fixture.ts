#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Turns the raw captures in task/captures/ into the fixtures committed under
// test/fixtures/. The repository is public, so this is the only path by which
// real account data may become a test.
//
// Design rules:
//  - DETERMINISTIC (salted hash): the same id always maps to the same fake id,
//    so joins between list / detail / logistics / refunds still work and the
//    parsers can be tested on relations, not just shapes.
//  - MONEY IS NEVER TOUCHED: only digit runs of 9+ are remapped, and no amount
//    is that long. The financial identities in the fixtures stay true.
//  - LEAK GUARD: the script fails if any known-private value survives.

const ROOT = join(import.meta.dir, "..");
const CAPTURES = join(ROOT, "task", "captures");
const OUT = join(ROOT, "test", "fixtures");
const SALT_FILE = join(ROOT, "task", "anonymize.salt");

/** Field names whose STRING value is replaced wholesale. */
const REPLACEMENTS: Record<string, string> = {
  contactName: "Comprador Exemplo",
  fullPhoneNo: "+55 11999999999",
  phoneNumber: "11999999999",
  detailAddress: "Rua Exemplo, 123",
  detailAddress2: "Bairro Exemplo",
  address: "Rua Exemplo, 123",
  address2: "Bairro Exemplo",
  postCode: "00000-000",
  zipCode: "00000-000",
  regionAddress: "Cidade Exemplo, Estado Exemplo, Brazil",
  city: "Cidade Exemplo",
  province: "Estado Exemplo",
  mailNo: "AA000000000BR",
  originMailNo: "LP00000000000000",
  receiverInfoRichText: "<span>Comprador Exemplo</span>",
};

/** Field names dropped entirely: bulky boilerplate or opaque account blobs. */
const DROPPED = new Set([
  "i18nMap",
  "pageResources",
  "contentText",
  "utParams",
  "exposeInfo",
  "orderLineExposeInfoList",
  "features",
  "surveyInfo",
  "logisticsEquityList",
  "podInfoDTO",
  "latestNodeResourceInfoDTO",
  "nodeDescRichTextList",
  "buyer",
  // Carrier free text: the courier writes the city, the signer's name and a
  // support phone number into it.
  "note",
]);

/** Field names holding a URL whose query string identifies the account. */
const URL_FIELDS = new Set([
  "connectUrl",
  "sellerConnectUrl",
  "snapshotUrl",
  "tradeSnapshotUrl",
  "orderDetailUrl",
  "itemDetailUrl",
  "storePageUrl",
  "storeUrl",
  "itemImgUrl",
  "itemPic",
  "itemPicUrl",
  "shopIcon",
  "href",
  "icon",
  "nodeIcon",
]);

const WORDS = [
  "Alfa", "Bravo", "Cabo", "Delta", "Eco", "Fenix", "Gama", "Hidra", "Indigo", "Jade",
  "Kilo", "Lima", "Micro", "Nano", "Omega", "Pixel", "Quartzo", "Rubi", "Sigma", "Tango",
  "Ultra", "Vega", "Watt", "Xenon", "Yuca", "Zeta", "Neo", "Prisma", "Orbita", "Vetor",
];

function loadSalt(): string {
  if (existsSync(SALT_FILE)) return readFileSync(SALT_FILE, "utf8").trim();
  const salt = randomBytes(16).toString("hex");
  mkdirSync(join(ROOT, "task"), { recursive: true, mode: 0o700 });
  writeFileSync(SALT_FILE, `${salt}\n`, { mode: 0o600 });
  return salt;
}

const salt = loadSalt();
const digest = (value: string): string => createHash("sha256").update(`${salt}${value}`).digest("hex");

/** Collects every original value the leak guard must never find in the output. */
const secrets = new Set<string>();
/** Place names harvested from the tracking timeline, masked everywhere else. */
const places = new Set<string>();

/**
 * Remaps a digit run of 9+ digits, preserving length and the first 4 digits.
 * Amounts and quantities are shorter, so they are never touched; ids keep their
 * relations because the map is a pure function of the value.
 */
function fakeDigits(value: string): string {
  const hashed = digest(value).replace(/\D/g, "").padEnd(value.length + 4, "7");
  return value.slice(0, 4) + hashed.slice(0, value.length - 4);
}

const idCache = new Map<string, string>();
function remapIds(text: string): string {
  return text.replace(/\d{9,}/g, (match) => {
    let mapped = idCache.get(match);
    if (!mapped) {
      mapped = fakeDigits(match);
      idCache.set(match, mapped);
      secrets.add(match);
    }
    return mapped;
  });
}

const wordCache = new Map<string, string>();
function fakeWord(word: string): string {
  let mapped = wordCache.get(word.toLowerCase());
  if (!mapped) {
    const index = Number.parseInt(digest(word.toLowerCase()).slice(0, 8), 16) % WORDS.length;
    mapped = WORDS[index] as string;
    wordCache.set(word.toLowerCase(), mapped);
  }
  // Keep the shape: ALL CAPS stays all caps, lower stays lower.
  if (word === word.toUpperCase()) return mapped.toUpperCase();
  if (word === word.toLowerCase()) return mapped.toLowerCase();
  return mapped;
}

/** Rewrites free text word by word, leaving punctuation, digits and units alone. */
function fakeText(text: string): string {
  return text.replace(/[\p{L}]{3,}/gu, (word) => fakeWord(word));
}

/** `//www.aliexpress.com/store/1105289621?spm=…` → same path, no query. */
function scrubUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  return remapIds(withoutQuery);
}

/** `"Parobé,RS, Tue | Jul. 28 06:19"` → `"Tue | Jul. 28 06:19"`: the city is PII. */
function scrubTimeText(text: string): string {
  const marker = text.indexOf(", ");
  const pipe = text.indexOf("|");
  if (marker > 0 && pipe > marker) {
    const place = text.slice(0, marker);
    secrets.add(place);
    for (const part of place.split(",")) if (part.length >= 4) places.add(part);
    return text.slice(marker + 2);
  }
  return text;
}

/**
 * The courier writes the delivery city into free text. Every place already seen
 * in a `timeText`/`detailedLocation` is masked wherever it shows up again.
 */
function scrubKnownPlaces(text: string): string {
  let out = text;
  for (const place of places) out = out.split(place).join("Cidade Exemplo");
  return out;
}

type Json = unknown;

function walk(node: Json, key = ""): Json {
  if (Array.isArray(node)) return node.map((item) => walk(item, key));
  if (node !== null && typeof node === "object") {
    const out: Record<string, Json> = {};
    for (const [childKey, value] of Object.entries(node as Record<string, Json>)) {
      if (DROPPED.has(childKey)) continue;
      // Keys carry ids too: `pc_om_list_order_8212379857492017`. They must be
      // remapped with the SAME map as `hierarchy.structure`, or the graph the
      // parser walks stops resolving.
      out[remapIds(childKey)] = walk(value, childKey);
    }
    return out;
  }
  if (typeof node === "string") {
    if (key in REPLACEMENTS) {
      if (node.trim() !== "") secrets.add(node);
      return REPLACEMENTS[key] as string;
    }
    if (key === "timeText") return scrubTimeText(node);
    if (key === "detailedLocation") {
      secrets.add(node);
      for (const part of node.split(",")) if (part.length >= 4) places.add(part);
      return "Cidade Exemplo,UF";
    }
    if (key === "trackingDetailDesc") return scrubKnownPlaces(node);
    if (URL_FIELDS.has(key)) return scrubUrl(node);
    if (key === "storeName" || key === "sellerName" || key === "shopName") {
      secrets.add(node);
      return `${fakeWord(node.split(/\s+/)[0] ?? "Loja")} Store`;
    }
    if (key === "itemTitle" || key === "title" && node.length > 40) {
      secrets.add(node);
      return remapIds(fakeText(node));
    }
    return remapIds(node);
  }
  if (typeof node === "number" && node > 99_999_999) {
    // Numeric ids (tradeOrderId comes as a number in the detail).
    const mapped = Number(remapIds(String(node)));
    if (mapped !== node) secrets.add(String(node));
    return mapped;
  }
  return node;
}

/** `linkage` is an opaque signed blob tied to the session; never publish it. */
function stubLinkage(payload: Json): Json {
  const root = payload as Record<string, Json>;
  const data = root.data as Record<string, Json> | undefined;
  if (data && "linkage" in data) {
    data.linkage = { common: {}, input: [], request: [], signature: { stub: true } };
  }
  return root;
}

function main(): void {
  if (!existsSync(CAPTURES)) {
    console.error(`Sem capturas em ${CAPTURES}. Rode antes: bun run scripts/capture-fixtures.ts --write`);
    process.exit(1);
  }
  const write = process.argv.includes("--write");
  mkdirSync(OUT, { recursive: true });

  const files = readdirSync(CAPTURES).filter(
    (name) => name.endsWith(".json") && name !== "index.json",
  );
  const results: Array<{ name: string; bytes: number; text: string }> = [];

  // Two passes on purpose: every file is anonymised first, so the leak guard
  // then checks EVERY output against the secrets harvested from ALL of them.
  // A city that only appears in the tracking capture must not survive in the
  // order list either.
  for (const file of files) {
    const raw = readFileSync(join(CAPTURES, file), "utf8");
    const anonymized = stubLinkage(walk(JSON.parse(raw)));
    const text = `${JSON.stringify(anonymized, null, 2)}\n`;
    results.push({ name: file, bytes: text.length, text });
  }

  for (const item of results) {
    const leaked = [...secrets].filter(
      (secret) => secret.length >= 4 && item.text.includes(secret),
    );
    if (leaked.length > 0) {
      console.error(`LEAK em ${item.name}: ${leaked.length} valor(es) originais sobreviveram.`);
      console.error(`  primeiro: ${leaked[0]?.slice(0, 6)}… (${leaked[0]?.length} chars)`);
      process.exit(1);
    }
  }

  if (write) for (const item of results) writeFileSync(join(OUT, item.name), item.text);

  for (const item of results) console.error(`  ok ${item.name.padEnd(26)} ${item.bytes} bytes`);
  console.error(`\n${idCache.size} ids remapeados, ${wordCache.size} palavras, ${secrets.size} valores no leak guard.`);
  console.error(write ? `\nGravado em ${OUT}.` : "\nDry-run. Rode com --write para gravar.");
}

main();
