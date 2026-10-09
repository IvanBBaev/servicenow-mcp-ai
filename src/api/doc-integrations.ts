import {
  caveatsSection,
  cell,
  code,
  codeOf,
  METADATA_CAVEAT,
  PURPOSE_BLOCK,
  readCaveats,
  readSection,
  type RenderContext,
  type SectionRead,
  sectionTable,
  VISIBILITY_CAVEAT,
  yesNo,
} from "./doc-shared.js";

/**
 * Integrations document (inbound REST, outbound REST, import).
 */

export interface IntegrationsDocData {
  restApis: SectionRead;
  restMessages: SectionRead;
  transformMaps: SectionRead;
  dataSources: SectionRead;
}

/**
 * Only descriptive fields are read: no endpoints' credentials, no scripts,
 * no connection strings (a data source's `connection_url` and credentials
 * stay out of the document).
 */
export async function collectIntegrations(): Promise<IntegrationsDocData> {
  const restApis = await readSection(
    "sys_ws_definition",
    ["name", "namespace", "base_uri", "active", "sys_scope.scope"],
    "ORDERBYname",
  );
  const restMessages = await readSection(
    "sys_rest_message",
    ["name", "rest_endpoint", "authentication_type", "sys_scope.scope"],
    "ORDERBYname",
  );
  const transformMaps = await readSection(
    "sys_transform_map",
    [
      "name",
      "source_table",
      "target_table",
      "active",
      "run_business_rules",
      "sys_scope.scope",
    ],
    "ORDERBYname",
  );
  const dataSources = await readSection(
    "sys_data_source",
    ["name", "type", "import_set_table_name", "format", "sys_scope.scope"],
    "ORDERBYname",
  );
  return { restApis, restMessages, transformMaps, dataSources };
}

/** Render the integrations document (pure: same data, same bytes). */
export function renderIntegrations(
  data: IntegrationsDocData,
  ctx: RenderContext,
): string {
  const { restApis, restMessages, transformMaps, dataSources } = data;
  const scope = (r: Record<string, string>): string =>
    codeOf(r["sys_scope.scope"]);
  const lines: string[] = [
    `# Integrations — profile ${code(ctx.profile)}`,
    "",
    "Generated from the integration definitions (sys_ws_definition, sys_rest_message, sys_transform_map, sys_data_source; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Scripted REST APIs:** ${restApis.rows.length}`,
    `- **Outbound REST messages:** ${restMessages.rows.length}`,
    `- **Transform maps:** ${transformMaps.rows.length}`,
    `- **Data sources:** ${dataSources.rows.length}`,
    "",
    ...PURPOSE_BLOCK,
    "## Inbound — scripted REST APIs",
    "",
    sectionTable(
      restApis,
      ["Name", "Namespace", "Base URI", "Active", "Scope"],
      restApis.rows.map((r) => [
        cell(r.name),
        codeOf(r.namespace),
        codeOf(r.base_uri),
        yesNo(r.active),
        scope(r),
      ]),
    ),
    "",
    "## Outbound — REST messages",
    "",
    sectionTable(
      restMessages,
      ["Name", "Endpoint", "Authentication", "Scope"],
      restMessages.rows.map((r) => [
        cell(r.name),
        code(cell(r.rest_endpoint)),
        cell(r.authentication_type),
        scope(r),
      ]),
    ),
    "",
    "## Import — transform maps",
    "",
    sectionTable(
      transformMaps,
      [
        "Name",
        "Source table",
        "Target table",
        "Active",
        "Runs business rules",
        "Scope",
      ],
      transformMaps.rows.map((r) => [
        cell(r.name),
        codeOf(r.source_table),
        codeOf(r.target_table),
        yesNo(r.active),
        yesNo(r.run_business_rules),
        scope(r),
      ]),
    ),
    "",
    "## Import — data sources",
    "",
    sectionTable(
      dataSources,
      ["Name", "Type", "Import set table", "Format", "Scope"],
      dataSources.rows.map((r) => [
        cell(r.name),
        cell(r.type),
        codeOf(r.import_set_table_name),
        cell(r.format),
        scope(r),
      ]),
    ),
    "",
    ...caveatsSection([
      ...readCaveats([restApis, restMessages, transformMaps, dataSources]),
      "Descriptive fields only: credentials, connection strings and scripts of these definitions are not read.",
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  ];
  return lines.join("\n");
}
