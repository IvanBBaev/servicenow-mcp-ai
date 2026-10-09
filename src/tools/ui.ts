import { z } from "zod";
import {
  explainPortal,
  portalMarkdown,
  portalMermaid,
  PORTAL_DEPTH,
} from "../api/portal.js";
import {
  explainUiExperience,
  UI_EXPERIENCE_DETAILS,
  uiExperienceEventMermaid,
  uiExperienceMarkdown,
  uiExperienceMermaid,
} from "../api/ui-experience.js";
import {
  renderUiVariantResolution,
  resolveUiVariant,
} from "../api/uib-variant.js";
import { assertPackageAllowed } from "../core/policy.js";
import { deliverDiagram, deliverJson } from "../mcp/file-result.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";

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
      "Explain a Service Portal (url_suffix or sys_id) or one page as a tree: theme, menu, pages, layout down to widgets and dependencies. Metadata only; unreadable tables become caveats.",
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
        .describe("Portal url_suffix (e.g. 'esc') or sys_id; this or 'page'."),
      page: shortText(100)
        .optional()
        .describe(
          "Page id (e.g. 'index') or sp_page sys_id, alone; this or 'portal'.",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(PORTAL_DEPTH.max)
        .optional()
        .describe(
          `Nested-row levels to expand (default ${PORTAL_DEPTH.default}).`,
        ),
      format: z
        .enum(["json", "markdown", "mermaid", "file"])
        .optional()
        .describe(
          "json (default) tree; markdown report + Mermaid; mermaid layout; file: JSON to exports/.",
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

  defineTool({
    name: "servicenow_explain_ui_experience",
    title: "Explain a UI Builder experience",
    description:
      "Explain a UI Builder experience/workspace (path or sys_id) as a page map: routes → screens → macroponents → data brokers and ACLs; plus landing, dashboards, lists, form actions. Metadata only.",
    package: "ui",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      verified: z.boolean(),
      counts: z.record(z.string(), z.number()).optional(),
    },
    input: {
      sys_id: sysId()
        .optional()
        .describe("sys_ux_page_registry sys_id (or 'path')."),
      path: shortText(200)
        .optional()
        .describe("Experience path, e.g. 'now/sow' (or 'sys_id')."),
      format: z
        .enum(["json", "markdown", "mermaid", "file"])
        .optional()
        .describe(
          "json (default), markdown (report + diagram), mermaid (page map) or file (JSON to exports/).",
        ),
      detail: z
        .array(z.enum(UI_EXPERIENCE_DETAILS))
        .max(4)
        .optional()
        .describe(
          "Depth: element props/components, bindings, event chains, script bodies. file default: all.",
        ),
      as_user: shortText(100)
        .optional()
        .describe("user_name or sys_id: which route variants this user sees."),
    },
    logFields: (args) => ({
      sys_id: args.sys_id,
      path: args.path,
      format: args.format,
      detail: args.detail?.join(","),
      as_user: args.as_user === undefined ? undefined : true,
    }),
    handler: async ({ sys_id, path, format, detail, as_user }) => {
      // N-27 / O-13: reading another user's roles is the `directory`
      // package's surface, so denying that package also denies `as_user`.
      if (as_user !== undefined) assertPackageAllowed("directory");
      // N-26: `detail` picks the depth (element props and components,
      // bindings, event chains, script bodies) for any format; the file
      // format defaults to the full depth, since it lands in exports/.
      const levels =
        detail ?? (format === "file" ? UI_EXPERIENCE_DETAILS : undefined);
      const result = await explainUiExperience({
        sys_id,
        path,
        ...(levels ? { detail: levels } : {}),
      });
      const variants =
        as_user === undefined
          ? undefined
          : await resolveUiVariant({
              experience: result.experience?.sys_id ?? path ?? sys_id ?? "",
              user: as_user,
            });
      const withVariants = variants ? { ...result, variants } : result;
      const name = `ui-experience-${path ?? sys_id}`;
      if (format === "json" || format === undefined) {
        return deliverJson(withVariants, name, "json");
      }
      const { mermaid, truncated } = uiExperienceMermaid(result);
      const signal = truncated > 0 ? { mermaidTruncated: truncated } : {};
      const summary = {
        ...(result.experience ? { sys_id: result.experience.sys_id } : {}),
        counts: result.counts,
        verified: result.verified,
        caveats: result.caveats,
        ...signal,
      };
      if (format === "mermaid") {
        return deliverDiagram({ ...summary, mermaid }, name, "inline");
      }
      if (format === "markdown") {
        const markdown = uiExperienceMarkdown(result, mermaid);
        return ok({
          ...summary,
          markdown: variants
            ? [markdown, "", ...renderUiVariantResolution(variants)].join("\n")
            : markdown,
        });
      }
      const events = uiExperienceEventMermaid(result);
      return deliverJson(
        {
          ...withVariants,
          ...signal,
          mermaid,
          ...(events.mermaid ? { eventMermaid: events.mermaid } : {}),
        },
        name,
        "file",
      );
    },
  }),
];
