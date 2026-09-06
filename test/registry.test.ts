import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { ToolInputError, runTool } from "../src/tools/define.js";
import { activeTools, allTools, toolByName } from "../src/tools/registry.js";
import { createMemorySessionStore } from "../src/session/store.js";
import { scriptedFetch, silentLogger } from "./helpers.js";

// Invariants that hold for every tool, now and after each new one is added.

describe("registry invariants", () => {
  test("names are unique and snake_case without a vendor prefix", () => {
    const names = allTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name.startsWith("aliexpress_")).toBe(false);
    }
  });

  test("every description is long enough to steer a model", () => {
    for (const tool of allTools) expect(tool.description.length).toBeGreaterThan(20);
  });

  test("every input serialises to a JSON Schema object", () => {
    for (const tool of allTools) {
      const schema = JSON.parse(JSON.stringify(tool.input)) as { type?: string };
      expect(schema.type).toBe("object");
    }
  });

  test("toolByName finds what the CLI asks for", () => {
    expect(toolByName("auth_status")?.name).toBe("auth_status");
    expect(toolByName("nope")).toBeUndefined();
  });
});

describe("read-only mode", () => {
  test("registers exactly the readOnly subset", () => {
    const readable = allTools.filter((tool) => tool.readOnly);
    expect(activeTools({ readOnly: true })).toEqual(readable);
    expect(activeTools({ readOnly: false })).toEqual(allTools);
  });
});

describe("runTool validation", () => {
  const ctx = () =>
    createContext(loadConfig({ ALIEXPRESS_CONFIG_DIR: "/nonexistent/aliexpress-mcp-test" }), {
      fetch: scriptedFetch([]),
      session: createMemorySessionStore(null),
      log: silentLogger(),
    });

  test("rejects arguments that do not match the schema", async () => {
    const tool = toolByName("auth_status");
    await expect(runTool(tool as never, { verify: "sim" }, ctx())).rejects.toThrow(ToolInputError);
  });

  test("lists every problem with its path", async () => {
    try {
      await runTool(toolByName("raw_get") as never, { api: 1 }, ctx());
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as ToolInputError).problems.join(" ")).toContain("/api");
    }
  });
});
