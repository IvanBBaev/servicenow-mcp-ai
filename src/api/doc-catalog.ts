import { mdTable } from "./shared.js";
import {
  byOrderThenName,
  caveatsSection,
  cell,
  code,
  codeOf,
  METADATA_CAVEAT,
  NOT_READABLE,
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
 * Catalog document (catalogs → categories → items → variables).
 */

export interface CatalogDocData {
  catalogs: SectionRead;
  categories: SectionRead;
  items: SectionRead;
  variables: SectionRead;
}

/** Catalog variable types (item_option_new.type) by their stored number. */
const VARIABLE_TYPES: Record<string, string> = {
  "1": "Yes/No",
  "2": "Multi line text",
  "3": "Multiple choice",
  "4": "Numeric scale",
  "5": "Select box",
  "6": "Single line text",
  "7": "Checkbox",
  "8": "Reference",
  "9": "Date",
  "10": "Date/Time",
  "11": "Label",
  "12": "Break",
  "14": "Macro",
  "15": "UI Page",
  "16": "Wide single line text",
  "17": "Macro with label",
  "18": "Lookup select box",
  "19": "Container start",
  "20": "Container end",
  "21": "List collector",
  "22": "Lookup multiple choice",
  "23": "HTML",
  "24": "Container split",
  "25": "Masked",
  "26": "Email",
  "27": "URL",
  "28": "IP address",
  "29": "Duration",
  "31": "Requested for",
  "32": "Rich text label",
  "33": "Attachment",
};

export async function collectCatalog(): Promise<CatalogDocData> {
  const catalogs = await readSection(
    "sc_catalog",
    ["sys_id", "title", "active"],
    "ORDERBYtitle",
  );
  const categories = await readSection(
    "sc_category",
    ["sys_id", "title", "sc_catalog", "parent", "active"],
    "ORDERBYtitle",
  );
  const items = await readSection(
    "sc_cat_item",
    ["sys_id", "name", "sys_class_name", "active", "category", "sc_catalogs"],
    "ORDERBYname",
  );
  const variables = await readSection(
    "item_option_new",
    [
      "sys_id",
      "name",
      "question_text",
      "type",
      "cat_item",
      "order",
      "mandatory",
      "active",
    ],
    "cat_itemISNOTEMPTY^ORDERBYorder",
  );
  return { catalogs, categories, items, variables };
}

/** Render the catalog document (pure: same data, same bytes). */
export function renderCatalog(
  data: CatalogDocData,
  ctx: RenderContext,
): string {
  const { catalogs, categories, items, variables } = data;
  const catalogTitle = new Map(
    catalogs.rows.map((c) => [c.sys_id, c.title || c.sys_id]),
  );
  const categoryTitle = new Map(
    categories.rows.map((c) => [c.sys_id, c.title || c.sys_id]),
  );
  const itemCatalogs = (i: Record<string, string>): string =>
    (i.sc_catalogs ?? "")
      .split(",")
      .filter(Boolean)
      .map((id) => catalogTitle.get(id) ?? id)
      .join(", ");
  const lines: string[] = [
    `# Service catalog — profile ${code(ctx.profile)}`,
    "",
    "Generated from the catalog definitions (sc_catalog, sc_category, sc_cat_item, item_option_new; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Catalogs:** ${catalogs.rows.length}`,
    `- **Categories:** ${categories.rows.length}`,
    `- **Items:** ${items.rows.length}`,
    `- **Item variables:** ${variables.rows.length}`,
    "",
    ...PURPOSE_BLOCK,
    "## Catalogs",
    "",
    sectionTable(
      catalogs,
      ["Catalog", "Active", "Categories", "Items"],
      catalogs.rows.map((c) => [
        cell(c.title),
        yesNo(c.active),
        String(categories.rows.filter((x) => x.sc_catalog === c.sys_id).length),
        String(
          items.rows.filter((i) =>
            (i.sc_catalogs ?? "").split(",").includes(c.sys_id ?? ""),
          ).length,
        ),
      ]),
    ),
    "",
    "## Categories",
    "",
    sectionTable(
      categories,
      ["Category", "Catalog", "Parent", "Active"],
      categories.rows.map((c) => [
        cell(c.title),
        cell(catalogTitle.get(c.sc_catalog) ?? c.sc_catalog),
        cell(c.parent ? (categoryTitle.get(c.parent) ?? c.parent) : ""),
        yesNo(c.active),
      ]),
    ),
    "",
    "## Items",
    "",
    sectionTable(
      items,
      ["Item", "Class", "Category", "Catalogs", "Active", "Variables"],
      items.rows.map((i) => [
        cell(i.name),
        codeOf(i.sys_class_name),
        cell(i.category ? (categoryTitle.get(i.category) ?? i.category) : ""),
        cell(itemCatalogs(i)),
        yesNo(i.active),
        String(variables.rows.filter((v) => v.cat_item === i.sys_id).length),
      ]),
    ),
    "",
    "## Variables",
    "",
  ];
  if (variables.unreadable) {
    lines.push(NOT_READABLE, "");
  } else {
    const itemName = new Map(items.rows.map((i) => [i.sys_id, i.name]));
    const byItem = new Map<string, Record<string, string>[]>();
    for (const v of variables.rows) {
      const item = v.cat_item ?? "";
      const list = byItem.get(item) ?? [];
      list.push(v);
      byItem.set(item, list);
    }
    const itemIds = [...byItem.keys()].sort((a, b) =>
      (itemName.get(a) ?? a).localeCompare(itemName.get(b) ?? b),
    );
    if (!itemIds.length) lines.push("_None._", "");
    for (const id of itemIds) {
      lines.push(
        `### ${cell(itemName.get(id) ?? id)}`,
        "",
        mdTable(
          ["Order", "Name", "Question", "Type", "Mandatory", "Active"],
          (byItem.get(id) ?? [])
            .sort(byOrderThenName)
            .map((v) => [
              v.order ?? "",
              codeOf(v.name),
              cell(v.question_text),
              VARIABLE_TYPES[v.type ?? ""] ?? v.type ?? "",
              yesNo(v.mandatory),
              yesNo(v.active),
            ]),
        ),
        "",
      );
    }
  }
  lines.push(
    ...caveatsSection([
      ...readCaveats([catalogs, categories, items, variables]),
      "Variables that come from a variable set are not listed per item; only variables attached directly to an item are.",
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}
