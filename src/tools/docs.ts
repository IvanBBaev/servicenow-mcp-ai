import { z } from "zod";
import { docsList, docsRead, docsSearch, docsWrite } from "../api/docs.js";
import { generateErDiagram, generateTableFlow } from "../api/diagrams.js";
import { lanesArg } from "./flows.js";
import { ok } from "../mcp/result.js";
import { deliverDiagram, deliverJson } from "../mcp/file-result.js";
import {
  DISCOVERY_DEPTHS,
  INSTANCE_DOC_KINDS,
  INSTANCE_TARGETS_MAX,
  documentApp,
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

/**
 * Self-documentation package: read/write a local Markdown knowledge base and
 * generate deterministic Mermaid diagrams from the instance's metadata. The
 * docs tools touch the local filesystem (SN_DOCS_DIR), confined to that folder.
 */

/** Optional per-profile scope shared by the docs tools (S-14). */
const profileArg = shortText(128)
  .optional()
  .describe(
    "Scope to one profile's folder: 'current' for the active profile or a profile name. " +
      "Omit for the whole docs folder (paths relative to its root).",
  );
/** S-11 / ID-14: `format` for the Mermaid generators. */
const diagramFormat = z
  .enum(["inline", "file"])
  .optional()
  .describe(
    "Result delivery: 'inline' (default, Mermaid in the result) or 'file' — write the diagram to <SN_DOCS_DIR>/<profile>/diagrams/<name>.mmd and return { path, bytes, preview } instead. An inline result over SN_MAX_RESULT_CHARS carries a note (or is written to the file with SN_OVERSIZE_TO_FILE).",
  );

/** S-15: which profile a generated document belongs to (and reads). */
const docProfileArg = shortText(128)
  .optional()
  .describe(
    "Profile to read and write for: 'current' (default) or a profile name; the document lands in that profile's docs folder.",
  );
/** S-15: write the files (default) or return the Markdown. */
const writeArg = z
  .boolean()
  .optional()
  .describe(
    "Write the files (default true); false returns the Markdown without writing.",
  );

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
    name: "servicenow_docs_list",
    title: "List instance docs",
    description:
      "List the Markdown documents in the local instance-documentation folder (SN_DOCS_DIR), " +
      "with per-file metadata: generated or hand-written, generator, generated_at, profile, " +
      "kind, bytes and stale (generated more than SN_DOCS_STALE_DAYS ago).",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { profile: profileArg },
    handler: ({ profile }) => docsList({ profile }).then(ok),
  }),

  defineTool({
    name: "servicenow_docs_read",
    title: "Read instance doc",
    description:
      "Read one Markdown document or generated .json companion from the local " +
      "instance-documentation folder; the result carries its mimeType.",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      path: shortText(1024).describe(
        "Document path relative to the docs folder (or to the profile's folder with 'profile'), e.g. 'tables/incident.md'.",
      ),
      profile: profileArg,
    },
    logFields: (args) => ({ path: args.path, profile: args.profile }),
    handler: ({ path, profile }) => docsRead(path, { profile }).then(ok),
  }),

  defineTool({
    name: "servicenow_docs_search",
    title: "Search instance docs",
    description:
      "Search the local instance documentation for a substring; returns a snippet and the " +
      "nearest heading per match (at most SN_DOCS_SEARCH_MAX, flagged 'truncated' past it).",
    package: "docs",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      text: shortText(1000).describe(
        "Substring to search for across all documents.",
      ),
      profile: profileArg,
      kind: shortText(64)
        .optional()
        .describe(
          "Only generated documents of this kind, e.g. 'tables', 'schema', 'compare'.",
        ),
      generated: z
        .boolean()
        .optional()
        .describe(
          "true: only generated documents; false: only hand-written ones.",
        ),
    },
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
    name: "servicenow_docs_write",
    title: "Write instance doc",
    description:
      "Create or overwrite a Markdown document in the local docs folder and refresh index.md. A generated document (sn_generated) is refused with DOC_GENERATED unless overwrite:true; annotate one inside <!-- sn:manual:start --> … <!-- sn:manual:end -->.",
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
        "Target document path relative to the docs folder, e.g. 'tables/incident.md'.",
      ),
      content: z.string().describe("Full Markdown content to write."),
      profile: profileArg,
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace a generated document (default false)."),
    },
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
      "Build a Mermaid erDiagram from sys_dictionary: an entity per table, a relationship per reference field. columns / max_columns / depth switch to a detailed view: PK/FK and required markers, inherited comments, extends edges, referenced tables.",
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
          "all: every column of the chain; own: columns defined on the table; " +
            "keys: sys_id, references and mandatory columns.",
        ),
      max_columns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Columns per entity before the rest fold into '+N' (40)."),
      depth: z
        .union([z.literal(0), z.literal(1), z.literal(2)])
        .optional()
        .describe(
          "Follow references this many levels, adding each target table (0).",
        ),
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
      "Mermaid flowchart of a record's lifecycle on a table: active business rules by phase (display/before/after/async), inherited and global rules in own lanes. 'operation' adds the event trace (flows, workflows, notifications); 'lanes' adds opt-in lanes.",
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
        .describe(
          "Diagram one operation, including flows, workflows and notifications.",
        ),
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
      "Write <profile>/tables/<table>.md + .json from metadata only: inheritance, columns, referencing columns, ER and flow diagrams, business rules, client scripts, UI policies/actions, ACLs with roles, caveats. A Purpose manual block survives re-runs.",
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
        .describe("Include the ER and table-flow diagrams (default true)."),
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
      "Write <profile>/apps/<scope>.md + .json for one scoped app: its record, tables with an ER diagram, roles, cross-scope privileges and every registry artefact type by group, with caveats. Not for 'global'. write:false returns the Markdown instead.",
    package: "docs",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      scope: shortText(128).describe(
        "Application scope namespace (e.g. 'x_acme_app') or its sys_id.",
      ),
      profile: docProfileArg,
      write: writeArg,
    },
    logFields: (args) => ({
      scope: args.scope,
      profile: args.profile,
      write: args.write !== false,
    }),
    handler: async ({ scope, profile, write }) =>
      deliverDocument(
        await documentApp(scope, { profile, write }),
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
        .describe(
          "Tables to document as tables/<name>.md (as document_table).",
        ),
      apps: z
        .array(shortText(128))
        .max(INSTANCE_TARGETS_MAX)
        .optional()
        .describe(
          "Application scopes to document as apps/<scope>.md (as document_app).",
        ),
      kinds: z
        .array(z.enum(INSTANCE_DOC_KINDS))
        .max(INSTANCE_DOC_KINDS.length)
        .optional()
        .describe(
          "Instance-wide documents to add: 'security' (security.md), 'catalog' (catalog.md), 'integrations' (integrations.md).",
        ),
      depth: z
        .enum(DISCOVERY_DEPTHS)
        .optional()
        .describe(
          "Discovery tier under discovery/: 'overview' (overview.md), 'apps' (+ apps.md, tables-<scope>.md), 'artefacts' (+ artifacts-<scope>.md). Scopes: apps, else every sys_app scope.",
        ),
      write: writeArg,
      format: z
        .enum(["json", "file"])
        .optional()
        .describe(
          "Result delivery: 'json' (default, inline) or 'file' — write the result JSON to <SN_DOCS_DIR>/<profile>/exports/ and return { path, bytes, preview } instead.",
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
