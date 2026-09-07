#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

// One command to get from this repository to a working setup on this machine:
// compile the binary, put it on the PATH, register the MCP server in Claude
// Code's USER scope (an absolute path, because MCP clients do not inherit the
// shell PATH), and install the Skill.

const ROOT = join(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const prefixArg = process.argv.find((value) => value.startsWith("--prefix="));
const PREFIX = prefixArg ? prefixArg.slice("--prefix=".length) : join(homedir(), ".local", "bin");
const BIN = join(PREFIX, "aliexpress");
const CLAUDE_JSON = join(homedir(), ".claude.json");
const SKILL_DIR = join(homedir(), ".claude", "skills", "aliexpress-mcp");

const step = (message: string): void => console.error(`\n${message}`);
const ok = (message: string): void => console.error(`  ok  ${message}`);

async function sh(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`falhou: ${command.join(" ")}`);
}

async function main(): Promise<void> {
  console.error(`aliexpress-mcp ${pkg.version} — instalação`);

  step("1/4 compilando o binário");
  if (args.has("--skip-build")) {
    ok("pulado (--skip-build)");
  } else {
    await sh(["bun", "run", "build:binary"]);
    ok("aliexpress compilado");
  }

  step(`2/4 instalando em ${BIN}`);
  if (args.has("--dry-run")) {
    ok(`${BIN} (dry-run: nada copiado)`);
  } else {
    mkdirSync(PREFIX, { recursive: true });
    copyFileSync(join(ROOT, "aliexpress"), BIN);
    ok(BIN);
  }
  if (!(process.env.PATH ?? "").split(":").includes(PREFIX)) {
    console.error(`  !   ${PREFIX} não está no PATH; adicione ao seu shell`);
  }

  step("3/4 registrando o servidor MCP no escopo de usuário");
  registerMcp();

  step("4/4 instalando a Skill");
  if (!args.has("--dry-run")) mkdirSync(SKILL_DIR, { recursive: true });
  for (const file of ["SKILL.md", join("docs", "TOOLS.md")]) {
    const source = join(ROOT, file);
    if (!existsSync(source)) continue;
    const target = join(SKILL_DIR, file.split("/").pop() as string);
    if (!args.has("--dry-run")) copyFileSync(source, target);
    ok(`${target}${args.has("--dry-run") ? " (dry-run)" : ""}`);
  }

  step("verificando fora do repositório");
  if (args.has("--dry-run")) {
    console.error("  ok  pulado (dry-run)");
    console.error("\nDry-run: nada foi alterado.");
    return;
  }
  const proc = Bun.spawn([BIN, "--version"], { cwd: homedir(), stdout: "pipe", stderr: "pipe" });
  const version = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error("o binário não respondeu --version");
  ok(`aliexpress --version → ${version}`);

  console.error("\nPronto. Agora rode:\n  aliexpress login\n  aliexpress sync");
  console.error("Depois reinicie o Claude Code para ele enxergar o servidor MCP.");
}

/**
 * Writes the server into `~/.claude.json` under the user scope, and removes any
 * per-project entry with the same name — a project-scoped server shadows the
 * user one, which is the usual reason a fresh install seems not to work.
 */
function registerMcp(): void {
  const config = existsSync(CLAUDE_JSON)
    ? (JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<string, unknown>)
    : {};
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.aliexpress = { type: "stdio", command: BIN, args: ["mcp"], env: {} };
  config.mcpServers = servers;

  let shadowed = 0;
  const projects = config.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
  for (const project of Object.values(projects ?? {})) {
    if (project?.mcpServers && "aliexpress" in project.mcpServers) {
      delete project.mcpServers.aliexpress;
      shadowed += 1;
    }
  }

  if (!args.has("--dry-run")) {
    writeFileSync(CLAUDE_JSON, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  ok(`mcpServers.aliexpress → ${BIN} mcp${args.has("--dry-run") ? " (dry-run)" : ""}`);
  if (shadowed > 0) ok(`${shadowed} entrada(s) por projeto removida(s)`);
}

await main();
