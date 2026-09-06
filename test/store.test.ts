import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../src/core/errors.js";
import type { Cookie } from "../src/session/jar.js";
import {
  createMemorySessionStore,
  createSessionStore,
  type SessionData,
} from "../src/session/store.js";

const root = mkdtempSync(join(tmpdir(), "ae-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function paths() {
  const configDir = join(root, `case-${++counter}`);
  return {
    configDir,
    sessionPath: join(configDir, "session.enc"),
    keyPath: join(configDir, "session.key"),
    sessionKey: undefined as string | undefined,
  };
}

const cookie: Cookie = {
  name: "acs_usuc_t",
  value: "super-secret-session-value",
  domain: ".aliexpress.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
};

function session(): SessionData {
  return {
    version: 1,
    cookies: [cookie],
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/152",
    regional: { region: "BR", locale: "pt_BR", currency: "BRL", memberId: "42" },
    savedAt: 1_757_000_000_000,
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("createSessionStore", () => {
  test("returns null before the first login", () => {
    expect(createSessionStore(paths()).load()).toBeNull();
  });

  test("round trips the jar, the user agent and the regional settings", () => {
    const store = createSessionStore(paths());
    store.save(session());
    expect(store.load()).toEqual(session());
  });

  test("writes both files 0600 and leaves no .tmp behind", () => {
    const config = paths();
    const store = createSessionStore(config);
    store.save(session());
    expect(mode(config.sessionPath)).toBe(0o600);
    expect(mode(config.keyPath)).toBe(0o600);
    expect(readdirSync(config.configDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  test("the file on disk is ciphertext — the cookie value never appears in it", () => {
    const config = paths();
    createSessionStore(config).save(session());
    const blob = Bun.file(config.sessionPath);
    expect(Bun.readableStreamToText(blob.stream())).resolves.not.toContain(cookie.value);
  });

  test("the env key wins over the key file and no key file is created", () => {
    const config = { ...paths(), sessionKey: randomBytes(32).toString("base64") };
    const store = createSessionStore(config);
    store.save(session());
    expect(existsSync(config.keyPath)).toBe(false);
    expect(store.load()?.regional.region).toBe("BR");
  });

  test("a wrong key fails with an actionable SessionError and never leaks the plaintext", () => {
    const config = paths();
    createSessionStore(config).save(session());
    const other = createSessionStore({ ...config, sessionKey: randomBytes(32).toString("base64") });
    try {
      other.load();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as Error).message).toMatch(/aliexpress login/);
      expect((error as Error).message).not.toContain(cookie.value);
    }
  });

  test("a corrupted blob is reported, not parsed", () => {
    const config = paths();
    createSessionStore(config).save(session());
    writeFileSync(config.sessionPath, Buffer.from([9, 9, 9]));
    expect(() => createSessionStore(config).load()).toThrow(/corrompido|formato desconhecido/);
  });

  test("a key file of the wrong size is rejected instead of producing garbage", () => {
    const config = paths();
    createSessionStore(config).save(session());
    writeFileSync(config.keyPath, "dG9vc2hvcnQ=\n");
    expect(() => createSessionStore(config).load()).toThrow(/32 bytes/);
  });

  test("mtimeMs moves on save — the signal that the user re-logged in", async () => {
    const config = paths();
    const store = createSessionStore(config);
    expect(store.mtimeMs()).toBeNull();
    store.save(session());
    const first = store.mtimeMs();
    await Bun.sleep(10);
    store.save({ ...session(), savedAt: 2 });
    expect(store.mtimeMs()).toBeGreaterThanOrEqual(first as number);
  });

  test("clear removes the session but keeps the key for the next login", () => {
    const config = paths();
    const store = createSessionStore(config);
    store.save(session());
    store.clear();
    expect(existsSync(config.sessionPath)).toBe(false);
    expect(existsSync(config.keyPath)).toBe(true);
    expect(store.peekSecrets()).toEqual([]);
  });

  test("peekSecrets exposes the cookie values so the logger can redact them", () => {
    const store = createSessionStore(paths());
    store.save(session());
    expect(store.peekSecrets()).toEqual([cookie.value]);
  });
});

describe("createMemorySessionStore", () => {
  test("honours the same contract with a counter as mtime", () => {
    const store = createMemorySessionStore(null);
    expect(store.load()).toBeNull();
    expect(store.mtimeMs()).toBeNull();
    store.save(session());
    expect(store.load()?.userAgent).toContain("Chrome");
    expect(store.mtimeMs()).toBe(1);
  });
});
