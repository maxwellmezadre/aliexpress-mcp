import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type Config, SESSION_KEY_BYTES } from "../config.js";
import { LOGIN_HINT, SessionError } from "../core/errors.js";
import type { Cookie, RegionalSettings } from "./jar.js";

// The cookie jar IS the account (HttpOnly session cookies included), so it is
// encrypted at rest with AES-256-GCM and written 0600. Key: ALIEXPRESS_SESSION_KEY
// wins; otherwise a random key lives next to the file (0600) so the tool
// works with zero configuration. File layout, all binary:
//   [0] format version (1) | [1..12] IV | [13..28] GCM tag | [29..] ciphertext

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

const CookieSchema = Type.Object({
  name: Type.String(),
  value: Type.String(),
  domain: Type.String(),
  path: Type.String(),
  expires: Type.Number(),
  httpOnly: Type.Boolean(),
  secure: Type.Boolean(),
  sameSite: Type.Optional(
    Type.Union([Type.Literal("Strict"), Type.Literal("Lax"), Type.Literal("None")]),
  ),
});

const RegionalSchema = Type.Object({
  region: Type.String(),
  locale: Type.String(),
  currency: Type.String(),
  memberId: Type.Union([Type.String(), Type.Null()]),
});

const SessionSchema = Type.Object({
  version: Type.Literal(1),
  cookies: Type.Array(CookieSchema),
  userAgent: Type.String(),
  /**
   * Derived from `aep_usuc_f` at login. Persisted rather than re-parsed on every
   * request so a cookie rotation that drops it does not silently switch the
   * account to `US/en_US/USD` and change every label that comes back.
   */
  regional: RegionalSchema,
  /** Unix ms of the last save (login or Set-Cookie renewal). */
  savedAt: Type.Number(),
});

export type SessionData = {
  version: 1;
  cookies: Cookie[];
  userAgent: string;
  regional: RegionalSettings;
  savedAt: number;
};

export type SessionStore = {
  /** `null` before the first login. Throws {@link SessionError} when unreadable. */
  load(): SessionData | null;
  save(data: SessionData): void;
  /** Removes the session file; the key file stays so a re-login reuses it. */
  clear(): void;
  /** Modification time of the session file, or null; the "user re-logged in" signal. */
  mtimeMs(): number | null;
  /** Cookie values of the last loaded/saved jar — feeds log redaction. */
  peekSecrets(): readonly string[];
  readonly paths: { sessionPath: string; keyPath: string };
};

export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < HEADER_BYTES || blob[0] !== FORMAT_VERSION) {
    throw new SessionError(`session.enc corrompido ou em formato desconhecido. ${LOGIN_HINT}`);
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = blob.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SessionError(
      `Não foi possível decifrar session.enc: a chave mudou (ALIEXPRESS_SESSION_KEY ou session.key). ${LOGIN_HINT}`,
    );
  }
}

type KeySource = Pick<Config, "sessionKey" | "keyPath">;

/**
 * Key precedence: env → key file → (only when saving) a freshly generated one.
 * Returns null when nothing exists and creation was not requested.
 */
export function resolveKey(source: KeySource, createIfMissing: boolean): Buffer | null {
  if (source.sessionKey) return Buffer.from(source.sessionKey, "base64");
  if (existsSync(source.keyPath)) {
    const key = Buffer.from(readFileSync(source.keyPath, "utf8").trim(), "base64");
    if (key.length !== SESSION_KEY_BYTES) {
      throw new SessionError(
        `${source.keyPath} inválida: esperado base64 de ${SESSION_KEY_BYTES} bytes. Apague o arquivo e rode \`aliexpress login\`.`,
      );
    }
    return key;
  }
  if (!createIfMissing) return null;
  const key = randomBytes(SESSION_KEY_BYTES);
  mkdirSync(dirname(source.keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(source.keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(source.keyPath, 0o600); // `mode` is ignored when the file already exists
  return key;
}

export function createSessionStore(
  config: Pick<Config, "configDir" | "sessionPath" | "keyPath" | "sessionKey">,
): SessionStore {
  let secrets: readonly string[] = [];
  const remember = (data: SessionData) => {
    secrets = data.cookies.map((cookie) => cookie.value);
  };

  return {
    paths: { sessionPath: config.sessionPath, keyPath: config.keyPath },

    load() {
      if (!existsSync(config.sessionPath)) return null;
      const key = resolveKey(config, false);
      if (!key) {
        throw new SessionError(
          `${config.sessionPath} existe, mas não há chave para decifrá-lo (ALIEXPRESS_SESSION_KEY ou ${config.keyPath}). ${LOGIN_HINT}`,
        );
      }
      const plaintext = decrypt(key, readFileSync(config.sessionPath));
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new SessionError(`session.enc decifrado, mas com conteúdo inválido. ${LOGIN_HINT}`);
      }
      if (!Value.Check(SessionSchema, parsed)) {
        throw new SessionError(`session.enc em versão não suportada. ${LOGIN_HINT}`);
      }
      remember(parsed);
      return parsed;
    },

    save(data) {
      mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
      const key = resolveKey(config, true) as Buffer;
      // Write-then-rename: the MCP server may persist a Set-Cookie renewal
      // while `aliexpress login` writes a brand-new jar; readers never see a
      // half-written file.
      const temp = `${config.sessionPath}.tmp`;
      writeFileSync(temp, encrypt(key, Buffer.from(JSON.stringify(data))), { mode: 0o600 });
      renameSync(temp, config.sessionPath);
      chmodSync(config.sessionPath, 0o600);
      remember(data);
    },

    clear() {
      if (existsSync(config.sessionPath)) unlinkSync(config.sessionPath);
      secrets = [];
    },

    mtimeMs() {
      try {
        return statSync(config.sessionPath).mtimeMs;
      } catch {
        return null;
      }
    },

    peekSecrets: () => secrets,
  };
}

/** In-memory store for tests: same contract, mtime is a counter bumped per save. */
export function createMemorySessionStore(
  initial: SessionData | null = null,
): SessionStore & { data: SessionData | null } {
  let tick = initial ? 1 : 0;
  let mtime: number | null = initial ? tick : null;
  const store = {
    data: initial,
    paths: { sessionPath: "memory://session.enc", keyPath: "memory://session.key" },
    load: () => store.data,
    save(data: SessionData) {
      store.data = data;
      mtime = ++tick;
    },
    clear() {
      store.data = null;
      mtime = null;
    },
    mtimeMs: () => mtime,
    peekSecrets: () => store.data?.cookies.map((cookie) => cookie.value) ?? [],
  };
  return store;
}
