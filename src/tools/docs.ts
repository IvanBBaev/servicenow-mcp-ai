import { z } from "zod";
import { docsList, docsRead, docsSearch, docsWrite } from "../api/docs.js";
import { generateErDiagram, generateTableFlow } from "../api/diagrams.js";
import { lanesArg } from "./flows.js";
import { ok } from "../mcp/result.js";
import { deliverDiagram, deliverJson } from "../mcp/file-result.js";
import {
  APP_DOC_KINDS,
  DISCOVERY_DEPTHS,
  INSTANCE_DOC_KINDS,
  INSTANCE_TARGETS_MAX,
  documentApp,
  documentAppI18n,
  documentInstance,
  documentTable,
  type DocumentResult,
} from "../api/document.js";
import {
  defineTool,
  shortText,
  tableList,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { listOutput } from "../mcp/output-shapes.js";

/**
 * Self-documentation package: read/write a local Markdown knowledge base and
 * generate deterministic Mermaid diagrams from the instance's metadata. The
 * docs tools touch the local filesystem (SN_DOCS_DIR), confined to that folder.
 */

/** Optional per-profile scope shared by the docs tools (S-14). */
const profileArg = shortText(128)
  .optional()
  .describe("Profile folder: 'current' or a name; omit for all.");
/** S-11 / ID-14: `format` for the Mermaid generators. */
const diagramFormat = z
  .enum(["inline", "file"])
  .optional()
  .describe(
    "'inline' (default) or 'file': write <profile>/diagrams/<name>.mmd, return { path, bytes, preview }.",
  );

/** S-15: which profile a generated document belongs to (and reads). */
const docProfileArg = shortText(128)
  .optional()
  .describe(
    "Profile: 'current' (default) or a name; writes to its docs folder.",
  );
/** S-15: write the files (default) or return the Markdown. */
const writeArg = z
  .boolean()
  .optional()
  .describe("false returns the Markdown, writing nothing.");

/**
 * A written document already answers with { path, bytes, preview } (S-11);
 * an unwritten one carries its whole Markdown, so it gets the oversize guard.
 */
function deliverDocument(result: DocumentResult, name: string) {
  return result.markdown === undefined
    ? ok(result)
    : deliverJson(result, name, undefined);
}

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_docs",
    title: "List instance docs",
    description:
      "List the Markdown docs in SN_DOCS_DIR with metadata: generated or hand-written, generator, " +
      "generated_at, profile, kind, bytes, stale (older than SN_DOCS_STALE_DAYS).",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { profile: profileArg },
    output: listOutput("entries"),
    handler: ({ profile }) => docsList({ profile }).then(ok),
  }),

  defineTool({
    name: "servicenow_read_doc",
    title: "Read instance doc",
    description:
      "Read one local Markdown doc or its .json companion; " +
      "the result carries its mimeType.",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      path: shortText(1024).describe(
        "Path relative to the docs (or 'profile') folder, e.g. 'tables/incident.md'.",
      ),
      profile: profileArg,
    },
    output: { path: z.string(), content: z.string(), mimeType: z.string() },
    logFields: (args) => ({ path: args.path, profile: args.profile }),
    handler: ({ path, profile }) => docsRead(path, { profile }).then(ok),
  }),

  defineTool({
    name: "servicenow_search_docs",
    title: "Search instance docs",
    description:
      "Search the local docs for a substring: a snippet and nearest heading per match " +
      "(max SN_DOCS_SEARCH_MAX, then 'truncated').",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      text: shortText(1000).describe("Substring to search for."),
      profile: profileArg,
      kind: shortText(64)
        .optional()
        .describe("Only generated documents of this kind, e.g. 'tables'."),
      generated: z
        .boolean()
        .optional()
        .describe("true: only generated; false: only hand-written."),
    },
    output: listOutput("matches"),
    logFields: (args) => ({
      textLength: args.text.length,
      profile: args.profile,
      kind: args.kind,
      generated: args.generated,
    }),
    handler: ({ text, profile, kind, generated }) =>
      docsSearch(text, { profile, kind, generated }).then(ok),
  }),

  defineTool({
    name: "servicenow_write_doc",
    title: "Write instance doc",
    description:
      "Create or overwrite a local Markdown doc and refresh index.md. A generated document (sn_generated) is refused with DOC_GENERATED unless overwrite:true; annotate one inside <!-- sn:manual:start --> … <!-- sn:manual:end -->.",
    package: "docs",
    // M-8 (L4-07): overwrites an existing document — destructive for that file.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      path: shortText(1024).describe(
        "Path relative to the docs folder, e.g. 'tables/incident.md'.",
      ),
      content: z.string().describe("Full Markdown content."),
      profile: profileArg,
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace a generated document."),
    },
    output: { path: z.string(), bytes: z.number() },
    logFields: (args) => ({
      path: args.path,
      profile: args.profile,
      overwrite: args.overwrite,
    }),
    handler: ({ path, content, profile, overwrite }) =>
      docsWrite(path, content, { profile, overwrite }).then(ok),
  }),

  defineTool({
    name: "servicenow_generate_er_diagram",
    title: "Generate ER diagram",
    description:
      "Mermaid erDiagram from sys_dictionary: an entity per table, a relationship per reference field. columns / max_columns / depth give a detailed view: PK/FK and required markers, extends edges, referenced tables.",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      tables: tableList()
        .min(1)
        .describe("Tables to include, e.g. ['incident', 'problem']."),
      columns: z
        .enum(["all", "own", "keys"])
        .optional()
        .describe(
          "all: whole chain; own: the table's own; keys: sys_id, references, mandatory.",
        ),
      max_columns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Columns per entity before '+N' folding (40)."),
      depth: z
        .literal([0, 1, 2])
        .optional()
        .describe("Reference levels to follow, adding targets (0)."),
      format: diagramFormat,
    },
    logFields: (args) => ({ tables: args.tables, depth: args.depth }),
    handler: async ({ tables, columns, max_columns, depth, format }) =>
      deliverDiagram(
        await generateErDiagram(tables, { columns, max_columns, depth }),
        `er-${tables.join("-")}`,
        format,
      ),
  }),

  defineTool({
    name: "servicenow_generate_table_flow",
    title: "Generate table flow",
    description:
      "Mermaid flowchart of a record's lifecycle: active business rules by phase, inherited and global rules in own lanes. 'operation' adds the event trace (flows, workflows, notifications); 'lanes' adds opt-in lanes.",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      table: tableName().describe("Table to diagram, e.g. 'incident'."),
      operation: z
        .enum(["insert", "update", "delete", "query"])
        .optional()
        .describe("One operation, with flows, workflows and notifications."),
      lanes: lanesArg,
      format: diagramFormat,
    },
    logFields: (args) => ({
      table: args.table,
      operation: args.operation,
      lanes: args.lanes,
    }),
    handler: async ({ table, operation, lanes, format }) =>
      deliverDiagram(
        await generateTableFlow(table, { operation, lanes }),
        `flow-${table}${operation ? `-${operation}` : ""}`,
        format,
      ),
  }),

  defineTool({
    name: "servicenow_document_table",
    title: "Document a table",
    description:
      "Write <profile>/tables/<table>.md + .json from metadata: inheritance, columns, references, ER and flow diagrams, rules, client scripts, UI policies/actions, ACLs, caveats. A Purpose manual block survives re-runs.",
    package: "docs",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      table: tableName().describe("Table to document, e.g. 'incident'."),
      profile: docProfileArg,
      write: writeArg,
      diagrams: z
        .boolean()
        .optional()
        .describe("ER and table-flow diagrams (default true)."),
      columns: z
        .enum(["all", "own", "keys"])
        .optional()
        .describe("Columns the ER entity shows (default 'own')."),
    },
    logFields: (args) => ({
      table: args.table,
      profile: args.profile,
      write: args.write !== false,
    }),
    handler: async ({ table, profile, write, diagrams, columns }) =>
      deliverDocument(
        await documentTable(table, { profile, write, diagrams, columns }),
        `document-table-${table}`,
      ),
  }),

  defineTool({
    name: "servicenow_document_app",
    title: "Document an application",
    description:
      "Write <profile>/apps/<scope>.md + .json for one scoped app: record, tables with an ER diagram, roles, cross-scope privileges, artefacts by type group, caveats. Not for 'global'. write:false returns the Markdown instead.",
    package: "docs",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      scope: shortText(128).describe(
        "Scope namespace (e.g. 'x_acme_app') or sys_id.",
      ),
      profile: docProfileArg,
      write: writeArg,
      detail: z
        .boolean()
        .optional()
        .describe(
          "Add a Mermaid diagram per flow/subflow/workflow/portal/UIB experience, a dependency graph and a lint summary (bounded).",
        ),
      kind: z
        .enum(APP_DOC_KINDS)
        .optional()
        .describe("i18n: write i18n/<scope>.md, missing translations instead."),
      language: shortText(16)
        .optional()
        .describe("i18n: one language code; default all active."),
    },
    logFields: (args) => ({
      scope: args.scope,
      profile: args.profile,
      write: args.write !== false,
      detail: args.detail === true,
      kind: args.kind ?? "app",
      language: args.language,
    }),
    handler: async ({ scope, profile, write, detail, kind, language }) =>
      kind === "i18n"
        ? deliverDocument(
            await documentAppI18n(scope, { profile, write, language }),
            `document-i18n-${scope}`,
          )
        : deliverDocument(
            await documentApp(scope, { profile, write, detail }),
            `document-app-${scope}`,
          ),
  }),

  defineTool({
    name: "servicenow_document_instance",
    title: "Document the instance",
    description:
      "Write <profile>/README.md (version, counts, apps, plugins, automation, update sets) " +
      "and artifact-types.md, plus one document per named table, app and kind " +
      "(security, catalog, integrations); depth adds discovery/. A cancel keeps finished files.",
    package: "docs",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      profile: docProfileArg,
      tables: tableList(INSTANCE_TARGETS_MAX)
        .optional()
        .describe("Tables to write as tables/<name>.md."),
      apps: z
        .array(shortText(128))
        .max(INSTANCE_TARGETS_MAX)
        .optional()
        .describe("Scopes to write as apps/<scope>.md."),
      kinds: z
        .array(z.enum(INSTANCE_DOC_KINDS))
        .max(INSTANCE_DOC_KINDS.length)
        .optional()
        .describe("Instance-wide documents to add, each as <kind>.md."),
      depth: z
        .enum(DISCOVERY_DEPTHS)
        .optional()
        .describe(
          "Discovery tier under discovery/: overview, apps (+ per-scope tables), artefacts (+ per-scope artefacts); for 'apps', else every scope.",
        ),
      write: writeArg,
      format: z
        .enum(["json", "file"])
        .optional()
        .describe(
          "'json' (default) or 'file': write the result JSON to <SN_DOCS_DIR>/<profile>/exports/ and return { path, bytes, preview }.",
        ),
    },
    logFields: (args) => ({
      profile: args.profile,
      tables: args.tables?.length ?? 0,
      apps: args.apps?.length ?? 0,
      kinds: args.kinds?.join(","),
      depth: args.depth,
      write: args.write !== false,
    }),
    handler: async ({ profile, tables, apps, kinds, depth, write, format }) => {
      const result = await documentInstance({
        profile,
        tables,
        apps,
        kinds,
        depth,
        write,
      });
      return deliverJson(result, `document-instance-${result.profile}`, format);
    },
  }),
];
