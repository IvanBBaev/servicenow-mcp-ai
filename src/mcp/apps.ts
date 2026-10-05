import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { readBool } from "../core/settings-manifest.js";
import { SERVER_VERSION } from "../core/identity.js";
import type { AnyToolSpec } from "./define.js";
import { APP_VIEW_IDS, viewHtml, type AppViewId } from "./apps-views.js";

/**
 * N-50 — MCP Apps (SEP-1865, spec 2026-01-26). Under SN_MCP_APPS=1 the
 * server registers four `ui://servicenow-mcp/<view>` HTML resources and links
 * the tools whose result they can draw through `_meta.ui.resourceUri`; a host
 * that supports the extension renders the view next to the call and pushes
 * the tool result into it. Tool results themselves never change.
 *
 * The link is only published to a client that advertises the extension
 * (`capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes`), as the
 * spec asks. Off — the default — nothing here runs: tools/list, resources and
 * results are byte-identical to a server without this module.
 */

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APPS_MIME = "text/html;profile=mcp-app";

/** Whether SN_MCP_APPS is on (read per server build, like the other flags). */
export function mcpAppsEnabled(): boolean {
  return readBool("SN_MCP_APPS");
}

export function appViewUri(view: AppViewId): string {
  return `ui://servicenow-mcp/${view}`;
}

const VIEW_INFO: Record<AppViewId, { title: string; description: string }> = {
  "plan-diff": {
    title: "Write plan diff",
    description:
      "A write tool's plan preview: before/after per field, plan token.",
  },
  mermaid: {
    title: "Mermaid diagram",
    description: "A generated Mermaid diagram: edges, entities and source.",
  },
  flow: {
    title: "Flow explainer",
    description: "explain_flow: trigger, nested steps, activities, lanes.",
  },
  "uib-tree": {
    title: "UI Builder page tree",
    description:
      "explain_ui_experience: routes → screens → macroponent composition.",
  },
};

/** The Mermaid generators (their `mermaid` field, or a file reference). */
const MERMAID_TOOLS = new Set<string>([
  "servicenow_generate_er_diagram",
  "servicenow_generate_table_flow",
  "servicenow_trace_table_event",
  "servicenow_get_artifact_dependencies",
  "servicenow_explain_portal",
]);

/**
 * The view a tool links to, if any: every plan → apply write tool (it has
 * the `apply` argument), the Mermaid generators, explain_flow and
 * explain_ui_experience.
 */
export function toolView(spec: AnyToolSpec): AppViewId | undefined {
  if (spec.name === "servicenow_explain_flow") return "flow";
  if (spec.name === "servicenow_explain_ui_experience") return "uib-tree";
  if (MERMAID_TOOLS.has(spec.name)) return "mermaid";
  return "apply" in spec.input ? "plan-diff" : undefined;
}

/** Whether the connected client declared MCP Apps support for HTML views. */
export function clientSupportsApps(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const ext = capabilities?.extensions?.[MCP_APPS_EXTENSION] as
    | { mimeTypes?: unknown }
    | undefined;
  return Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(MCP_APPS_MIME);
}

/**
 * Link a registered tool to its view. `_meta` becomes a getter evaluated on
 * every tools/list, so the link appears only once the client's initialize
 * declared the extension; an explicit `update({ _meta })` still wins.
 */
export function linkToolView(
  server: McpServer,
  spec: AnyToolSpec,
  handle: RegisteredTool,
): void {
  const view = toolView(spec);
  if (!view) return;
  const meta = { ui: { resourceUri: appViewUri(view) } };
  let override: Record<string, unknown> | undefined;
  let overridden = false;
  Object.defineProperty(handle, "_meta", {
    configurable: true,
    enumerable: true,
    get: () =>
      overridden
        ? override
        : clientSupportsApps(server.server.getClientCapabilities())
          ? meta
          : undefined,
    set: (value: Record<string, unknown> | undefined) => {
      overridden = true;
      override = value;
    },
  });
}

/**
 * Register the four view resources. They are listed for every client (the
 * spec allows it) but only linked from tools for one that supports them.
 */
export function registerAppResources(server: McpServer): void {
  for (const view of APP_VIEW_IDS) {
    const uri = appViewUri(view);
    const { title, description } = VIEW_INFO[view];
    const text = viewHtml(view, title, SERVER_VERSION);
    server.registerResource(
      `app-${view}`,
      uri,
      { title, description, mimeType: MCP_APPS_MIME },
      () => ({
        contents: [
          {
            uri,
            mimeType: MCP_APPS_MIME,
            text,
            // No `csp` key: the host then applies the spec's strict default
            // (no connect, no external resources); the HTML repeats it.
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      }),
    );
  }
}
