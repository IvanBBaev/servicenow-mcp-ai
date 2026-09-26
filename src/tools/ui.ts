import { z } from "zod";
import {
  explainPortal,
  portalMarkdown,
  portalMermaid,
  PORTAL_DEPTH,
} from "../api/portal.js";
import { deliverDiagram, deliverJson } from "../mcp/file-result.js";
import { ok } from "../mcp/result.js";
import { defineTool, shortText, type AnyToolSpec } from "../mcp/define.js";

/**
 * P-16 — opt-in `ui` package (SDK-PARITY §5(d)): read-only explainers of UI
 * surfaces. `servicenow_explain_portal` walks a Service Portal from the
 * portal record down to widget dependencies; the UI Builder explainer (P-14)
 * is planned for the same package.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_explain_portal",
    title: "Explain a Service Portal",
    description:
      "Explain a Service Portal (url_suffix or sys_id) or one page as a tree: theme, menu, pages, then layout container → row → column → widget instance → widget → dependencies. Metadata only; unreadable tables become caveats.",
    package: "ui",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      portal: shortText(100)
        .optional()
        .describe(
          "Portal url_suffix (e.g. 'sp', 'esc') or sp_portal sys_id. Pass this or 'page', not both.",
        ),
      page: shortText(100)
        .optional()
        .describe(
          "Portal page id (e.g. 'index') or sp_page sys_id: explain that page only. Pass this or 'portal', not both.",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(PORTAL_DEPTH.max)
        .optional()
        .describe(
          `Levels of nested rows (a row inside a column) to expand (default ${PORTAL_DEPTH.default}).`,
        ),
      format: z
        .enum(["json", "markdown", "mermaid", "file"])
        .optional()
        .describe(
          "'json' (default) the tree; 'markdown' a report with the Mermaid diagram; 'mermaid' the layout diagram only; 'file' the full JSON (diagram included) written to exports/ with a summary returned.",
        ),
    },
    logFields: (args) => ({
      portal: args.portal,
      page: args.page,
      depth: args.depth,
      format: args.format,
    }),
    handler: async ({ portal, page, depth, format }) => {
      const result = await explainPortal({ portal, page, depth });
      const name = `portal-${portal ?? page}`;
      if (format === "json" || format === undefined) {
        return deliverJson(result, name, "json");
      }
      const { mermaid, truncated } = portalMermaid(result);
      const signal = truncated > 0 ? { mermaidTruncated: truncated } : {};
      if (format === "mermaid") {
        return deliverDiagram(
          {
            mode: result.mode,
            counts: result.counts,
            verified: result.verified,
            caveats: result.caveats,
            ...signal,
            mermaid,
          },
          name,
          "inline",
        );
      }
      if (format === "markdown") {
        return ok({
          mode: result.mode,
          counts: result.counts,
          verified: result.verified,
          caveats: result.caveats,
          ...signal,
          markdown: portalMarkdown(result, mermaid),
        });
      }
      return deliverJson({ ...result, ...signal, mermaid }, name, "file");
    },
  }),
];
