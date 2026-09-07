import type { Database } from "bun:sqlite";
import { openDatabase } from "../core/sqlite.js";

// Local cache. It exists because the history is immutable for finished orders,
// the API is slow and rate-limited, and every analytical question ("how much
// did I spend on cables") would otherwise cost a full crawl.
//
// Two rules the schema enforces:
//   - money is INTEGER CENTS, so SUM() is exact;
//   - the raw detail payload is kept, so improved parsers can be re-run over
//     the history with zero network (`sync --reparse`).

export const SCHEMA_VERSION = 1;

/** Ordered and append-only: a released migration is never edited. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS orders (
    order_id          TEXT PRIMARY KEY,
    order_date        TEXT,              -- YYYY-MM-DD, comparable as a string
    order_date_text   TEXT,              -- original localised text
    status            TEXT NOT NULL,
    status_text       TEXT,
    status_tab        TEXT,
    status_code       INTEGER,           -- global.orderStatus
    total_cents       INTEGER,
    currency          TEXT,
    store_name        TEXT,
    store_id          TEXT,
    payment_out_id    TEXT,
    payment_method    TEXT,
    item_count        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT,
    paid_at           TEXT,
    shipped_at        TEXT,
    finished_at       TEXT,
    address_json      TEXT,
    timeline_json     TEXT,
    is_final          INTEGER NOT NULL DEFAULT 0,
    detail_fetched_at TEXT,
    detail_error      TEXT,
    raw_detail        TEXT,              -- for offline reparse
    parser_version    INTEGER,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_lines (
    order_line_id TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    position      INTEGER NOT NULL DEFAULT 0,
    product_id    TEXT,
    title         TEXT,
    quantity      INTEGER NOT NULL DEFAULT 1,
    unit_cents    INTEGER,               -- per unit; line total = unit * quantity
    line_cents    INTEGER,
    currency      TEXT,
    sku_id        TEXT,
    sku_attrs     TEXT,                  -- JSON [{name, value}]
    image_url     TEXT,
    product_url   TEXT
  );

  CREATE TABLE IF NOT EXISTS order_price_lines (
    order_id     TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    key          TEXT NOT NULL,          -- subtotal | shipping | tax | …
    label        TEXT NOT NULL,          -- as AliExpress wrote it
    amount_cents INTEGER,
    PRIMARY KEY (order_id, position)
  );

  CREATE TABLE IF NOT EXISTS packages (
    order_id            TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    tracking_number     TEXT NOT NULL,
    origin_tracking_no  TEXT,
    carrier             TEXT,
    eta_text            TEXT,
    eta_start           TEXT,
    eta_end             TEXT,
    created_at          TEXT,
    delivered           INTEGER NOT NULL DEFAULT 0,
    payload_json        TEXT NOT NULL,   -- full timeline, normalised on read
    fetched_at          TEXT NOT NULL,
    PRIMARY KEY (order_id, tracking_number)
  );

  CREATE TABLE IF NOT EXISTS refunds (
    reverse_order_line_id TEXT PRIMARY KEY,
    reverse_order_id      TEXT,
    order_id              TEXT,
    order_line_id         TEXT,
    type                  TEXT,
    status                INTEGER,
    created_at            TEXT,
    updated_at            TEXT,
    store_name            TEXT,
    product_id            TEXT,
    title                 TEXT,
    count                 INTEGER NOT NULL DEFAULT 1,
    unit_cents            INTEGER,
    currency              TEXT,
    updated_row_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_date   ON orders(order_date DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_store  ON orders(store_name);
  CREATE INDEX IF NOT EXISTS idx_lines_order   ON order_lines(order_id);
  CREATE INDEX IF NOT EXISTS idx_lines_product ON order_lines(product_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

  -- FTS over the product titles. remove_diacritics 2 is what makes "cafe"
  -- find "Café" — the whole point for a Brazilian catalogue.
  -- ponytail: a plain (not contentless) fts5 table. A personal history is a few
  -- hundred rows, so the duplicated text is nothing and a full rebuild after a
  -- sync stays a two-statement affair. Switch to external content + triggers if
  -- this ever holds tens of thousands of lines.
  CREATE VIRTUAL TABLE IF NOT EXISTS order_lines_fts USING fts5(
    title,
    sku_attrs,
    store_name,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

/** Applies every migration not yet applied. Idempotent. */
export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;
  const current = row ? Number(row.value) : 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] as string);
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(version + 1),
      );
    })();
  }
}

export function openCache(path: string): Database {
  const db = openDatabase(path);
  migrate(db);
  return db;
}
