import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildStatusPayload } from "./status.js";
import { effectivePackages } from "./registry.js";
import { listTables, describeTable } from "../api/meta.js";
import { docsRead } from "../api/docs.js";
import { logger } from "../core/logging.js";

const JSON_MIME = "application/json";

function jsonContents(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: JSON_MIME,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Read-only metadata exposed as MCP resources so clients can attach connection
 * status, the table list and per-table schema declaratively instead of calling
 * a tool. Errors are returned as JSON content rather than thrown, so a missing
 * connection does not break resource listing.
 */
export function registerResources(server: McpServer): void {
  // Resources follow the same package policy as the tools they mirror:
  // tables/schema belong to the schema package, docs to the docs package.
  // The status resource is the management surface and is always on.
  const enabled = new Set(effectivePackages().enabled);

  server.registerResource(
    "status",
    "servicenow://status",
    {
      title: "ServiceNow connection status",
      description:
        "Current instance, user, auth mode and access policy. Password is never included.",
      mimeType: JSON_MIME,
    },
    (uri) => jsonContents(uri, buildStatusPayload()),
  );

  if (!enabled.has("schema")) {
    registerDocsResource(server, enabled);
    return;
  }

  server.registerResource(
    "tables",
    "servicenow://tables",
    {
      title: "ServiceNow tables",
      description: "List of tables from sys_db_object (requires credentials).",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        const tables = await listTables();
        return jsonContents(uri, { count: tables.length, tables });
      } catch (error) {
        logger.warn("tables resource failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonContents(uri, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  server.registerResource(
    "schema",
    new ResourceTemplate("servicenow://schema/{table}", { list: undefined }),
    {
      title: "ServiceNow table schema",
      description:
        "Columns of a table from sys_dictionary. URI: servicenow://schema/<table>.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const raw = variables.table;
      const table = Array.isArray(raw) ? raw[0] : raw;
      try {
        if (!table) throw new Error("No table specified in the resource URI.");
        const columns = await describeTable(table);
        return jsonContents(uri, { table, count: columns.length, columns });
      } catch (error) {
        logger.warn("schema resource failed", {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonContents(uri, {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  registerDocsResource(server, enabled);
}

function registerDocsResource(server: McpServer, enabled: Set<string>): void {
  if (!enabled.has("docs")) return;
  server.registerResource(
    "docs",
    new ResourceTemplate("servicenow://docs/{path}", { list: undefined }),
    {
      title: "ServiceNow instance documentation",
      description:
        "A Markdown document from the local docs store. URI: servicenow://docs/<path>.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = variables.path;
      const docPath = Array.isArray(raw) ? raw.join("/") : raw;
      try {
        if (!docPath) throw new Error("No document path specified in the URI.");
        const { content } = await docsRead(docPath);
        return {
          contents: [
            { uri: uri.href, mimeType: "text/markdown", text: content },
          ],
        };
      } catch (error) {
        logger.warn("docs resource failed", {
          path: docPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonContents(uri, {
          path: docPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
