import { artifactTypeCatalog } from "./artifacts.js";
import {
  caveatsSection,
  cell,
  code,
  type CollectOptions,
  type RenderContext,
  tableOrNone,
} from "./doc-shared.js";

/**
 * Artifact types document (ID-29): the registry, with what this run collected.
 */

export interface CatalogTypeEntry {
  type: string;
  group: string;
  table: string;
  sdkApi: string;
  verified: boolean;
}

export interface ArtifactTypesDocData {
  count: number;
  note: string;
  types: {
    type: string;
    group: string;
    table: string;
    sdkApi: string;
    verified: boolean;
    collected: boolean;
  }[];
}

export function collectArtifactTypes(
  opts: CollectOptions,
): Promise<ArtifactTypesDocData> {
  const catalog = artifactTypeCatalog() as {
    count: number;
    note: string;
    types: CatalogTypeEntry[];
  };
  const collected = opts.instance?.collected ?? new Set<string>();
  return Promise.resolve({
    count: catalog.count,
    note: catalog.note,
    types: catalog.types.map((t) => ({
      type: t.type,
      group: t.group,
      table: t.table,
      sdkApi: t.sdkApi,
      verified: t.verified,
      collected: collected.has(t.table),
    })),
  });
}

/** Render the artifact-types document (pure: same data, same bytes). */
export function renderArtifactTypes(
  data: ArtifactTypesDocData,
  ctx: RenderContext,
): string {
  const collected = data.types.filter((t) => t.collected).length;
  return [
    `# Artifact types — profile ${code(ctx.profile)}`,
    "",
    "The artefact types this server knows (servicenow_artifact_types), and which of them this documentation run collected (the timestamp is in the frontmatter).",
    "",
    `- **Types:** ${data.count}`,
    `- **Collected in this run:** ${collected}`,
    "",
    "## Types",
    "",
    "`Collected in this run` is yes when a document of this run holds at least one record from the type's table.",
    "",
    tableOrNone(
      [
        "Type",
        "Group",
        "Table",
        "SDK API",
        "Verified",
        "Collected in this run",
      ],
      data.types.map((t) => [
        code(t.type),
        t.group,
        code(t.table),
        cell(t.sdkApi),
        t.verified ? "yes" : "no",
        t.collected ? "yes" : "no",
      ]),
    ),
    "",
    ...caveatsSection([
      data.note,
      "A type not collected may simply have no records, be outside the documented tables and applications, or be hidden from this user.",
    ]),
  ].join("\n");
}
