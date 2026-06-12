import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTableTools } from "./tools/table.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAttachmentTools } from "./tools/attachment.js";
import { registerAggregateTools } from "./tools/aggregate.js";
import { registerImportSetTools } from "./tools/importset.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerChangeTools } from "./tools/change.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerCmdbTools } from "./tools/cmdb.js";
import { registerScriptTools } from "./tools/scripts.js";
import { registerDocsTools } from "./tools/docs.js";
import { getRequestedPackages } from "./settings.js";
import { logger } from "./logging.js";

/** A registrable group of tools, tagged with the package it belongs to. */
interface ToolGroup {
  package: string;
  register: (server: McpServer) => void;
}

/**
 * Every gated tool group and its package. The admin group (credentials +
 * status) is intentionally not listed here — it is always registered below as
 * the server's own management surface, regardless of the active packages.
 */
const TOOL_GROUPS: ToolGroup[] = [
  { package: "table", register: registerTableTools },
  { package: "schema", register: registerMetaTools },
  { package: "aggregate", register: registerAggregateTools },
  { package: "attachment", register: registerAttachmentTools },
  { package: "importset", register: registerImportSetTools },
  { package: "batch", register: registerBatchTools },
  { package: "catalog", register: registerCatalogTools },
  { package: "change", register: registerChangeTools },
  { package: "knowledge", register: registerKnowledgeTools },
  { package: "cmdb", register: registerCmdbTools },
  { package: "scripts", register: registerScriptTools },
  { package: "docs", register: registerDocsTools },
];

/** Canonical set of packages, derived from the tool groups. */
export const ALL_PACKAGES: string[] = [
  ...new Set(TOOL_GROUPS.map((g) => g.package)),
];

/** The default package set when SN_TOOL_PACKAGES is unset or unusable. */
const CORE_PROFILE = ["table", "schema", "aggregate", "attachment"];

/**
 * Named profiles that expand to a set of packages. `core` is the default
 * profile loaded when SN_TOOL_PACKAGES is unset; `all` enables everything.
 */
const PROFILES: Record<string, string[]> = {
  core: CORE_PROFILE,
  all: ALL_PACKAGES,
};

/**
 * Resolve requested package/profile names into a concrete package set.
 * Unknown names are ignored (with a warning); an empty result falls back to
 * the `core` profile so the server always exposes a usable tool set.
 */
export function resolveEnabledPackages(requested: string[]): Set<string> {
  const enabled = new Set<string>();
  for (const name of requested) {
    const profile = PROFILES[name];
    if (profile) {
      for (const p of profile) enabled.add(p);
    } else if (ALL_PACKAGES.includes(name)) {
      enabled.add(name);
    } else {
      logger.warn("Unknown tool package ignored", { package: name });
    }
  }
  if (enabled.size === 0) {
    for (const p of CORE_PROFILE) enabled.add(p);
  }
  return enabled;
}

/**
 * Register the always-on admin tools plus every tool group whose package is
 * enabled by SN_TOOL_PACKAGES.
 */
export function registerAllTools(server: McpServer): void {
  const enabled = resolveEnabledPackages(getRequestedPackages());
  // Always available so the server can be inspected/configured even when a
  // narrow package set is active.
  registerAdminTools(server);
  for (const group of TOOL_GROUPS) {
    if (enabled.has(group.package)) group.register(server);
  }
  logger.info("Tools registered", { packages: [...enabled].sort() });
}
