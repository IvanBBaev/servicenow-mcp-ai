import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildStatusPayload, profilesPayload } from "./status.js";
import {
  listTables,
  describeTable,
  cachedTableNames,
  SEED_TABLES,
} from "../api/meta.js";
import {
  docsRead,
  docsList,
  docsManifest,
  type ManifestEntry,
} from "../api/docs.js";
import { checkCapabilities } from "../api/capabilities.js";
import { artifactTypeCatalog } from "../api/artifacts.js";
import { activeProfile, getCredentials, listProfiles } from "../core/config.js";
import { runWithProfile } from "../core/request-context.js";
import { logger } from "../core/logging.js";
import { untrusted } from "./boundary.js";
import type { ToolInfo } from "./registry.js";

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
 * M-4 (L5-03): resource lists and completions return at most this many
 * entries, and never call the instance — they read the schema cache, the
 * profile list and the docs manifest only.
 */
export const LIST_CAP = 100;

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** Unique values starting with `prefix` (case-insensitive), capped. */
function byPrefix(values: Iterable<string>, prefix = ""): string[] {
  const p = prefix.toLowerCase();
  const out = new Set<string>();
  for (const v of values) {
    if (out.size >= LIST_CAP) break;
    if (v.toLowerCase().startsWith(p)) out.add(v);
  }
  return [...out];
}

/**
 * Table-name completion: tables the schema cache knows for `profile` (or the
 * active profile), then the seed tables.
 */
export function completeTable(value: string, profile?: string): string[] {
  const p = profile?.trim().toLowerCase();
  const instance =
    p && listProfiles().includes(p)
      ? getCredentials(p).instance
      : getCredentials().instance;
  return byPrefix([...cachedTableNames(instance), ...SEED_TABLES], value);
}

/** Profile-name completion from the configured profiles. */
export function completeProfile(value: string): string[] {
  return byPrefix(listProfiles(), value);
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
        "Which admin-restricted sys_* tables the connected user can read, and which capabilities (schema reads, script intelligence, ACL audit) are therefore achievable, plus the per-group capability matrix (writes, update sets, attachments, aggregate, import sets, email, ATF, version, roles).",
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

/** The tool set and the package policy, as `servicenow://reference/tools` renders it. */
export interface ToolsReferenceSource {
  tools: ToolInfo[];
  enabled: string[];
  readOnly: string[];
}

/** First sentence of a description, safe inside a Markdown table cell. */
function summary(description: string): string {
  const first = description.split(/(?<=\.)\s/)[0] ?? description;
  return first.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** The tool manifest as Markdown, grouped by package (M-4 / PR-1). */
export function renderToolsReference(src: ToolsReferenceSource): string {
  const enabled = new Set(src.enabled);
  const readOnly = new Set(src.readOnly);
  const registered = (t: ToolInfo): boolean =>
    t.package === "admin" ||
    (enabled.has(t.package) && (!readOnly.has(t.package) || t.readOnly));
  const packages = [...new Set(src.tools.map((t) => t.package))];
  const lines = [
    "# ServiceNow MCP tools",
    "",
    `${src.tools.length} tools in ${packages.length} packages; ${src.tools.filter(registered).length} registered in this session (SN_TOOL_PACKAGES, SN_PACKAGES_DENY, SN_PACKAGES_READONLY).`,
  ];
  for (const pkg of packages) {
    const state =
      pkg === "admin" || enabled.has(pkg)
        ? readOnly.has(pkg)
          ? "enabled, read-only"
          : "enabled"
        : "not enabled";
    lines.push(
      "",
      `## ${pkg} (${state})`,
      "",
      "| Tool | Access | Registered | Summary |",
      "| --- | --- | --- | --- |",
    );
    for (const t of src.tools.filter((x) => x.package === pkg)) {
      lines.push(
        `| \`${t.name}\` | ${t.readOnly ? "read" : "write"} | ${registered(t) ? "yes" : "no"} | ${summary(t.description)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The tool manifest resource (M-4). Always on, like the admin resources; the
 * registry passes the source in so this module does not import it back.
 */
export function registerToolsReferenceResource(
  server: McpServer,
  source: () => ToolsReferenceSource,
): void {
  server.registerResource(
    "tools-reference",
    "servicenow://reference/tools",
    {
      title: "Tool reference",
      description:
        "Every tool by package: read or write, whether it is registered under the current package policy, and a one-line summary.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: renderToolsReference(source()),
        },
      ],
    }),
  );
}

/** Always-on admin resources: connection status + the capability preflight. */
export function registerAdminResources(server: McpServer): void {
  registerStatusResource(server);
  registerCapabilitiesResource(server);
}

/**
 * S-8 (C-6): a static reference for the encoded-query syntax the Table-style
 * tools take, including its limits (no escape for `^`, URL length) and how
 * `fetchAll` pages. Kept here, not fetched, so it is available offline.
 */
export const ENCODED_QUERY_REFERENCE = `# ServiceNow encoded queries

An encoded query (\`sysparm_query\`) is a list of conditions joined by \`^\`.

## Syntax

| Form | Meaning |
| --- | --- |
| \`a=1^b=2\` | a = 1 AND b = 2 |
| \`a=1^ORa=2\` | a = 1 OR a = 2 (\`^OR\` binds to the condition before it) |
| \`a=1^NQb=2\` | (a = 1) OR (b = 2) — a new query; later conditions apply to the last group only |
| \`fieldIN1,2,3\` / \`fieldNOT IN1,2\` | value in / not in a comma-separated list |
| \`fieldLIKEtext\` / \`fieldSTARTSWITHtext\` / \`fieldENDSWITHtext\` | contains / prefix / suffix |
| \`fieldISEMPTY\` / \`fieldISNOTEMPTY\` | empty / not empty |
| \`field!=x\`, \`field>x\`, \`field>=x\`, \`field<x\`, \`field<=x\` | comparisons |
| \`ref.field=x\` | dot-walk through a reference field |
| \`fieldBETWEENa@b\` | inclusive range (dates: two \`javascript:\` values joined by \`@\`) |
| \`fieldSAMEASother\` / \`fieldNSAMEASother\` | equal / not equal to another field |
| \`ORDERBYfield\` / \`ORDERBYDESCfield\` | sort ascending / descending |

## \`javascript:\` values

A value may be a server-side expression, evaluated by the instance when the
query runs (the instance can restrict which scripts are allowed):

| Value | Meaning |
| --- | --- |
| \`assigned_to=javascript:gs.getUserID()\` | the calling user |
| \`sys_created_on>=javascript:gs.beginningOfToday()\` | since midnight (also \`gs.endOfToday()\`, \`gs.beginningOfThisWeek()\`, \`gs.beginningOfThisMonth()\`) |
| \`sys_updated_on>=javascript:gs.daysAgoStart(7)\` | in the last 7 days (\`gs.hoursAgoStart(n)\`, \`gs.minutesAgoStart(n)\`) |
| \`opened_atBETWEENjavascript:gs.dateGenerate('2026-01-01','00:00:00')@javascript:gs.dateGenerate('2026-01-31','23:59:59')\` | a fixed date range |

## Limits

- **No escaping.** \`^\` separates conditions and cannot be escaped inside a
  value, \`,\` separates \`IN\` list items and \`@\` separates \`BETWEEN\`
  bounds. Values containing them cannot be matched exactly; the tools that
  build queries from your input reject \`^\`.
- **URL length.** The query travels in the URL. Very long queries (large \`IN\`
  lists of sys_ids) can exceed the instance's or a proxy's URL length limit and
  fail with HTTP 414 — split the list into several calls.
- **Invalid fields.** A condition on a field that does not exist is ignored by
  default rather than rejected, which silently widens the result.
- **Row-level ACLs** filter rows after paging, so a page can come back short
  while more rows follow; \`fetchAll\` reports the gap as \`filtered\`.

## Paging (\`fetchAll\`)

- Without an \`ORDERBY\` the read is ordered by \`sys_id\` and pages by cursor
  (\`sys_id>\` the last row read), so rows inserted or deleted during the read
  are neither skipped nor repeated.
- With an \`ORDERBY\` (or a \`^NQ\` query) it pages by offset, which can skip
  or repeat rows when the table changes during the read.
- Reads stop at \`SN_MAX_RECORDS\`; a partial read is flagged \`truncated\`.
`;

/** Encoded-query reference (table package, S-8 / C-6). */
export function registerTableResources(server: McpServer): void {
  server.registerResource(
    "encoded-query",
    "servicenow://reference/encoded-query",
    {
      title: "Encoded query reference",
      description:
        "Encoded-query syntax (operators, ORDERBY, javascript: values), its limits (no escaping, URL length) and how fetchAll pages.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: ENCODED_QUERY_REFERENCE,
        },
      ],
    }),
  );
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
    new ResourceTemplate("servicenow://schema/{table}", {
      // M-4: cached tables of the active profile plus the seed, capped.
      list: () => ({
        resources: byPrefix([...cachedTableNames(), ...SEED_TABLES]).map(
          (table) => ({
            uri: `servicenow://schema/${table}`,
            name: table,
            mimeType: JSON_MIME,
          }),
        ),
      }),
      complete: { table: (value) => completeTable(value) },
    }),
    {
      title: "ServiceNow table schema",
      description:
        "Columns of a table from sys_dictionary. URI: servicenow://schema/<table>.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const table = one(variables.table);
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
      // M-4: per profile, only the tables its schema cache already holds —
      // the seed would multiply by the profile count.
      list: () => {
        const resources = [];
        for (const profile of listProfiles()) {
          const instance = getCredentials(profile).instance;
          for (const table of cachedTableNames(instance)) {
            if (resources.length >= LIST_CAP) break;
            resources.push({
              uri: `servicenow://${profile}/schema/${table}`,
              name: `${profile}: ${table}`,
              mimeType: JSON_MIME,
            });
          }
        }
        return { resources };
      },
      complete: {
        profile: (value) => completeProfile(value),
        table: (value, context) =>
          completeTable(value, context?.arguments?.profile),
      },
    }),
    {
      title: "Table schema on a specific profile",
      description:
        "Columns of a table from sys_dictionary, read through the named connection profile. " +
        "URI: servicenow://<profile>/schema/<table>; servicenow://schema/<table> stays bound to the active profile.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
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

/** One docs entry for the resource list: the manifest's fields we use. */
type DocsListEntry = Pick<
  ManifestEntry,
  "path" | "title" | "profile" | "kind" | "generator" | "generated_at"
>;

const INDEX_PATH = "index.md";

/**
 * The docs store's documents, from index.json (ID-13) — or, before the first
 * write has built it, from a walk of the directory (no titles).
 */
async function docsEntries(): Promise<DocsListEntry[]> {
  const manifest = await docsManifest();
  if (manifest) return manifest;
  const { entries } = await docsList();
  return entries.map((e) => ({
    path: e.path,
    title: null,
    profile: e.profile ?? null,
    kind: e.kind ?? null,
    generator: e.generator ?? null,
    generated_at: e.generated_at ?? null,
  }));
}

const docsUri = (docPath: string): string =>
  `servicenow://docs/${encodeURI(docPath)}`;

const docsMime = (docPath: string): string =>
  docPath.toLowerCase().endsWith(".json") ? JSON_MIME : "text/markdown";

/**
 * The docs resource list (ID-13): generated documents first, then
 * hand-written ones, capped so that a final `index.md` entry — which lists
 * everything — is never cut off.
 */
export async function listDocsResources(): Promise<{
  resources: {
    uri: string;
    name: string;
    title?: string;
    description: string;
    mimeType: string;
  }[];
}> {
  let all: DocsListEntry[];
  try {
    all = await docsEntries();
  } catch (error) {
    // A broken docs dir must not fail resources/list as a whole.
    logger.warn("docs resource list failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { resources: [] };
  }
  const docs = all
    .filter((e) => e.path.toLowerCase() !== INDEX_PATH)
    .sort(
      (a, b) =>
        Number(a.generator === null) - Number(b.generator === null) ||
        a.path.localeCompare(b.path),
    );
  const hasIndex = all.length > 0;
  const resources = docs
    .slice(0, hasIndex ? LIST_CAP - 1 : LIST_CAP)
    .map((e) => ({
      uri: docsUri(e.path),
      name: e.title ?? e.path,
      description:
        e.generator === null
          ? "hand-written"
          : [e.profile ?? "-", e.kind ?? "-", e.generated_at ?? "-"].join(
              " · ",
            ),
      mimeType: docsMime(e.path),
    }));
  if (hasIndex) {
    resources.push({
      uri: docsUri(INDEX_PATH),
      name: "ServiceNow instance documentation index",
      description: `Index of all ${docs.length} documents`,
      mimeType: "text/markdown",
    });
  }
  return { resources };
}

/**
 * `{path}` completion (ID-13): manifest paths starting with the value, then
 * paths starting with `<active profile>/<value>`.
 */
export async function completeDocPath(value: string): Promise<string[]> {
  try {
    const paths = (await docsEntries()).map((e) => e.path);
    return byPrefix(
      [
        ...byPrefix(paths, value),
        ...byPrefix(paths, `${activeProfile()}/${value}`),
      ],
      "",
    );
  } catch {
    return [];
  }
}

/** Local Markdown documentation (docs package). */
export function registerDocsResources(server: McpServer): void {
  server.registerResource(
    "docs",
    // M-4: reserved expansion (`{+path}`) so nested paths such as
    // servicenow://docs/dev/tables/incident.md match; `path` stays the name.
    new ResourceTemplate("servicenow://docs/{+path}", {
      list: listDocsResources,
      complete: { path: completeDocPath },
    }),
    {
      title: "ServiceNow instance documentation",
      description:
        "A Markdown document from the local docs store, wrapped in an untrusted-content boundary. URI: servicenow://docs/<path>.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = variables.path;
      let docPath = Array.isArray(raw) ? raw.join("/") : raw;
      try {
        if (!docPath) throw new Error("No document path specified in the URI.");
        docPath = decodeURIComponent(docPath);
        const { content, mimeType } = await docsRead(docPath);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType,
              // SEC-21: the store is filled from instance data by the model.
              text: untrusted(`the docs store (${docPath})`, content),
            },
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

/**
 * P-5: the artefact registry as a static catalogue (artifacts package) — the
 * type ids servicenow_list_artifacts / servicenow_get_artifact /
 * servicenow_explain_artifact accept, with
 * their tables, key fields and child tables. Local data, no instance call.
 */
export function registerArtifactResources(server: McpServer): void {
  server.registerResource(
    "artifact-types",
    "servicenow://artifact-types",
    {
      title: "ServiceNow artifact types",
      description:
        "Every artifact type the generic artifact tools accept: table, name and key fields, scope field, active flag, child tables, Fluent API, tiers and whether the names are verified on a live instance.",
      mimeType: JSON_MIME,
    },
    (uri) => jsonContents(uri, artifactTypeCatalog()),
  );
}
