import { describe, expect, test } from "bun:test";
import {
  cleanStatusText,
  isFinalStatus,
  resolveStatus,
  statusFromText,
} from "../src/domain/status.js";

describe("cleanStatusText", () => {
  test("drops the trailing space AliExpress ships in pt_BR", () => {
    expect(cleanStatusText("Concluído ")).toBe("Concluído");
    expect(cleanStatusText("  Awaiting  delivery ")).toBe("Awaiting delivery");
    expect(cleanStatusText(undefined)).toBe("");
  });
});

describe("statusFromText", () => {
  test("maps the labels the account really answers with (en_US)", () => {
    expect(statusFromText("Completed")).toBe("completed");
    expect(statusFromText("Awaiting delivery")).toBe("shipped");
  });

  test("maps the pt_BR labels too, trailing space included", () => {
    expect(statusFromText("Concluído ")).toBe("completed");
    expect(statusFromText("Aguardando a entrega")).toBe("shipped");
    expect(statusFromText("A ser pago")).toBe("unpaid");
    expect(statusFromText("Processando")).toBe("processing");
    // "Processado" is the shipped tab, not "processing" — the false friend.
    expect(statusFromText("Processado")).toBe("shipped");
  });

  test("an unknown label is unknown, never a guess", () => {
    expect(statusFromText("Alguma coisa nova")).toBe("unknown");
    expect(statusFromText("")).toBe("unknown");
  });
});

describe("resolveStatus", () => {
  test("the listing tab wins: it is the only source that cannot be mistranslated", () => {
    expect(resolveStatus({ tab: "shipped", text: "Completed", code: 8 })).toBe("shipped");
    expect(resolveStatus({ tab: "unpaid" })).toBe("unpaid");
  });

  test("falls back to the text when the tab is unknown or `all`", () => {
    expect(resolveStatus({ tab: "all", text: "Completed" })).toBe("completed");
    expect(resolveStatus({ text: "Awaiting delivery" })).toBe("shipped");
  });

  test("falls back to the numeric code last", () => {
    expect(resolveStatus({ text: "Etwas Neues", code: 8 })).toBe("completed");
    // Observed on a completed order that had a partial refund.
    expect(resolveStatus({ text: "", code: 9 })).toBe("completed");
    // Unmapped code: still unknown rather than invented.
    expect(resolveStatus({ code: 42 })).toBe("unknown");
    expect(resolveStatus({})).toBe("unknown");
  });
});

describe("isFinalStatus", () => {
  test("only completed and cancelled never change again", () => {
    expect(isFinalStatus("completed")).toBe(true);
    expect(isFinalStatus("cancelled")).toBe(true);
    expect(isFinalStatus("shipped")).toBe(false);
    expect(isFinalStatus("unknown")).toBe(false);
  });
});
