import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildStatusPayload, profilesPayload } from "./status.js";
import { listTables, describeTable } from "../api/meta.js";
import { docsRead } from "../api/docs.js";
import { checkCapabilities } from "../api/capabilities.js";
import { listProfiles } from "../core/config.js";
import { runWithProfile } from "../core/request-context.js";
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
 * Package-scoped resource registrars (A2-1). Gating lives in the registry's
 * package manifest — these functions only know how to register themselves.
 * Errors are returned as JSON content rather than thrown, so a missing
 * connection does not break resource listing.
 */

/** Always-on management surface (admin package). */
export function registerStatusResource(server: McpServer): void {
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
}

/** Achievable-capabilities preflight (admin package, DF-0). */
export function registerCapabilitiesResource(server: McpServer): void {
  server.registerResource(
    "capabilities",
    "servicenow://capabilities",
    {
      title: "Achievable ServiceNow capabilities",
      description:
        "Which admin-restricted sys_* tables the connected user can read, and which capabilities (schema reads, script intelligence, ACL audit) are therefore achievable.",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        return jsonContents(uri, await checkCapabilities());
      } catch (error) {
        logger.warn("capabilities resource failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonContents(uri, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** Always-on admin resources: connection status + the capability preflight. */
export function registerAdminResources(server: McpServer): void {
  registerStatusResource(server);
  registerCapabilitiesResource(server);
}

/** Tables + per-table schema (schema package). */
export function registerSchemaResources(server: McpServer): void {
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
}

/** Multi-instance surface (instance package, MI-8). */
export function registerInstanceResources(server: McpServer): void {
  server.registerResource(
    "instances",
    "servicenow://instances",
    {
      title: "ServiceNow connection profiles",
      description:
        "Configured connection profiles: name, host, user, read-only flag, credential completeness. Passwords are never included.",
      mimeType: JSON_MIME,
    },
    (uri) => jsonContents(uri, profilesPayload()),
  );

  server.registerResource(
    "profile-schema",
    new ResourceTemplate("servicenow://{profile}/schema/{table}", {
      list: undefined,
    }),
    {
      title: "Table schema on a specific profile",
      description:
        "Columns of a table from sys_dictionary, read through the named connection profile. " +
        "URI: servicenow://<profile>/schema/<table>; servicenow://schema/<table> stays bound to the active profile.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const one = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v;
      const profile = one(variables.profile)?.toLowerCase();
      const table = one(variables.table);
      try {
        if (!profile || !table) {
          throw new Error("URI must be servicenow://<profile>/schema/<table>.");
        }
        if (!listProfiles().includes(profile)) {
          throw new Error(
            `Unknown connection profile "${profile}". Available: ${listProfiles().join(", ") || "(none)"}.`,
          );
        }
        const columns = await runWithProfile(profile, () =>
          describeTable(table),
        );
        return jsonContents(uri, {
          profile,
          table,
          count: columns.length,
          columns,
        });
      } catch (error) {
        logger.warn("profile schema resource failed", {
          profile,
          table,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonContents(uri, {
          profile,
          table,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** Local Markdown documentation (docs package). */
export function registerDocsResources(server: McpServer): void {
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
