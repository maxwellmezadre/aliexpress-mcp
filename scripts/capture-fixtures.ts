#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { timeZoneParam } from "../src/mtop/client.js";

// Captures RAW responses from the real account into task/captures/ (gitignored).
// They become the golden corpus for test/local and, after
// scripts/anonymize-fixture.ts, the committed fixtures.
//
// Dry-run by default: nothing is written until --write. Read the summary first.

const OUT_DIR = join(import.meta.dir, "..", "task", "captures");

type Capture = { name: string; api: string; ok: boolean; bytes: number; payload: unknown };

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const ctx = createContext(loadConfig());
  const timeZone = timeZoneParam();
  const captures: Capture[] = [];

  const capture = async (
    name: string,
    api: string,
    data: Record<string, unknown>,
    method: "GET" | "POST" = "GET",
  ): Promise<unknown> => {
    try {
      const response = await ctx.mtop.request({ api, method, data });
      const payload = response as unknown;
      captures.push({
        name,
        api,
        ok: true,
        bytes: JSON.stringify(payload).length,
        payload,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captures.push({ name, api, ok: false, bytes: 0, payload: { error: message } });
      console.error(`  ! ${name}: ${message}`);
      return null;
    }
  };

  console.error("Capturando (uma requisição por vez, no ritmo normal do cliente)…");

  await capture("order-count", "mtop.aliexpress.trade.buyer.order.count", {
    clientPlatform: "pc",
  });

  const list = (await capture("order-list-init", "mtop.aliexpress.trade.buyer.order.list", {
    statusTab: "all",
    renderType: "init",
    clientPlatform: "pc",
    timeZone,
  })) as { data?: { data?: Record<string, { tag: string; fields: Record<string, unknown> }> } } | null;

  // First order id of the first page: enough for a detail, a tracking and a
  // refund capture without walking the whole history.
  const firstOrderId = firstOrderIdOf(list);
  if (firstOrderId) {
    await capture("order-detail", "mtop.aliexpress.trade.buyer.order.detail", {
      tradeOrderId: firstOrderId,
      clientPlatform: "pc",
      timeZone,
      channel: "tracking",
    });
    await capture("logistics-querydetail", "mtop.ae.ld.querydetail", {
      tradeOrderId: firstOrderId,
      tradeOrderLineId: "",
      terminalType: "PC",
      needPageDisplayInfo: true,
      timeZone,
    });
  } else {
    console.error("  ! nenhum pedido na página 1; detalhe e rastreio não capturados");
  }

  await capture(
    "refund-list",
    "mtop.aliexpress.buyer.reverse.queryreverseorderpagelistforbuyer",
    { pageNo: 1, size: 10, sortOrder: "DESC", reverseStatus: 1, shopName: "", tradeOrderId: "" },
    "POST",
  );

  console.error("\nResumo:");
  for (const item of captures) {
    console.error(`  ${item.ok ? "ok " : "ERR"} ${item.name.padEnd(24)} ${item.bytes} bytes`);
  }
  console.error(`\n${ctx.mtop.calls()} requisições.`);

  if (!write) {
    console.error("\nDry-run. Rode de novo com --write para gravar em task/captures/.");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  for (const item of captures) {
    writeFileSync(join(OUT_DIR, `${item.name}.json`), JSON.stringify(item.payload, null, 2), {
      mode: 0o600,
    });
  }
  writeFileSync(
    join(OUT_DIR, "index.json"),
    JSON.stringify(
      captures.map(({ name, api, ok, bytes }) => ({ name, api, ok, bytes })),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error(`\nGravado em ${OUT_DIR} (0600, gitignored).`);
  console.error("Próximo passo: bun run scripts/anonymize-fixture.ts");
}

function firstOrderIdOf(
  list: { data?: { data?: Record<string, { tag: string; fields: Record<string, unknown> }> } } | null,
): string | null {
  const data = list?.data?.data;
  if (!data) return null;
  for (const component of Object.values(data)) {
    if (component.tag === "pc_om_list_order" && typeof component.fields.orderId === "string") {
      return component.fields.orderId;
    }
  }
  return null;
}

await main();
