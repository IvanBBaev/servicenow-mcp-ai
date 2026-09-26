import { z } from "zod";
import {
  snapshotInstance,
  RECORD_SECTIONS,
  SNAPSHOT_SECTIONS,
  type RecordSectionId,
} from "../api/snapshot.js";
import { compareInstances } from "../api/compare.js";
import { deliverJson } from "../mcp/file-result.js";
import {
  defineTool,
  shortText,
  tableList,
  type AnyToolSpec,
} from "../mcp/define.js";

/** S-11: `format` for the snapshot / compare results. */
const formatInput = z
  .enum(["json", "file"])
  .optional()
  .describe(
    "Result delivery: 'json' (default, inline) or 'file' — write the full (redacted) result JSON to <SN_DOCS_DIR>/<profile>/exports/ and return { path, bytes, preview } plus a summary. An inline result over SN_MAX_RESULT_CHARS carries a note (or is written to a file with SN_OVERSIZE_TO_FILE).",
  );

/**
 * Instance analysis package (Phase 7): snapshot an instance's structural
 * metadata into the local docs folder; instance comparison (MI-7) joins it
 * next. Reads go through the regular api/ layers, output lands under
 * SN_DOCS_DIR/<profile>/.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_snapshot_instance",
    title: "Snapshot instance metadata",
    description:
      "Download structural metadata to SN_DOCS_DIR/<profile>/ as Markdown + JSON: tables, schema/<table>.md, plugins, apps, script stats, properties (secrets redacted), choices, ACLs, notifications, flows, catalog, roles. resume:true resumes.",
    package: "instance",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      tables: tableList(1000)
        .optional()
        .describe(
          "Tables to document in detail as schema/<table>.md, e.g. ['incident', 'change_request']. Omit for none.",
        ),
      sections: z
        .array(z.enum(SNAPSHOT_SECTIONS))
        .min(1)
        .max(SNAPSHOT_SECTIONS.length)
        .optional()
        .describe(
          `Sections to collect (default all): ${SNAPSHOT_SECTIONS.join(", ")}.`,
        ),
      resume: z
        .boolean()
        .optional()
        .describe(
          "Continue an interrupted snapshot: skip the sections whose files still carry the recorded source hash (default false).",
        ),
      format: formatInput,
    },
    logFields: (args) => ({
      tables: args.tables?.length ?? 0,
      sections: args.sections?.length,
      resume: args.resume === true,
    }),
    handler: async ({ tables, sections, resume, format }) =>
      deliverJson(
        await snapshotInstance({ tables, sections, resume }),
        "snapshot",
        format,
      ),
  }),

  defineTool({
    name: "servicenow_compare_instances",
    title: "Compare two instances",
    description:
      "Diff two profiles: tables in only one, column type/mandatory/reference differences, scripts missing/renamed/changed (live, unified diff), plugin/app inventory, optional record sections. Writes _compare/<a>-vs-<b>.md; from_snapshot reads snapshots.",
    package: "instance",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      a: shortText(128).describe("First connection profile, e.g. 'dev'."),
      b: shortText(128).describe("Second connection profile, e.g. 'prod'."),
      from_snapshot: z
        .boolean()
        .optional()
        .describe(
          "Prefer the stored servicenow_snapshot_instance JSON files for tables/plugins/apps when present (default false: everything live). Also applies to record sections.",
        ),
      sections: z
        .array(z.enum(Object.keys(RECORD_SECTIONS) as [RecordSectionId]))
        .min(1)
        .max(Object.keys(RECORD_SECTIONS).length)
        .optional()
        .describe(
          `Also compare these snapshot record sections, matched by sys_id then name: ${Object.keys(RECORD_SECTIONS).join(", ")}. Default none.`,
        ),
      format: formatInput,
    },
    logFields: (args) => ({
      a: args.a,
      b: args.b,
      fromSnapshot: args.from_snapshot === true,
      sections: args.sections?.length,
    }),
    handler: async ({ a, b, from_snapshot, sections, format }) => {
      const result = await compareInstances({
        a,
        b,
        fromSnapshot: from_snapshot,
        sections,
      });
      return deliverJson(result, `compare-${result.a}-vs-${result.b}`, format);
    },
  }),
];
