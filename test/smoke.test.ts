import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

// Harness sanity: the package stays ESM and the version stays semver, so the
// static import in bin.ts keeps working inside the compiled binary.
test("package is esm with a semver version", () => {
  expect(pkg.type).toBe("module");
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("both binaries are declared", () => {
  expect(Object.keys(pkg.bin).sort()).toEqual(["aliexpress", "aliexpress-mcp"]);
});
