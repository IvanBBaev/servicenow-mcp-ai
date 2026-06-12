import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsList, docsRead, docsSearch, docsWrite } from "../api/docs.js";
import { generateErDiagram, generateTableFlow } from "../api/diagrams.js";
import { ok } from "../result.js";
import { runTool } from "./util.js";

/**
 * Self-documentation package: read/write a local Markdown knowledge base and
 * generate deterministic Mermaid diagrams from the instance's metadata. The
 * docs tools touch the local filesystem (SN_DOCS_DIR), confined to that folder.
 */
export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "servicenow_docs_list",
    {
      title: "List instance docs",
      description:
        "List the Markdown documents in the local instance-documentation folder (SN_DOCS_DIR).",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () =>
      runTool("servicenow_docs_list", {}, () => docsList().then(ok)),
  );

  server.registerTool(
    "servicenow_docs_read",
    {
      title: "Read instance doc",
      description:
        "Read one Markdown document from the local instance-documentation folder.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        path: z
          .string()
          .describe("Document path relative to the docs folder, e.g. 'tables/incident.md'."),
      },
    },
    async ({ path }) =>
      runTool("servicenow_docs_read", { path }, () => docsRead(path).then(ok)),
  );

  server.registerTool(
    "servicenow_docs_search",
    {
      title: "Search instance docs",
      description:
        "Search the local instance documentation for a substring; returns a snippet per match.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        text: z.string().describe("Substring to search for across all documents."),
      },
    },
    async ({ text }) =>
      runTool("servicenow_docs_search", { text }, () =>
        docsSearch(text).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_docs_write",
    {
      title: "Write instance doc",
      description:
        "Create or overwrite a Markdown document in the local docs folder and refresh index.md. " +
        "Use this to record durable knowledge (descriptions, Mermaid diagrams, instance quirks).",
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        path: z
          .string()
          .describe("Target document path relative to the docs folder, e.g. 'tables/incident.md'."),
        content: z.string().describe("Full Markdown content to write."),
      },
    },
    async ({ path, content }) =>
      runTool("servicenow_docs_write", { path }, () =>
        docsWrite(path, content).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_generate_er_diagram",
    {
      title: "Generate ER diagram",
      description:
        "Build a Mermaid erDiagram from sys_dictionary: an entity per table plus a relationship " +
        "for every reference field. Returns Mermaid markup ready to embed in Markdown.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        tables: z
          .array(z.string())
          .min(1)
          .describe("Tables to include, e.g. ['incident', 'problem']."),
      },
    },
    async ({ tables }) =>
      runTool("servicenow_generate_er_diagram", { tables }, () =>
        generateErDiagram(tables).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_generate_table_flow",
    {
      title: "Generate table flow",
      description:
        "Build a Mermaid flowchart of a record's lifecycle on a table, grouping active business " +
        "rules by phase (display/before/after/async) in execution order.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        table: z.string().describe("Table to diagram, e.g. 'incident'."),
      },
    },
    async ({ table }) =>
      runTool("servicenow_generate_table_flow", { table }, () =>
        generateTableFlow(table).then(ok),
      ),
  );
}
