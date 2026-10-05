/**
 * N-30 (UX-16 … UX-20) — workspace coverage for `explain_ui_experience`:
 *
 * - declarative actions (`sys_declarative_action_assignment`) on the tables
 *   the workspace shows, with their model (list / form), position, record
 *   conditions and what they run (client action payload, component, server
 *   or client script);
 * - the app shell and chrome, decoded from the `chrome_toolbar`,
 *   `chrome_header`, `chrome_tab` and `chrome_footer` page properties (the
 *   shapes the SDK workspace plugin writes);
 * - a UX form view per table: form action layouts plus the action bar,
 *   related-item and contextual side panel actions;
 * - the themes linked through `m2m_app_theme`;
 * - Agent Workspace vs Configurable Workspace, with the Agent Workspace
 *   pieces of the scope that have no Configurable Workspace counterpart.
 *
 * Every table and field here is verified:false until O-5. Field names of
 * `sys_declarative_action_assignment` come from the SDK table definition;
 * `m2m_app_theme`, the `sys_aw_*` tables and the model / payload definition
 * fields are not in the SDK inventory and are guesses. A read that may ignore
 * an unknown field (and so return every row) is filtered again here.
 */
import { snString } from "./shared.js";
import { readEncodedQuery, type EncodedQueryTerm } from "./query-explain.js";
import type { SnRecord } from "./table.js";

/** The bounded readers of explain_ui_experience (degrading, caveat-noting). */
export interface WorkspaceIo {
  read(table: string, query: string, fields: string[]): Promise<SnRecord[]>;
  readIn(
    table: string,
    field: string,
    ids: Iterable<string>,
    fields: string[],
    opts?: { order?: string; prefix?: string },
  ): Promise<SnRecord[]>;
}

export const WORKSPACE_CAVEAT =
  "Workspace coverage (N-30) is unverified (gate O-5): declarative action fields come from the SDK table definition; m2m_app_theme, sys_aw_master_config, sys_aw_list and the action model / payload definition fields are not in the SDK inventory. Actions are found by the tables of the workspace's lists, form action layouts and new-tab menu; dedicated UX form config and side panel tables are not read (the form view is built from action positions).";

/** The experience category the SDK gives every workspace (unified navigation). */
export const WORKSPACE_CATEGORY = "afb4e3e173322010f0ca1e666bf6a726";

/** Page properties that hold the workspace chrome (SDK workspace plugin). */
export const CHROME_PROPERTIES = [
  "chrome_toolbar",
  "chrome_header",
  "chrome_tab",
  "chrome_footer",
] as const;

const SAFE_TABLE = /^[a-z0-9_]{1,80}$/;

export interface UxChromeItem {
  id?: string;
  label?: string;
  icon?: string;
  route?: string;
  group?: string;
  order?: number;
}

export interface UxShell {
  root_macroponent?: string;
  name?: string;
  category?: string;
  /** chrome_toolbar: the side toolbar items. */
  toolbar: UxChromeItem[];
  /** chrome_header: header switches and global tools. */
  header?: {
    searchEnabled?: boolean;
    userPrefsEnabled?: boolean;
    menuEnabled?: boolean;
    globalTools: UxChromeItem[];
  };
  /** chrome_tab: record tabs and the tables of the new-tab menu. */
  tabs?: {
    contextual: string[];
    newTabTables: string[];
    maxMainTabLimit?: number;
    maxTotalSubTabLimit?: number;
  };
  footer: boolean;
  /** Chrome properties whose JSON had an unknown shape. */
  undecoded: string[];
}

export interface UxActionTarget {
  field: string;
  table: string;
  sys_id: string;
  name?: string;
}

export interface UxDeclarativeAction {
  sys_id: string;
  action_name?: string;
  label?: string;
  table?: string;
  active?: string;
  order: number;
  /** "list" or "form" from the action model name, when it tells. */
  surface?: string;
  model?: string;
  /** declarative_action_type ("Implemented as"). */
  implementation?: string;
  /** What the action runs: payload, component, action definition. */
  runs: UxActionTarget[];
  form_position?: string;
  button_type?: string;
  record_selection_required?: string;
  record_conditions?: string;
  conditionTerms?: EncodedQueryTerm[];
  required_roles: string[];
  /** sys_aw_master_config the action is restricted to (legacy Agent Workspace). */
  agentWorkspace?: string;
  experience_restricted?: string;
}

/** The UX form of one table: layouts and positioned actions (labels). */
export interface UxFormView {
  table: string;
  formActionLayouts: string[];
  actionBar: string[];
  relatedItems: string[];
  sidePanel: string[];
}

export interface UxTheme {
  sys_id: string;
  name?: string;
  link: string;
  order?: number;
}

export interface UxWorkspaceClass {
  kind: "configurable" | "agent" | "mixed" | "unknown";
  signals: { kind: "configurable" | "agent"; signal: string }[];
  /** Agent Workspace pieces of the scope and their Configurable counterpart. */
  migration: {
    table: string;
    sys_id: string;
    name?: string;
    counterpart?: string;
  }[];
}

const str = (row: SnRecord, field: string): string => snString(row[field]);
const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;
const flag = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

/** A label as a string or `{ translatable, message }`. */
function labelOf(v: unknown): string | undefined {
  return text(v) ?? text(record(v)?.message) ?? text(record(v)?.label);
}

/** One chrome menu item; null when the value is not an object. */
function chromeItem(v: unknown): UxChromeItem | null {
  const r = record(v);
  if (!r) return null;
  const route = text(record(r.routeInfo)?.route) ?? text(r.route);
  const order = typeof r.order === "number" ? r.order : undefined;
  const item: UxChromeItem = {
    ...(text(r.id) ? { id: text(r.id) } : {}),
    ...(labelOf(r.label) ? { label: labelOf(r.label) } : {}),
    ...(text(r.icon) ? { icon: text(r.icon) } : {}),
    ...(route ? { route } : {}),
    ...(text(r.group) ? { group: text(r.group) } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  return item;
}

const chromeItems = (v: unknown): UxChromeItem[] =>
  Array.isArray(v)
    ? v.map(chromeItem).filter((i): i is UxChromeItem => i !== null)
    : [];

/**
 * Decode the shell from the root macroponent and the chrome page properties
 * (values already JSON-decoded). Null when the experience has neither.
 */
export function decodeShell(
  properties: { name: string; value?: unknown }[],
  root?: { sys_id: string; name?: string; category?: string },
): UxShell | null {
  const byName = new Map(properties.map((p) => [p.name, p.value] as const));
  const present = CHROME_PROPERTIES.filter((n) => byName.has(n));
  if (!root && !present.length) return null;
  const shell: UxShell = {
    ...(root ? { root_macroponent: root.sys_id } : {}),
    ...(root?.name ? { name: root.name } : {}),
    ...(root?.category ? { category: root.category } : {}),
    toolbar: [],
    footer: byName.has("chrome_footer"),
    undecoded: [],
  };
  if (byName.has("chrome_toolbar")) {
    const v = byName.get("chrome_toolbar");
    if (Array.isArray(v)) {
      shell.toolbar = chromeItems(v).sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      );
    } else shell.undecoded.push("chrome_toolbar");
  }
  if (byName.has("chrome_header")) {
    const v = record(byName.get("chrome_header"));
    const priv = record(v?.privatePage);
    const pub = record(v?.publicPage);
    if (priv || pub) {
      const tools = record(priv?.globalTools);
      shell.header = {
        ...(flag(priv?.searchEnabled) !== undefined
          ? { searchEnabled: flag(priv?.searchEnabled) }
          : {}),
        ...(flag(priv?.userPrefsEnabled) !== undefined
          ? { userPrefsEnabled: flag(priv?.userPrefsEnabled) }
          : {}),
        ...(flag(pub?.menuEnabled) !== undefined
          ? { menuEnabled: flag(pub?.menuEnabled) }
          : {}),
        globalTools: [
          ...chromeItems(tools?.primaryItems),
          ...chromeItems(tools?.secondaryItems),
        ],
      };
    } else shell.undecoded.push("chrome_header");
  }
  if (byName.has("chrome_tab")) {
    const v = record(byName.get("chrome_tab"));
    if (v && (Array.isArray(v.newTabMenu) || Array.isArray(v.contextual))) {
      const menu = Array.isArray(v.newTabMenu) ? v.newTabMenu : [];
      shell.tabs = {
        contextual: Array.isArray(v.contextual)
          ? v.contextual.filter((c): c is string => typeof c === "string")
          : [],
        newTabTables: menu
          .map((m) => text(record(record(record(m)?.routeInfo)?.fields)?.table))
          .filter((t): t is string => !!t),
        ...(typeof v.maxMainTabLimit === "number"
          ? { maxMainTabLimit: v.maxMainTabLimit }
          : {}),
        ...(typeof v.maxTotalSubTabLimit === "number"
          ? { maxTotalSubTabLimit: v.maxTotalSubTabLimit }
          : {}),
      };
    } else shell.undecoded.push("chrome_tab");
  }
  return shell;
}

/** A `sys_ux_list.columns` value as a list of field names. */
export const listColumns = (raw: string): string[] =>
  raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

const ACTION_FIELDS = [
  "sys_id",
  "action_name",
  "label",
  "table",
  "active",
  "order",
  "model",
  "declarative_action_type",
  "client_action",
  "action",
  "ui_component",
  "record_conditions",
  "record_selection_required",
  "form_position",
  "button_type",
  "workspace",
  "experience_restricted",
  "required_roles",
];

/** Reference fields of an assignment that name what it runs. */
const RUN_FIELDS: { field: string; table: string }[] = [
  {
    field: "client_action",
    table: "sys_declarative_action_payload_definition",
  },
  { field: "action", table: "sys_declarative_action_definition" },
  { field: "ui_component", table: "sys_ux_lib_component" },
];

/** List or form, from an action model name (e.g. "Record List", "Form"). */
function surfaceOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (/list/i.test(name)) return "list";
  if (/form|record/i.test(name)) return "form";
  return undefined;
}

/**
 * Run-target name reads: assignment field, table, name fields in order of
 * preference. `sys_declarative_action_definition` and its fields are not in
 * the SDK inventory (O-5: unverified).
 */
const RUN_NAME_READS: readonly (readonly [string, string, string[]])[] = [
  [
    "client_action",
    "sys_declarative_action_payload_definition",
    ["label", "key"],
  ],
  ["action", "sys_declarative_action_definition", ["label", "action_name"]],
  ["ui_component", "sys_ux_lib_component", ["name", "tag"]],
];

/**
 * Declarative action assignments on `tables`, with their model, payload,
 * action definition and UI component names resolved. Rows on other tables
 * (an ignored filter) are dropped.
 */
export async function readDeclarativeActions(
  io: WorkspaceIo,
  tables: Iterable<string>,
): Promise<UxDeclarativeAction[]> {
  const wanted = new Set([...tables].filter((t) => SAFE_TABLE.test(t)));
  if (!wanted.size) return [];
  const rows = (
    await io.readIn(
      "sys_declarative_action_assignment",
      "table",
      wanted,
      ACTION_FIELDS,
      { order: "order" },
    )
  ).filter((r) => wanted.has(str(r, "table")));
  if (!rows.length) return [];
  const models = new Map<string, string>();
  for (const m of await io.readIn(
    "sys_declarative_action_model_definition",
    "sys_id",
    rows.map((r) => str(r, "model")).filter(Boolean),
    ["sys_id", "name"],
  )) {
    if (opt(m, "name")) models.set(str(m, "sys_id"), str(m, "name"));
  }
  // The name of what each assignment runs: the client action payload, and
  // (N-30) the server action definition and the UI component, each read
  // only when an assignment references one. The definition's `label` /
  // `action_name` fields are unverified until O-5.
  const runNames = new Map<string, string>();
  for (const [field, table, fields] of RUN_NAME_READS) {
    for (const p of await io.readIn(
      table,
      "sys_id",
      rows.map((r) => str(r, field)).filter(Boolean),
      ["sys_id", ...fields],
    )) {
      const name = fields.map((f) => opt(p, f)).find(Boolean);
      if (name) runNames.set(`${field}:${str(p, "sys_id")}`, name);
    }
  }
  return rows.map((r) => {
    const modelName = models.get(str(r, "model"));
    const surface =
      surfaceOf(modelName) ?? (opt(r, "form_position") ? "form" : undefined);
    const conditions = str(r, "record_conditions");
    const read = conditions ? readEncodedQuery(conditions) : undefined;
    const order = Number(str(r, "order"));
    return {
      sys_id: str(r, "sys_id"),
      ...(opt(r, "action_name") ? { action_name: opt(r, "action_name") } : {}),
      ...(opt(r, "label") ? { label: opt(r, "label") } : {}),
      ...(opt(r, "table") ? { table: opt(r, "table") } : {}),
      ...(opt(r, "active") ? { active: opt(r, "active") } : {}),
      order: Number.isFinite(order) ? order : 0,
      ...(surface ? { surface } : {}),
      ...(opt(r, "model") ? { model: modelName ?? opt(r, "model") } : {}),
      ...(opt(r, "declarative_action_type")
        ? { implementation: opt(r, "declarative_action_type") }
        : {}),
      runs: RUN_FIELDS.filter((f) => opt(r, f.field)).map((f) => {
        const sysId = str(r, f.field);
        const name = runNames.get(`${f.field}:${sysId}`);
        return {
          field: f.field,
          table: f.table,
          sys_id: sysId,
          ...(name ? { name } : {}),
        };
      }),
      ...(opt(r, "form_position")
        ? { form_position: opt(r, "form_position") }
        : {}),
      ...(opt(r, "button_type") ? { button_type: opt(r, "button_type") } : {}),
      ...(opt(r, "record_selection_required")
        ? { record_selection_required: opt(r, "record_selection_required") }
        : {}),
      ...(conditions ? { record_conditions: conditions } : {}),
      ...(read?.terms.length ? { conditionTerms: read.terms } : {}),
      required_roles: str(r, "required_roles")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      ...(opt(r, "workspace") ? { agentWorkspace: opt(r, "workspace") } : {}),
      ...(opt(r, "experience_restricted")
        ? { experience_restricted: opt(r, "experience_restricted") }
        : {}),
    };
  });
}

/** form_position values (SDK choices; `contexual_sidebar` is spelled so). */
const POSITIONS: Record<
  string,
  keyof Omit<UxFormView, "table" | "formActionLayouts">
> = {
  action_bar: "actionBar",
  related_item: "relatedItems",
  contexual_sidebar: "sidePanel",
  contextual_sidebar: "sidePanel",
};

/** The UX form of each table: its form action layouts and positioned actions. */
export function formViews(
  actions: UxDeclarativeAction[],
  layouts: { name?: string; sys_id: string; table?: string }[],
): UxFormView[] {
  const views = new Map<string, UxFormView>();
  const view = (table: string): UxFormView => {
    let v = views.get(table);
    if (!v) {
      v = {
        table,
        formActionLayouts: [],
        actionBar: [],
        relatedItems: [],
        sidePanel: [],
      };
      views.set(table, v);
    }
    return v;
  };
  for (const l of layouts) {
    if (l.table) view(l.table).formActionLayouts.push(l.name ?? l.sys_id);
  }
  for (const a of actions) {
    const key = a.form_position ? POSITIONS[a.form_position] : undefined;
    if (!a.table || !key) continue;
    view(a.table)[key].push(a.label ?? a.action_name ?? a.sys_id);
  }
  return [...views.values()].sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Themes linked to the experience (or its app config) through
 * `m2m_app_theme`. The link field is a guess, so rows are filtered again.
 */
export async function readThemes(
  io: WorkspaceIo,
  links: string[],
): Promise<UxTheme[]> {
  const wanted = new Set(links.filter(Boolean));
  if (!wanted.size) return [];
  const m2m = (
    await io.readIn("m2m_app_theme", "app", wanted, [
      "sys_id",
      "app",
      "theme",
      "order",
    ])
  ).filter((r) => wanted.has(str(r, "app")) && opt(r, "theme"));
  if (!m2m.length) return [];
  const names = new Map<string, string>();
  for (const t of await io.readIn(
    "sys_ux_theme",
    "sys_id",
    m2m.map((r) => str(r, "theme")),
    ["sys_id", "name"],
  )) {
    if (opt(t, "name")) names.set(str(t, "sys_id"), str(t, "name"));
  }
  return m2m.map((r) => {
    const order = Number(str(r, "order"));
    return {
      sys_id: str(r, "theme"),
      ...(names.has(str(r, "theme"))
        ? { name: names.get(str(r, "theme")) }
        : {}),
      link: str(r, "sys_id"),
      ...(str(r, "order") && Number.isFinite(order) ? { order } : {}),
    };
  });
}

export interface ClassifyInput {
  path?: string;
  categories: string[];
  propertyNames: string[];
  routes: number;
  actions: UxDeclarativeAction[];
  /** sys_aw_master_config rows of the scope. */
  awConfigs: SnRecord[];
  /** sys_aw_list rows of the scope. */
  awLists: SnRecord[];
  /** Tables of the experience's UX lists. */
  uxListTables: string[];
  experienceName?: string;
}

/** Agent Workspace vs Configurable Workspace, with the migration list. */
export function classifyWorkspace(input: ClassifyInput): UxWorkspaceClass {
  const signals: UxWorkspaceClass["signals"] = [];
  if (input.categories.includes(WORKSPACE_CATEGORY)) {
    signals.push({
      kind: "configurable",
      signal:
        "in the workspace experience category (sys_ux_registry_m2m_category)",
    });
  }
  const chrome = input.propertyNames.filter(
    (n) =>
      (CHROME_PROPERTIES as readonly string[]).includes(n) ||
      n === "listConfigId",
  );
  if (chrome.length) {
    signals.push({
      kind: "configurable",
      signal: `workspace page properties: ${chrome.join(", ")}`,
    });
  }
  if (input.routes && (input.categories.length || chrome.length)) {
    signals.push({
      kind: "configurable",
      signal: `${input.routes} UI Builder route(s)`,
    });
  }
  if (input.path && /(^|\/)workspace\//.test(input.path)) {
    signals.push({
      kind: "agent",
      signal: `path '${input.path}' is under workspace/ (the Agent Workspace URL form)`,
    });
  }
  const restricted = input.actions.filter((a) => a.agentWorkspace);
  if (restricted.length) {
    signals.push({
      kind: "agent",
      signal: `${restricted.length} declarative action(s) restricted to an Agent Workspace (sys_aw_master_config)`,
    });
  }
  if (input.awConfigs.length) {
    signals.push({
      kind: "agent",
      signal: `${input.awConfigs.length} Agent Workspace config(s) in the scope (sys_aw_master_config)`,
    });
  }
  const has = (k: "configurable" | "agent") =>
    signals.some((s) => s.kind === k);
  const kind =
    has("configurable") && has("agent")
      ? "mixed"
      : has("configurable")
        ? "configurable"
        : has("agent")
          ? "agent"
          : "unknown";

  const configurable = has("configurable");
  const uxTables = new Set(input.uxListTables);
  const openActions = new Set(
    input.actions
      .filter((a) => !a.agentWorkspace && a.action_name)
      .map((a) => `${a.table}:${a.action_name}`),
  );
  const migration: UxWorkspaceClass["migration"] = [
    ...input.awConfigs.map((r) => ({
      table: "sys_aw_master_config",
      sys_id: str(r, "sys_id"),
      ...(opt(r, "name") ? { name: opt(r, "name") } : {}),
      ...(configurable
        ? { counterpart: input.experienceName ?? "this experience" }
        : {}),
    })),
    ...input.awLists.map((r) => ({
      table: "sys_aw_list",
      sys_id: str(r, "sys_id"),
      ...(opt(r, "title") ? { name: opt(r, "title") } : {}),
      ...(opt(r, "table") && uxTables.has(str(r, "table"))
        ? { counterpart: `sys_ux_list on ${str(r, "table")}` }
        : {}),
    })),
    ...restricted.map((a) => ({
      table: "sys_declarative_action_assignment",
      sys_id: a.sys_id,
      ...(a.label || a.action_name ? { name: a.label ?? a.action_name } : {}),
      ...(openActions.has(`${a.table}:${a.action_name}`)
        ? { counterpart: `unrestricted ${a.action_name} on ${a.table}` }
        : {}),
    })),
  ];
  return { kind, signals, migration };
}

/** Encoded-query terms as one readable line. */
export function conditionText(terms: EncodedQueryTerm[]): string {
  let out = "";
  let block = 0;
  terms.forEach((t, i) => {
    const cond = `${t.field} ${t.operator}${t.value ? ` ${t.value}` : ""}`;
    if (i === 0) out = cond;
    else if (t.block !== block) out += ` | NQ | ${cond}`;
    else out += ` ${t.or ? "OR" : "AND"} ${cond}`;
    block = t.block;
  });
  return out;
}

const itemText = (i: UxChromeItem): string =>
  `${i.label ?? i.id ?? "?"}${i.route ? ` → ${i.route}` : ""}`;

/** The N-30 markdown section of uiExperienceMarkdown. */
export function workspaceLines(
  result: {
    shell: UxShell | null;
    actions: UxDeclarativeAction[];
    forms: UxFormView[];
    themes: UxTheme[];
    workspace: UxWorkspaceClass;
  },
  out: string[],
): void {
  const w = result.workspace;
  if (
    !result.shell &&
    !result.actions.length &&
    !result.themes.length &&
    !w.signals.length &&
    !w.migration.length
  ) {
    return;
  }
  out.push("## Workspace", "", `Kind: **${w.kind}**`);
  for (const s of w.signals) out.push(`- ${s.kind}: ${s.signal}`);
  const sh = result.shell;
  if (sh) {
    out.push(
      "",
      `Shell: ${sh.name ?? sh.root_macroponent ?? "(no root macroponent)"}${sh.category ? ` (${sh.category})` : ""}`,
    );
    if (sh.toolbar.length) {
      out.push(`- Toolbar: ${sh.toolbar.map(itemText).join(", ")}`);
    }
    if (sh.header) {
      const on = (["searchEnabled", "userPrefsEnabled", "menuEnabled"] as const)
        .filter((k) => sh.header![k] !== undefined)
        .map((k) => `${k} ${sh.header![k]}`);
      out.push(
        `- Header: ${[...on, ...(sh.header.globalTools.length ? [`global tools ${sh.header.globalTools.map(itemText).join(", ")}`] : [])].join(" · ") || "(empty)"}`,
      );
    }
    if (sh.tabs) {
      out.push(
        `- Tabs: contextual ${sh.tabs.contextual.join(", ") || "none"} · new-tab tables ${sh.tabs.newTabTables.join(", ") || "none"}`,
      );
    }
    if (sh.footer) out.push("- Footer: configured");
    for (const n of sh.undecoded) out.push(`- _${n} has an unknown shape_`);
  }
  if (result.themes.length) {
    out.push(
      "",
      `Themes: ${result.themes.map((t) => t.name ?? t.sys_id).join(", ")}`,
    );
  }
  if (result.forms.length) {
    out.push("", "### Forms", "");
    for (const f of result.forms) {
      const parts = [
        ...(f.formActionLayouts.length
          ? [`layouts ${f.formActionLayouts.join(", ")}`]
          : []),
        ...(f.actionBar.length ? [`action bar ${f.actionBar.join(", ")}`] : []),
        ...(f.relatedItems.length
          ? [`related items ${f.relatedItems.join(", ")}`]
          : []),
        ...(f.sidePanel.length ? [`side panel ${f.sidePanel.join(", ")}`] : []),
      ];
      out.push(`- **${f.table}**: ${parts.join(" · ")}`);
    }
  }
  if (result.actions.length) {
    out.push("", "### Declarative actions", "");
    for (const a of result.actions) {
      const runs = a.runs.map((r) => r.name ?? `${r.table} ${r.sys_id}`);
      out.push(
        `- ${a.table ?? "?"} · ${a.surface ?? "?"}${a.form_position ? ` (${a.form_position})` : ""}: **${a.label ?? a.action_name ?? a.sys_id}**${
          a.implementation ? ` · ${a.implementation}` : ""
        }${runs.length ? ` → ${runs.join(", ")}` : ""}${
          a.conditionTerms?.length
            ? ` · when ${conditionText(a.conditionTerms)}`
            : ""
        }${a.required_roles.length ? ` · roles ${a.required_roles.join(", ")}` : ""}${
          a.agentWorkspace ? " · Agent Workspace only" : ""
        }${a.active === "false" ? " _(inactive)_" : ""}`,
      );
    }
  }
  if (w.migration.length) {
    out.push("", "### Agent Workspace migration", "");
    for (const m of w.migration) {
      out.push(
        `- ${m.table}: ${m.name ?? m.sys_id} → ${m.counterpart ?? "_no Configurable Workspace counterpart_"}`,
      );
    }
  }
  out.push("");
}
