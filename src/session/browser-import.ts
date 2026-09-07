import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_BROWSERS, type ImportBrowser } from "../config.js";
import type { Ctx } from "../context.js";
import { LoginError } from "../core/errors.js";
import { type Cookie, inSiteDomain, regionalFromJar, type SameSite } from "./jar.js";
import type { LoginResult } from "./login.js";

// Alternative to the browser login: reuse the session of a Chromium-based
// browser the user is ALREADY logged in with (Arc, Chrome, …). Chromium on
// macOS encrypts cookie values with AES-128-CBC using a key derived from a
// per-browser password kept in the Keychain ("<Browser> Safe Storage"); the
// user grants access once through the macOS dialog. Nothing is automated in
// the browser and no password is stored — only the resulting jar, encrypted
// like any other session.
//
// Caveat (documented for users): the session is then SHARED with that
// browser. If AliExpress rotates a cookie on one side, the other may expire —
// re-importing fixes it.

export const BROWSERS = IMPORT_BROWSERS;
export type BrowserId = ImportBrowser;

const LOCATIONS: Record<BrowserId, { label: string; dir: string; service: string }> = {
  arc: { label: "Arc", dir: "Arc/User Data", service: "Arc Safe Storage" },
  chrome: { label: "Google Chrome", dir: "Google/Chrome", service: "Chrome Safe Storage" },
  chromium: { label: "Chromium", dir: "Chromium", service: "Chromium Safe Storage" },
  brave: { label: "Brave", dir: "BraveSoftware/Brave-Browser", service: "Brave Safe Storage" },
  edge: { label: "Microsoft Edge", dir: "Microsoft Edge", service: "Microsoft Edge Safe Storage" },
};

const APP_SUPPORT = "Library/Application Support";
/** Used only when the browser's "Last Version" file is missing. */
const FALLBACK_CHROMIUM_VERSION = "152.0.0.0";
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export const browserLabel = (browser: BrowserId): string => LOCATIONS[browser].label;
export const keychainService = (browser: BrowserId): string => LOCATIONS[browser].service;
export const cookieDbPath = (browser: BrowserId, home = homedir()): string =>
  join(home, APP_SUPPORT, LOCATIONS[browser].dir, "Default", "Cookies");
export const lastVersionPath = (browser: BrowserId, home = homedir()): string =>
  join(home, APP_SUPPORT, LOCATIONS[browser].dir, "Last Version");

/** Chromium/macOS: PBKDF2-SHA1(password, "saltysalt", 1003 iterations, 16 bytes). */
export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * "v10" + AES-128-CBC with a 16-space IV. Cookie DB v24+ prepends
 * SHA256(host_key) to the plaintext; it is stripped only when it matches.
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer, hostKey: string): string {
  const version = encrypted.subarray(0, 3).toString("latin1");
  if (version !== "v10") {
    throw new LoginError(`Formato de cookie desconhecido ("${version}"): só o formato v10 do Chromium no macOS é suportado.`);
  }
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    throw new LoginError("Não foi possível decifrar os cookies do navegador: a chave lida do Keychain não confere.");
  }
  if (plain.length >= 32 && plain.subarray(0, 32).equals(createHash("sha256").update(hostKey).digest())) {
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

/** Chrome ≥ 101 sends a reduced UA: only the major version is real. */
export function userAgentFor(chromiumVersion: string): string {
  const major = chromiumVersion.split(".")[0] || FALLBACK_CHROMIUM_VERSION.split(".")[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const SAME_SITE: Record<number, SameSite | undefined> = { 0: "None", 1: "Lax", 2: "Strict" };

type CookieRow = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
};

/** Reads the cookies of `host` (and its subdomains) from a copy of the browser's database. */
export function readBrowserCookies(dbPath: string, key: Buffer, host: string): Cookie[] {
  if (!existsSync(dbPath)) {
    throw new LoginError(`Banco de cookies não encontrado em ${dbPath}. O navegador está instalado e já foi aberto alguma vez?`);
  }
  // The browser keeps the file open/locked: work on a copy (with WAL sidecars).
  const scratch = mkdtempSync(join(tmpdir(), "aliexpress-cookies-"));
  try {
    const copy = join(scratch, "Cookies");
    copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new Database(copy, { readonly: true });
    try {
      const rows = db
        .query(
          "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE host_key LIKE ?",
        )
        .all(`%${host}`) as CookieRow[];
      return rows
        .filter((row) => inSiteDomain(row.host_key, host))
        .map((row) => ({
          name: row.name,
          value:
            row.encrypted_value && row.encrypted_value.length > 0
              ? decryptCookieValue(Buffer.from(row.encrypted_value), key, row.host_key)
              : row.value,
          domain: row.host_key,
          path: row.path || "/",
          expires: row.expires_utc > 0 ? Math.floor(row.expires_utc / 1_000_000 - WINDOWS_EPOCH_OFFSET_SECONDS) : -1,
          httpOnly: row.is_httponly === 1,
          secure: row.is_secure === 1,
          sameSite: SAME_SITE[row.samesite],
        }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `security` pops the macOS dialog the first time; the user clicks "Permitir". */
export async function readKeychainPassword(service: string): Promise<string> {
  const proc = Bun.spawn(["security", "find-generic-password", "-w", "-s", service], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0 || out.trim() === "") {
    throw new LoginError(
      `Não consegui ler a chave "${service}" do Keychain. Clique em "Permitir" na janela do macOS e tente de novo.\nDetalhe: ${err.trim() || `exit ${code}`}`,
    );
  }
  return out.trim();
}

export type ImportOptions = {
  browser: BrowserId;
  /** Wipe the automation browser profile first: AliExpress then sees a brand-new device next to the fresh session. */
  fresh?: boolean;
  report?: (message: string) => void;
};
export type ImportDeps = {
  platform?: string;
  readKeychainPassword?: (service: string) => Promise<string>;
  dbPath?: string;
  lastVersionPath?: string;
};

export async function importFromBrowser(ctx: Ctx, opts: ImportOptions, deps: ImportDeps = {}): Promise<LoginResult> {
  const report = opts.report ?? ((message: string) => ctx.log.info(message));
  const label = browserLabel(opts.browser);
  if ((deps.platform ?? process.platform) !== "darwin") {
    throw new LoginError(
      "Importar cookies do navegador só funciona no macOS por enquanto (chave no Keychain). Use `aliexpress login` com o Chrome.",
    );
  }
  if (opts.fresh) rmSync(ctx.config.browserProfileDir, { recursive: true, force: true });
  const service = keychainService(opts.browser);
  report(`Lendo a chave "${service}" do Keychain (o macOS pode pedir permissão)…`);
  const password = await (deps.readKeychainPassword ?? readKeychainPassword)(service);
  const key = deriveKey(password);

  // `aliexpress.com` (no subdomain) so the LIKE picks up both `.aliexpress.com`
  // and the `acs.aliexpress.com` cookies the MTOP calls need.
  const host = new URL(ctx.config.siteBaseUrl).hostname.split(".").slice(-2).join(".");
  const cookies = readBrowserCookies(deps.dbPath ?? cookieDbPath(opts.browser), key, host);
  const regional = {
    ...regionalFromJar(cookies),
    ...(ctx.config.region ? { region: ctx.config.region } : {}),
    ...(ctx.config.locale ? { locale: ctx.config.locale } : {}),
    ...(ctx.config.currency ? { currency: ctx.config.currency } : {}),
  };
  if (!regional.memberId) {
    throw new LoginError(
      `O ${label} não está logado no AliExpress (o cookie aep_usuc_f não traz x_alimid). Entre em ${ctx.config.siteBaseUrl} no ${label} e tente de novo.`,
    );
  }

  const versionFile = deps.lastVersionPath ?? lastVersionPath(opts.browser);
  const chromiumVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : FALLBACK_CHROMIUM_VERSION;
  const savedAt = ctx.now();
  ctx.session.save({ version: 1, cookies, userAgent: userAgentFor(chromiumVersion), regional, savedAt });
  ctx.http.resetSession();
  report(`Sessão importada do ${label} (memberId ${regional.memberId}, ${cookies.length} cookies).`);

  return {
    cookieCount: cookies.length,
    httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
    memberId: regional.memberId,
    region: regional.region,
    locale: regional.locale,
    currency: regional.currency,
    savedAt: new Date(savedAt).toISOString(),
  };
}
