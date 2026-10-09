import { policyResourcePayload } from "./policy-view.js";
import { TOOL_EXAMPLES } from "./tool-examples.js";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
import { activeProfile, listProfiles } from "../core/config.js";
import { runWithCall, runWithProfile } from "../core/request-context.js";
import { createSecretRegistry } from "../core/secret-columns.js";
import { redactValue, redactionRules } from "../core/redaction.js";
import { getRecord } from "../api/table.js";
import { RECORD_TEMPLATE } from "./record-watch.js";
import { logger } from "../core/logging.js";
import {
  errorCodeOf,
  errorCodeTable,
  errorSourceOf,
  IntegrationError,
} from "../core/errors.js";
import { untrusted } from "./boundary.js";
import type { ToolInfo } from "./registry.js";

const JSON_MIME = "application/json";

/**
 * M-2: codes that mean the URI itself is wrong — a missing part, an unknown
 * profile, a document or table that does not exist. The SDK has no
 * ResourceNotFound code, so these become InvalidParams; anything else
 * (instance down, credentials missing, policy) is InternalError.
 */
const CALLER_CODES = new Set([
  "INVALID_INPUT",
  "NOT_FOUND",
  "UNKNOWN_PROFILE",
  "INSTANCE_HTTP_404",
]);

/**
 * M-2: a failed resource read as a protocol error (not a 200 body with an
 * `error` field). `data` carries the tool error contract's code, source and
 * hint so a client can branch the same way it does on a failed tool call.
 */
export function resourceError(
  what: string,
  error: unknown,
  context: Record<string, unknown> = {},
): McpError {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`${what} resource failed`, { ...context, error: message });
  const code = errorCodeOf(error);
  const hint = error instanceof IntegrationError ? error.hint : undefined;
  return new McpError(
    CALLER_CODES.has(code) ? ErrorCode.InvalidParams : ErrorCode.InternalError,
    message,
    { code, source: errorSourceOf(error), ...(hint ? { hint } : {}) },
  );
}

/** M-2: a resource URI that is malformed or names nothing. */
function badUri(message: string): IntegrationError {
  return new IntegrationError(message, undefined, undefined, {
    code: "INVALID_INPUT",
  });
}

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
  const scoped = p && listProfiles().includes(p) ? p : undefined;
  return byPrefix([...cachedTableNames(scoped), ...SEED_TABLES], value);
}

/** Profile-name completion from the configured profiles. */
export function completeProfile(value: string): string[] {
  return byPrefix(listProfiles(), value);
}

/**
 * Package-scoped resource registrars (A2-1). Gating lives in the registry's
 * package manifest — these functions only know how to register themselves.
 * M-2: a failed read throws an McpError (resourceError) instead of returning
 * a 200 body with an `error` field; listing never calls the instance, so a
 * missing connection still does not break resources/list.
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
        throw resourceError("capabilities", error);
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

/** Whether a tool is registered under the package policy of `src`. */
function isRegistered(src: ToolsReferenceSource, t: ToolInfo): boolean {
  return (
    t.package === "admin" ||
    (src.enabled.includes(t.package) &&
      (!src.readOnly.includes(t.package) || t.readOnly))
  );
}

/** A package's state under the policy of `src`, as the references word it. */
function packageState(src: ToolsReferenceSource, pkg: string): string {
  if (pkg !== "admin" && !src.enabled.includes(pkg)) return "not enabled";
  return src.readOnly.includes(pkg) ? "enabled, read-only" : "enabled";
}

/** The tool manifest as Markdown, grouped by package (M-4 / PR-1). */
export function renderToolsReference(src: ToolsReferenceSource): string {
  const registered = (t: ToolInfo): boolean => isRegistered(src, t);
  const packages = [...new Set(src.tools.map((t) => t.package))];
  const lines = [
    "# ServiceNow MCP tools",
    "",
    `${src.tools.length} tools in ${packages.length} packages; ${src.tools.filter(registered).length} registered in this session (SN_TOOL_PACKAGES, SN_PACKAGES_DENY, SN_PACKAGES_READONLY).`,
  ];
  for (const pkg of packages) {
    const state = packageState(src, pkg);
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

/** N-37: the URI template of one tool's full reference. */
export const TOOL_REFERENCE_TEMPLATE = "servicenow://reference/tools/{name}";

/** N-37: the reference URI of one tool. */
export function toolReferenceUri(name: string): string {
  return `servicenow://reference/tools/${name}`;
}

/**
 * N-37: the parts of one tool's definition the compact ToolInfo leaves out —
 * its JSON Schemas as tools/list publishes them and its M-7 naming metadata.
 */
export interface ToolReferenceDetail {
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  legacyParams?: Record<string, string>;
  deprecatedParams?: Record<string, string>;
  overlap?: string;
}

/** N-37: what the per-tool reference reads, supplied by the registry. */
export interface ToolReferenceSource {
  /** The tool set and the package policy (as for servicenow://reference/tools). */
  reference: () => ToolsReferenceSource;
  /** The schemas and naming metadata of one tool, or undefined if unknown. */
  detail: (name: string) => ToolReferenceDetail | undefined;
  /** Retired tool names (M-7), for a hint when one is asked for. */
  renames?: readonly { from: string; to: string }[];
}

/**
 * N-37: the error codes a tool result can carry, grouped by source. The M-2
 * table is global — most codes come from shared layers any tool can hit — so
 * the reference lists the names only; the manifest holds the descriptions.
 */
function errorCodesBySource(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [code, info] of Object.entries(errorCodeTable())) {
    (out[info.source] ??= []).push(code);
  }
  return out;
}

/** N-37: one tool's full reference as a JSON payload. */
/** N-37 / N-54: the example call of a tool, when it has one. */
function exampleOf(name: string) {
  return (
    TOOL_EXAMPLES as Record<
      string,
      (typeof TOOL_EXAMPLES)[keyof typeof TOOL_EXAMPLES] | undefined
    >
  )[name];
}

export function toolReferencePayload(
  src: ToolsReferenceSource,
  tool: ToolInfo,
  detail: ToolReferenceDetail,
): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    package: tool.package,
    packageState: packageState(src, tool.package),
    access: tool.readOnly ? "read" : "write",
    registered: isRegistered(src, tool),
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: detail.inputSchema,
    outputSchema: detail.outputSchema ?? null,
    ...(exampleOf(tool.name) ? { example: exampleOf(tool.name) } : {}),
    ...(detail.legacyParams ? { legacyParams: detail.legacyParams } : {}),
    ...(detail.deprecatedParams
      ? { deprecatedParams: detail.deprecatedParams }
      : {}),
    ...(detail.overlap ? { overlap: detail.overlap } : {}),
    errorCodes: {
      scope: "global",
      note: "Any tool can return these codes (shared request, policy, plan-token and credential layers); a failed result carries code, source and hint.",
      bySource: errorCodesBySource(),
    },
  };
}

/**
 * N-37: the per-tool reference template. Always on, like the tool list: it
 * documents every tool, registered or not, and says which. It lists nothing
 * (97 entries would crowd resources/list); `{name}` completes tool names.
 */
export function registerToolReferenceTemplate(
  server: McpServer,
  source: ToolReferenceSource,
): void {
  server.registerResource(
    "tool-reference",
    new ResourceTemplate(TOOL_REFERENCE_TEMPLATE, {
      list: undefined,
      complete: {
        name: (value) =>
          byPrefix(
            source.reference().tools.map((t) => t.name),
            value,
          ),
      },
    }),
    {
      title: "Tool reference (one tool)",
      description:
        "One tool's full definition: description, input and output JSON Schema, an example call, annotations, package and whether it is registered, parameter aliases and the error codes. URI: servicenow://reference/tools/<tool name>.",
      mimeType: JSON_MIME,
    },
    (uri, variables) => {
      const name = one(variables.name);
      try {
        if (!name) throw badUri("No tool name specified in the resource URI.");
        const src = source.reference();
        const tool = src.tools.find((t) => t.name === name);
        const detail = tool ? source.detail(name) : undefined;
        if (!tool || !detail) {
          const renamed = source.renames?.find((r) => r.from === name);
          throw new IntegrationError(
            `Unknown tool "${name}".`,
            undefined,
            undefined,
            {
              code: "NOT_FOUND",
              hint: renamed
                ? `"${name}" was renamed; read ${toolReferenceUri(renamed.to)}.`
                : "servicenow://reference/tools lists every tool name.",
            },
          );
        }
        return jsonContents(uri, toolReferencePayload(src, tool, detail));
      } catch (error) {
        throw resourceError("tool reference", error, { name });
      }
    },
  );
}

/** H-11 (L3-04): the effective access policy of every profile (local). */
export function registerPolicyResource(server: McpServer): void {
  server.registerResource(
    "policy",
    "servicenow://policy",
    {
      title: "ServiceNow access policy",
      description:
        "Effective table rules (exact and pattern), protected tables, import-set tables, read-only and write mode per profile — the guards' own evaluator.",
      mimeType: JSON_MIME,
    },
    (uri) => jsonContents(uri, policyResourcePayload()),
  );
}

/** Always-on admin resources: status, the capability preflight, the policy. */
export function registerAdminResources(server: McpServer): void {
  registerStatusResource(server);
  registerCapabilitiesResource(server);
  registerPolicyResource(server);
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

  // N-10: one record, subscribable — the server polls it for changes.
  server.registerResource(
    "record",
    new ResourceTemplate(RECORD_TEMPLATE, {
      list: undefined,
      complete: profileSchemaCompletions,
    }),
    {
      title: "ServiceNow record (subscribable)",
      description:
        "One record read through the named profile, masked like servicenow_get_record. " +
        "URI: servicenow://profiles/<profile>/records/<table>/<sys_id>. Subscribe to get " +
        "resources/updated when its sys_updated_on / sys_mod_count changes (polled, floor 30 s, capped).",
      mimeType: JSON_MIME,
    },
    (uri, variables) => readRecord(uri, variables),
  );
}

let recordReads = 0;

/** N-10: read one record through the named profile, redacted (N-21). */
async function readRecord(
  uri: URL,
  variables: Record<string, string | string[]>,
) {
  const profile = one(variables.profile)?.toLowerCase();
  const table = one(variables.table);
  const sysId = one(variables.sys_id);
  try {
    if (!profile || !table || !sysId) {
      throw badUri(
        "URI must be servicenow://profiles/<profile>/records/<table>/<sys_id>.",
      );
    }
    if (!listProfiles().includes(profile)) {
      throw new IntegrationError(
        `Unknown connection profile "${profile}". Available: ${listProfiles().join(", ") || "(none)"}.`,
        undefined,
        undefined,
        { code: "UNKNOWN_PROFILE" },
      );
    }
    // A call context of its own, so N-21 secret columns are resolved and
    // masked exactly as on a servicenow_get_record call.
    const record = await runWithCall(
      {
        requestId: `resource-record-${++recordReads}`,
        tool: "resource:record",
        profile,
        secrets: createSecretRegistry(),
      },
      () =>
        runWithProfile(
          profile,
          async () =>
            redactValue(await getRecord(table, sysId), redactionRules()).value,
        ),
    );
    return jsonContents(uri, { profile, table, sys_id: sysId, record });
  } catch (error) {
    throw resourceError("record", error, { profile, table, sys_id: sysId });
  }
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
        throw resourceError("tables", error);
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
        if (!table) throw badUri("No table specified in the resource URI.");
        const columns = await describeTable(table);
        return jsonContents(uri, { table, count: columns.length, columns });
      } catch (error) {
        throw resourceError("schema", error, { table });
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
    new ResourceTemplate(PROFILE_SCHEMA_TEMPLATE, {
      // M-4: per profile, only the tables its schema cache already holds —
      // the seed would multiply by the profile count.
      list: () => {
        const resources = [];
        for (const profile of listProfiles()) {
          for (const table of cachedTableNames(profile)) {
            if (resources.length >= LIST_CAP) break;
            resources.push({
              uri: profileSchemaUri(profile, table),
              name: `${profile}: ${table}`,
              mimeType: JSON_MIME,
            });
          }
        }
        return { resources };
      },
      complete: profileSchemaCompletions,
    }),
    {
      title: "Table schema on a specific profile",
      description:
        "Columns of a table from sys_dictionary, read through the named connection profile. " +
        "URI: servicenow://profiles/<profile>/schema/<table>; servicenow://schema/<table> stays bound to the active profile.",
      mimeType: JSON_MIME,
    },
    (uri, variables) => readProfileSchema(uri, variables),
  );

  // M-7 (B13): the v2 template, kept for one minor cycle. It reads the same
  // schema, warns once, and lists nothing (the v3 template lists the tables).
  server.registerResource(
    "profile-schema-legacy",
    new ResourceTemplate(LEGACY_PROFILE_SCHEMA_TEMPLATE, {
      list: undefined,
      complete: profileSchemaCompletions,
    }),
    {
      title: "Table schema on a specific profile (deprecated URI)",
      description:
        "Deprecated: use servicenow://profiles/<profile>/schema/<table>. " +
        "This URI is removed in the next minor release.",
      mimeType: JSON_MIME,
    },
    (uri, variables) => {
      if (!legacyProfileSchemaWarned) {
        legacyProfileSchemaWarned = true;
        logger.warn(
          `Resource URI ${LEGACY_PROFILE_SCHEMA_TEMPLATE} is deprecated; use ${PROFILE_SCHEMA_TEMPLATE}.`,
          { uri: uri.href },
        );
      }
      return readProfileSchema(uri, variables);
    },
  );
}

/** M-7 (B13): the per-profile schema template; profiles get their own segment. */
export const PROFILE_SCHEMA_TEMPLATE =
  "servicenow://profiles/{profile}/schema/{table}";

/** M-7 (B13): the v2 per-profile template, aliased for one minor cycle. */
export const LEGACY_PROFILE_SCHEMA_TEMPLATE =
  "servicenow://{profile}/schema/{table}";

let legacyProfileSchemaWarned = false;

/** The v3 URI of one table's schema on one profile. */
export function profileSchemaUri(profile: string, table: string): string {
  return `servicenow://profiles/${profile}/schema/${table}`;
}

/** M-4: `{profile}` completes profiles; `{table}` uses that profile's cache. */
const profileSchemaCompletions = {
  profile: (value: string) => completeProfile(value),
  table: (value: string, context?: { arguments?: Record<string, string> }) =>
    completeTable(value, context?.arguments?.profile),
};

/** Read one table's schema through the named profile (both templates). */
async function readProfileSchema(
  uri: URL,
  variables: Record<string, string | string[]>,
) {
  const profile = one(variables.profile)?.toLowerCase();
  const table = one(variables.table);
  try {
    if (!profile || !table) {
      throw badUri(
        "URI must be servicenow://profiles/<profile>/schema/<table>.",
      );
    }
    if (!listProfiles().includes(profile)) {
      throw new IntegrationError(
        `Unknown connection profile "${profile}". Available: ${listProfiles().join(", ") || "(none)"}.`,
        undefined,
        undefined,
        { code: "UNKNOWN_PROFILE" },
      );
    }
    const columns = await runWithProfile(profile, () => describeTable(table));
    return jsonContents(uri, {
      profile,
      table,
      count: columns.length,
      columns,
    });
  } catch (error) {
    throw resourceError("profile schema", error, { profile, table });
  }
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
      // M-2: no fixed mimeType — the store holds `.md` (text/markdown) and
      // `.json` (application/json) documents; each listed entry and each
      // read declares its own (docsMime / docsRead agree on the extension).
      description:
        "A Markdown or JSON document (or an exported .jsonl/.csv/.mmd file) from the local docs store, wrapped in an untrusted-content boundary. URI: servicenow://docs/<path>.",
    },
    async (uri, variables) => {
      const raw = variables.path;
      let docPath = Array.isArray(raw) ? raw.join("/") : raw;
      try {
        if (!docPath) throw badUri("No document path specified in the URI.");
        docPath = decodeURIComponent(docPath);
        // N-65: the files a file delivery links (resource_link) read here too.
        const { content, mimeType } = await docsRead(docPath, {
          deliveries: true,
        });
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
        throw resourceError("docs", error, { path: docPath });
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
