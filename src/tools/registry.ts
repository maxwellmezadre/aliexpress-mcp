import type { Config } from "../config.js";
import { spendingSummary } from "./analytics.js";
import { authStatus } from "./auth.js";
import type { ToolDef } from "./define.js";
import { doctor } from "./doctor.js";
import { exportData } from "./export.js";
import { login } from "./login.js";
import { getOrder, listOrders, searchProducts } from "./orders.js";
import { rawGet } from "./raw.js";
import { listRefunds } from "./refunds.js";
import { sync } from "./sync.js";
import { trackOrder } from "./tracking.js";

// Flat registry shared by the MCP server and the CLI: the two surfaces cannot
// drift, because they resolve tools from this same array. The order here is the
// order clients see.
export const allTools: ToolDef[] = [
  // Session and diagnostics
  authStatus,
  login,
  doctor,
  // Cache
  sync,
  // Orders
  listOrders,
  getOrder,
  searchProducts,
  // Logistics and returns
  trackOrder,
  listRefunds,
  // Analytics
  spendingSummary,
  exportData,
  // Escape hatch
  rawGet,
];

/**
 * Read-only mode: the tools that persist something (session, cache, files) are
 * simply not registered. A structural guarantee, not a runtime check.
 */
export function activeTools(config: Pick<Config, "readOnly">): ToolDef[] {
  return config.readOnly ? allTools.filter((tool) => tool.readOnly) : allTools;
}

export function toolByName(name: string): ToolDef | undefined {
  return allTools.find((tool) => tool.name === name);
}
