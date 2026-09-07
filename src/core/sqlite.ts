import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// bun:sqlite wiring shared by the cache. Kept apart from the schema so the
// schema file is only SQL and queries.

/**
 * Opens (and creates) a database with the pragmas the CLI and the MCP server
 * both need — they share the file, so WAL and a busy timeout are not optional.
 * The file is 0600: it holds a purchase history.
 */
export function openDatabase(path: string): Database {
  if (path === ":memory:") {
    const memory = new Database(":memory:");
    memory.exec("PRAGMA foreign_keys = ON;");
    return memory;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Whatever the user's umask is, this file is not world-readable.
  const previous = process.umask(0o077);
  let db: Database;
  try {
    db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
  } finally {
    process.umask(previous);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
  }
  return db;
}

/** Runs `fn` in a transaction that takes the write lock up front. */
export function inTx<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** What bun:sqlite accepts as a bound parameter. */
export type Binding = string | number | bigint | boolean | null | Uint8Array;

/** Fluent WHERE builder: only `?` parameters, never string interpolation. */
export class Where {
  readonly clauses: string[] = [];
  readonly values: Binding[] = [];

  add(clause: string, ...values: Binding[]): this {
    this.clauses.push(clause);
    this.values.push(...values);
    return this;
  }

  /**
   * Adds the clause only when `value` is present. The bindings are typed loosely
   * on purpose: they are only ever reached when `value` is present, so the
   * callers can pass the same optional they are testing.
   */
  maybe(value: unknown, clause: string, ...values: Array<Binding | undefined>): this {
    if (value === undefined || value === null || value === "") return this;
    return this.add(clause, ...(values as Binding[]));
  }

  sql(): string {
    return this.clauses.length > 0 ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

/** Escapes the LIKE wildcards so a `%` typed by the user is a literal `%`. */
export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);
