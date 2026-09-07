#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

// One command to get from this repository to a working setup on this machine:
// compile the binary, put it on the PATH, register the MCP server in Claude
// Code's USER scope (an absolute path, because MCP clients do not inherit the
// shell PATH), and install the Skill. Idempotent: run it again to update.
//
// Usage: bun run setup [--prefix=~/.local/bin] [--skip-build] [--dry-run]
//                      [--import-browser=arc|chrome|chromium|brave|edge]

const NAME = "aliexpress";
const ENV_PREFIX = "ALIEXPRESS";
const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const inline = args.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const expandHome = (path: string): string => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const PREFIX = expandHome(option("prefix") ?? join(homedir(), ".local", "bin"));
const BIN = join(PREFIX, NAME);
const CLAUDE_JSON = join(homedir(), ".claude.json");
const SKILL_DIR = join(homedir(), ".claude", "skills", `${NAME}-mcp`);
const IMPORT_BROWSERS = ["arc", "chrome", "chromium", "brave", "edge"];
const importBrowser = option("import-browser");
const dry = flag("dry-run");

const step = (message: string): void => console.error(`\n${message}`);
const ok = (message: string): void => console.error(`  ok  ${message}${dry ? " (dry-run)" : ""}`);

async function sh(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`falhou: ${command.join(" ")}`);
}

/**
 * Writes the server into `~/.claude.json` under the user scope and removes any
 * per-project entry with the same name: a project-scoped server shadows the
 * user one, which is the usual reason a fresh install seems not to work.
 */
function registerMcp(): void {
  const config = existsSync(CLAUDE_JSON)
    ? (JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<string, unknown>)
    : {};
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = importBrowser ? { [`${ENV_PREFIX}_IMPORT_BROWSER`]: importBrowser } : {};
  servers[NAME] = { type: "stdio", command: BIN, args: ["mcp"], env };
  config.mcpServers = servers;

  let shadowed = 0;
  const projects = config.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
  for (const project of Object.values(projects ?? {})) {
    if (project?.mcpServers && NAME in project.mcpServers) {
      delete project.mcpServers[NAME];
      shadowed += 1;
    }
  }

  if (!dry) writeFileSync(CLAUDE_JSON, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  ok(`mcpServers.${NAME} -> ${BIN} mcp`);
  if (shadowed > 0) ok(`${shadowed} entrada(s) por projeto removida(s)`);
}

async function main(): Promise<void> {
  console.error(`${NAME}-mcp ${pkg.version}: instalação`);
  if (importBrowser && !IMPORT_BROWSERS.includes(importBrowser)) {
    throw new Error(`--import-browser deve ser ${IMPORT_BROWSERS.join("|")}, veio "${importBrowser}"`);
  }

  step("1/4 compilando o binário");
  if (flag("skip-build")) {
    if (!existsSync(join(ROOT, NAME))) throw new Error("--skip-build sem binário compilado");
    ok("reaproveitado (--skip-build)");
  } else if (dry) {
    ok("bun run build:binary");
  } else {
    // `bun run build:binary`, not a command of its own: the compile flags live
    // in package.json only, so the installer cannot drift from them.
    await sh(["bun", "run", "build:binary"]);
    ok(`${NAME} compilado`);
  }

  step(`2/4 instalando em ${BIN}`);
  if (!dry) {
    mkdirSync(PREFIX, { recursive: true });
    copyFileSync(join(ROOT, NAME), BIN);
    chmodSync(BIN, 0o755);
  }
  ok(BIN);
  if (!(process.env.PATH ?? "").split(":").includes(PREFIX)) {
    console.error(`  !   ${PREFIX} não está no PATH; adicione ao seu shell: export PATH="${PREFIX}:$PATH"`);
  }

  step("3/4 registrando o servidor MCP no escopo de usuário");
  registerMcp();

  step("4/4 instalando a Skill");
  if (!dry) mkdirSync(SKILL_DIR, { recursive: true });
  for (const file of ["SKILL.md", join("docs", "TOOLS.md")]) {
    const source = join(ROOT, file);
    if (!existsSync(source)) continue;
    const target = join(SKILL_DIR, file.split("/").pop() as string);
    if (!dry) copyFileSync(source, target);
    ok(target);
  }

  step("verificando fora do repositório");
  if (dry) {
    ok("pulado");
    console.error("\nDry-run: nada foi alterado.");
    return;
  }
  const proc = Bun.spawn([BIN, "--version"], { cwd: homedir(), stdout: "pipe", stderr: "pipe" });
  const version = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error("o binário não respondeu --version");
  ok(`${NAME} --version -> ${version}`);

  console.error(`\nPronto. Agora rode:\n  ${NAME} login${importBrowser ? ` --from-browser ${importBrowser}` : ""}\n  ${NAME} sync`);
  console.error("Depois reinicie o Claude Code para ele enxergar o servidor MCP.");
}

await main();
