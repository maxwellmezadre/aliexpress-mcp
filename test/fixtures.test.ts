import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The repository is public and these fixtures come from a real account. This
// test is the standing guard: it fails if anything private, or anything that
// would let the graph rot, ever gets committed.

const DIR = join(import.meta.dir, "fixtures");
const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
const blob = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");

describe("committed fixtures", () => {
  test("the expected captures are all present", () => {
    expect(files.sort()).toEqual([
      "logistics-querydetail.json",
      "order-count.json",
      "order-detail.json",
      "order-list-init.json",
      "refund-list.json",
    ]);
  });

  test("carry no personal data", () => {
    expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // e-mail
    expect(blob).not.toMatch(/\b\d{5}-\d{3}\b(?<!00000-000)/); // Brazilian post code
    expect(blob).not.toMatch(/\b(?:BR\d{9}|[A-Z]{2}\d{9}BR)\b(?<!AA000000000BR)/); // tracking
    for (const marker of ["spm=", "JSESSIONID", "xman_", "havana", "sgcookie", "_m_h5_tk"]) {
      expect(blob).not.toContain(marker);
    }
  });

  test("use the placeholder identity everywhere", () => {
    const logistics = JSON.parse(
      readFileSync(join(DIR, "logistics-querydetail.json"), "utf8"),
    ) as { data: { module: { logisticsReceiverInfo: Record<string, string> } } };
    const receiver = logistics.data.module.logisticsReceiverInfo;
    expect(receiver.contactName).toBe("Comprador Exemplo");
    expect(receiver.address).toBe("Rua Exemplo, 123");
    expect(receiver.zipCode).toBe("00000-000");
  });

  test("never publish the opaque linkage blob", () => {
    const list = JSON.parse(readFileSync(join(DIR, "order-list-init.json"), "utf8")) as {
      data: { linkage: { signature: Record<string, unknown> } };
    };
    // It is signed and tied to the session; the stub keeps the shape only.
    expect(list.data.linkage.signature).toEqual({ stub: true });
  });
});
