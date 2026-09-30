/**
 * P-28 — Portal, workspace and catalog Fluent emitters (project/SDK-PARITY.md
 * §5, P5). An extension of the P-26 core in `src/api/fluent.ts`, which calls
 * `emitUi` for every type in `UI_EMITTERS`:
 *
 * - Service Portal: `ServicePortal`, `SPPage` with its layout tree
 *   (containers → rows → columns → widget instances), `SPWidget` (template,
 *   CSS, client / server script and link as `Now.include` sidecars; Angular
 *   templates, dependencies and providers inline), `SPHeaderFooter`,
 *   `SPTheme`, `SPMenu`, `SPPageRouteMap`, `SPWidgetDependency`,
 *   `SPAngularProvider`, `JsInclude`, `CssInclude`.
 * - Next Experience: `Workspace`, `Dashboard`, `UxListMenuConfig`,
 *   `Applicability`. UI Builder internals have no Fluent API: they stay
 *   `Record()` with an `unsupported[]` entry, and a workspace references its
 *   root macroponent / app config by `Now.ref` without emitting them.
 * - Service Catalog: `CatalogItem` / `CatalogItemRecordProducer` with typed
 *   variables (and their choices), variable-set includes, categories and user
 *   criteria, followed by the `VariableSet`, `CatalogClientScript` and
 *   `CatalogUiPolicy` calls the item's form uses.
 *
 * Property names follow SDK-PARITY and the SDK baseline's API as far as it is
 * known; none is verified against the SDK (`verified: false`) until owner gate
 * O-7 and the P-29 round-trip oracle. The P-26 rules hold: every set field is
 * either emitted or reported in `unsupported[]` (never lost silently), child
 * rows that do not fit the tree are emitted as `Record()` rows, secrets become
 * the credential placeholder, and the output is deterministic.
 */
import type { ArtifactType, RefField } from "../core/artifacts/registry.js";
import type { ArtifactChildResult } from "./artifacts.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
import {
  arr,
  code,
  lit,
  obj,
  oneLine,
  render,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import {
  childOrder,
  cmp,
  convert,
  fluentSlug,
  header,
  isSecret,
  recordCall,
  recordData,
  refExpr,
  secretProp,
  setFields,
  sidecar,
  sidecarSuffix,
  type Conv,
  type EmitRun,
  type FluentSource,
} from "./fluent.js";

/** The `warnings[]` entry of a `servicenow_generate_fluent` run over a P-28 type. */
export const UI_UNVERIFIED_WARNING =
  "The portal / workspace / catalog emitter (P-28) uses property names from project/SDK-PARITY.md that are not verified against the SDK (verified: false) until owner gate O-7 and the P-29 round-trip oracle.";

const UI_NOTE =
  "P-28: property names follow project/SDK-PARITY.md and are not verified against the SDK (verified: false) until O-7 / P-29.";

const PASSTHROUGH_NOTE =
  "Property names of the unverified (U) structures below are derived from the field names (snake_case to camelCase).";

const M2M_NOTE =
  "Many-to-many rows are emitted as references; the rows' own sys_ids are not kept.";

// ---------------------------------------------------------------------------
// Property specs
// ---------------------------------------------------------------------------

type UiConv =
  | Conv
  | "json"
  | { readonly ref: string }
  | { readonly refList: string };

interface UiProp {
  prop: string;
  field: string;
  as?: UiConv;
}

const p = (field: string, prop = field): UiProp => ({ prop, field });
const b = (field: string, prop = field): UiProp => ({
  prop,
  field,
  as: "boolean",
});
const n = (field: string, prop = field): UiProp => ({
  prop,
  field,
  as: "number",
});
const s = (field: string, prop: string): UiProp => ({
  prop,
  field,
  as: "script",
});
const list = (field: string, prop = field): UiProp => ({
  prop,
  field,
  as: "list",
});
const json = (field: string, prop: string): UiProp => ({
  prop,
  field,
  as: "json",
});
const ref = (field: string, prop: string, table: string): UiProp => ({
  prop,
  field,
  as: { ref: table },
});
const refList = (field: string, prop: string, table: string): UiProp => ({
  prop,
  field,
  as: { refList: table },
});

/** Fields every widget-like record (`sp_widget`, `sp_header_footer`) carries. */
const WIDGET: UiProp[] = [
  p("id"),
  p("name"),
  p("description"),
  p("category"),
  p("data_table", "dataTable"),
  p("controller_as", "controllerAs"),
  b("public"),
  list("roles"),
  b("has_preview", "hasPreview"),
  json("option_schema", "optionSchema"),
  json("demo_data", "demoData"),
  p("field_list", "fieldList"),
  s("template", "htmlTemplate"),
  s("css", "customCss"),
  s("client_script", "clientScript"),
  s("script", "serverScript"),
  s("link", "link"),
];
const WIDGET_SHAPE = {
  clientFields: ["client_script", "link"],
  markupFields: ["template", "css"],
};
const NG_TEMPLATE: UiProp[] = [p("id"), s("template", "htmlTemplate")];

const PAGE: UiProp[] = [
  p("id", "pageId"),
  p("title"),
  p("short_description", "shortDescription"),
  b("public"),
  list("roles"),
  b("draft"),
  b("internal"),
  p("category"),
  s("css", "customCss"),
];
const CONTAINER: UiProp[] = [
  p("name"),
  p("width"),
  p("background_color", "backgroundColor"),
  p("background_image", "backgroundImage"),
  p("background_style", "backgroundStyle"),
  p("class_name", "cssClass"),
  b("bootstrap_alt", "bootstrapAlt"),
  n("order"),
];
const ROW: UiProp[] = [p("class_name", "cssClass"), n("order")];
const COLUMN: UiProp[] = [
  n("size"),
  n("size_sm", "sizeSm"),
  n("size_xs", "sizeXs"),
  n("size_lg", "sizeLg"),
  p("class_name", "cssClass"),
  n("order"),
];
const INSTANCE: UiProp[] = [
  ref("sp_widget", "widget", "sp_widget"),
  p("id", "instanceId"),
  json("widget_parameters", "widgetParameters"),
  p("title"),
  p("class_name", "cssClass"),
  s("css", "customCss"),
  p("color"),
  p("size"),
  p("glyph"),
  list("roles"),
  p("short_description", "shortDescription"),
  b("active"),
  n("order"),
];

const PORTAL: UiProp[] = [
  p("title"),
  p("url_suffix", "urlSuffix"),
  ref("homepage", "homePage", "sp_page"),
  ref("login_page", "loginPage", "sp_page"),
  ref("notfound_page", "notFoundPage", "sp_page"),
  ref("theme", "theme", "sp_theme"),
  ref("sp_rectangle_menu", "mainMenu", "sp_instance_menu"),
  b("default"),
  p("logo"),
  p("icon"),
  json("quick_start_config", "quickStartConfig"),
  b("hide_portal_name", "hidePortalName"),
  s("css_variables", "cssVariables"),
];

const THEME: UiProp[] = [
  p("name"),
  s("css_variables", "cssVariables"),
  ref("header", "header", "sp_header_footer"),
  ref("footer", "footer", "sp_header_footer"),
  p("logo"),
  p("icon"),
  p("logo_alt_text", "logoAltText"),
  b("navbarfixed", "navbarFixed"),
  b("footerfixed", "footerFixed"),
  b("turn_off_scss_compilation", "turnOffScssCompilation"),
];
const THEME_JS: UiProp[] = [
  ref("sp_js_include", "include", "sp_js_include"),
  n("order"),
];
const THEME_CSS: UiProp[] = [
  ref("sp_css_include", "include", "sp_css_include"),
  n("order"),
];

const MENU: UiProp[] = [
  p("title"),
  ref("sp_widget", "widget", "sp_widget"),
  json("widget_parameters", "widgetParameters"),
  p("class_name", "cssClass"),
  p("color"),
  b("active"),
  list("roles"),
  p("short_description", "shortDescription"),
  n("order"),
];
const MENU_ITEM: UiProp[] = [
  p("label"),
  p("type"),
  p("url"),
  p("url_target", "urlTarget"),
  ref("sp_page", "page", "sp_page"),
  p("table"),
  p("filter"),
  p("condition"),
  n("order"),
  p("glyph"),
  p("color"),
  p("hint"),
  b("active"),
  list("roles"),
];

const ROUTE_MAP: UiProp[] = [
  p("short_description", "shortDescription"),
  ref("route_from_page", "routeFromPage", "sp_page"),
  ref("route_to_page", "routeToPage", "sp_page"),
  refList("portals", "portals", "sp_portal"),
  list("roles"),
  b("active"),
  n("order"),
];

const DEPENDENCY: UiProp[] = [
  p("name"),
  p("module", "angularModuleName"),
  b("include_on_page_load", "includeOnPageLoad"),
];
const ANGULAR_PROVIDER: UiProp[] = [
  p("name"),
  p("type"),
  s("script", "script"),
];
const JS_INCLUDE: UiProp[] = [
  p("display_name", "name"),
  p("source"),
  p("url"),
  ref("sys_ui_script", "uiScript", "sys_ui_script"),
];
const CSS_INCLUDE: UiProp[] = [
  p("name"),
  p("source"),
  p("url"),
  ref("sp_css", "spCss", "sp_css"),
  b("lazy_load", "lazyLoad"),
];

const WORKSPACE: UiProp[] = [
  p("title"),
  p("path"),
  b("active"),
  ref("root_macroponent", "rootMacroponent", "sys_ux_macroponent"),
  ref("admin_panel", "appConfig", "sys_ux_app_config"),
  p("admin_panel_table", "appConfigTable"),
  ref("parent_app", "parentApp", "sys_ux_page_registry"),
];
const PAGE_PROPERTY: UiProp[] = [
  p("name"),
  json("value", "value"),
  p("type"),
  p("description"),
];

const CATALOG_ITEM: UiProp[] = [
  p("name"),
  p("short_description", "shortDescription"),
  p("description"),
  b("active"),
  n("order"),
  ref("category", "category", "sc_category"),
  refList("sc_catalogs", "catalogs", "sc_catalog"),
  ref("workflow", "workflow", "wf_workflow"),
  ref("flow_designer_flow", "flow", "sys_hub_flow"),
  p("picture"),
  p("icon"),
  p("meta"),
  p("price"),
  p("recurring_price", "recurringPrice"),
  p("recurring_frequency", "recurringFrequency"),
  b("no_quantity", "noQuantity"),
  b("no_cart", "noCart"),
  b("no_order_now", "noOrderNow"),
  b("no_proceed_checkout", "noProceedCheckout"),
  b("no_search", "noSearch"),
  b("mandatory_attachment", "mandatoryAttachment"),
  b("hide_attachment", "hideAttachment"),
  p("request_method", "requestMethod"),
  p("access_type", "accessType"),
  list("roles"),
];
const RECORD_PRODUCER: UiProp[] = [
  p("table_name", "table"),
  s("script", "script"),
  s("postinsert_script", "postInsertScript"),
  p("redirect_url", "redirectUrl"),
];
const IO_SET: UiProp[] = [
  ref("variable_set", "variableSet", "item_option_new_set"),
  n("order"),
];
const VARIABLE_SET: UiProp[] = [
  p("title"),
  p("internal_name", "internalName"),
  p("description"),
  p("type"),
  n("order"),
  p("layout"),
  b("display_title", "displayTitle"),
  list("read_roles", "readRoles"),
  list("write_roles", "writeRoles"),
  list("create_roles", "createRoles"),
];

/** `item_option_new.type` codes → the SDK variable API (`<name>Variable`). */
const VARIABLE_API: Readonly<Record<string, string>> = {
  "1": "YesNo",
  "2": "MultiLineText",
  "3": "MultipleChoice",
  "4": "NumericScale",
  "5": "SelectBox",
  "6": "SingleLineText",
  "7": "CheckBox",
  "8": "Reference",
  "9": "Date",
  "10": "DateTime",
  "11": "Label",
  "12": "Break",
  "14": "Custom",
  "15": "UiPage",
  "16": "WideSingleLineText",
  "17": "CustomWithLabel",
  "18": "LookupSelectBox",
  "19": "ContainerStart",
  "20": "ContainerEnd",
  "21": "ListCollector",
  "22": "LookupMultipleChoice",
  "23": "Html",
  "24": "ContainerSplit",
  "25": "Masked",
  "26": "Email",
  "27": "Url",
  "28": "IpAddress",
  "29": "Duration",
  "31": "RequestedFor",
  "32": "RichTextLabel",
  "33": "Attachment",
};
const VARIABLE: UiProp[] = [
  p("question_text", "question"),
  n("order"),
  b("mandatory"),
  b("active"),
  b("read_only", "readOnly"),
  p("default_value", "defaultValue"),
  p("help_text", "helpText"),
  b("show_help", "showHelp"),
  p("tooltip"),
  p("instructions"),
  p("example_text", "exampleText"),
  p("reference", "referenceTable"),
  p("reference_qual", "referenceQualifier"),
  p("list_table", "listTable"),
  p("lookup_table", "lookupTable"),
  p("lookup_value", "lookupValue"),
  p("lookup_label", "lookupLabel"),
  p("choice_table", "choiceTable"),
  p("choice_field", "choiceField"),
  b("include_none", "includeNone"),
  n("scale_min", "scaleMin"),
  n("scale_max", "scaleMax"),
  p("attributes"),
  b("visible_summary", "visibleSummary"),
  b("visible_guide", "visibleGuide"),
  b("visible_standalone", "visibleStandalone"),
  list("read_roles", "readRoles"),
  list("write_roles", "writeRoles"),
  list("create_roles", "createRoles"),
  b("map_to_field", "mapToField"),
  p("field"),
];
const CHOICE: UiProp[] = [
  p("value"),
  p("text", "label"),
  n("order", "sequence"),
  b("inactive"),
  p("price"),
  p("recurring_price", "recurringPrice"),
  p("dependent_value", "dependentValue"),
];
const CATALOG_APPLIES: UiProp[] = [
  b("applies_catalog", "appliesCatalog"),
  b("applies_req_item", "appliesReqItem"),
  b("applies_sc_task", "appliesScTask"),
  b("applies_target_record", "appliesTargetRecord"),
];
const CLIENT_SCRIPT: UiProp[] = [
  p("name"),
  p("applies_to", "appliesTo"),
  ref("cat_item", "catalogItem", "sc_cat_item"),
  ref("variable_set", "variableSet", "item_option_new_set"),
  p("type"),
  p("cat_variable", "variableName"),
  {
    prop: "uiType",
    field: "ui_type",
    as: {
      map: { "0": "desktop", "1": "mobile_or_service_portal", "10": "all" },
    },
  },
  b("active"),
  b("isolate_script", "isolateScript"),
  ...CATALOG_APPLIES,
  b("va_supported", "vaSupported"),
  s("script", "script"),
];
const UI_POLICY: UiProp[] = [
  p("short_description", "shortDescription"),
  p("description"),
  p("applies_to", "appliesTo"),
  ref("catalog_item", "catalogItem", "sc_cat_item"),
  ref("variable_set", "variableSet", "item_option_new_set"),
  p("catalog_conditions", "catalogCondition"),
  n("order"),
  b("active"),
  b("on_load", "onLoad"),
  b("reverse_if_false", "reverseIfFalse"),
  b("run_scripts", "runScripts"),
  p("run_scripts_in_ui_type", "runScriptsInUiType"),
  b("isolate_script", "isolateScript"),
  ...CATALOG_APPLIES,
  s("script_true", "scriptTrue"),
  s("script_false", "scriptFalse"),
];
const UI_POLICY_SHAPE = { clientFields: ["script_true", "script_false"] };
const UI_POLICY_ACTION: UiProp[] = [
  p("catalog_variable", "variableName"),
  p("visible"),
  p("mandatory"),
  p("disabled", "readOnly"),
  p("cleared"),
  n("order"),
  p("value"),
  p("value_action", "valueAction"),
  p("field_message", "fieldMessage"),
  p("field_message_type", "fieldMessageType"),
];

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

/** What `args` needs to know about the table a row comes from. */
interface Shape {
  table: string;
  scopeField?: string;
  secretFields: readonly string[];
  clientFields?: string[];
  markupFields?: string[];
}

/** A parsed JSON value as an expression, keys in the parsed order. */
function jsonExpr(v: unknown): Expr {
  if (v === null) return code("null");
  if (Array.isArray(v)) return arr(v.map(jsonExpr));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return obj(Object.keys(o).map((k) => ({ key: k, value: jsonExpr(o[k]) })));
  }
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return lit(v);
  }
  // JSON.parse yields nothing else; keep a safe literal for completeness.
  return code("undefined");
}

/** A JSON field: the parsed value, or the raw string when it does not parse. */
function jsonValue(value: string): Expr {
  try {
    return jsonExpr(JSON.parse(value));
  } catch {
    return lit(value);
  }
}

/** snake_case → camelCase for the (U) passthrough structures. */
function camel(field: string): string {
  return field.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** A call's argument object, the fields left unmapped, the conversion problems. */
function args(
  run: EmitRun,
  shape: Shape,
  specs: readonly UiProp[],
  rec: SnRecord,
  key: string,
  skip: readonly string[],
): { props: Prop[]; unmapped: string[]; problems: [string, string][] } {
  const props: Prop[] = [
    { key: "$id", value: code(`Now.ID[${tsString(key)}]`) },
  ];
  const consumed = new Set<string>([...skip, shape.scopeField ?? "sys_scope"]);
  const problems: [string, string][] = [];
  for (const spec of specs) {
    consumed.add(spec.field);
    const value = snString(rec[spec.field]);
    if (value === "") continue;
    if (isSecret(spec.field, value, shape.secretFields, [], run.rules)) {
      props.push(secretProp(run, spec.prop));
      continue;
    }
    const as = spec.as;
    let expr: Expr | undefined;
    let problem: string | undefined;
    if (as === "script") {
      expr = sidecar(
        run,
        key,
        spec.field,
        value,
        sidecarSuffix(spec.field, shape),
      );
    } else if (as === "json") {
      expr = jsonValue(value);
    } else if (typeof as === "object" && "ref" in as) {
      expr = refExpr(as.ref, value);
    } else if (typeof as === "object" && "refList" in as) {
      const items = value
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      expr = arr(items.map((x) => refExpr(as.refList, x)));
    } else {
      ({ expr, problem } = convert(value, as));
    }
    if (expr) props.push({ key: spec.prop, value: expr });
    if (problem) problems.push([spec.field, `${spec.prop}: ${problem}`]);
  }
  return { props, unmapped: setFields(rec, consumed), problems };
}

// ---------------------------------------------------------------------------
// The tree builder
// ---------------------------------------------------------------------------

const id8 = (row: SnRecord): string =>
  snString(row.sys_id).slice(0, 8).toLowerCase();

/**
 * One artefact's emission: the calls it writes, the child rows it has placed
 * in its tree, and what is left over for `finish` (Record() rows with an
 * `unsupported[]` entry).
 */
export class UiTree {
  readonly apis = new Set<string>();
  readonly body: string[] = [];
  readonly notes: string[] = [];
  private readonly used = new Set<ArtifactChildResult>();
  private readonly placed = new Set<SnRecord>();
  /** Rows to emit as Record() after the main calls (see `later`). */
  private readonly deferred: [string, string, SnRecord][] = [];

  constructor(
    readonly run: EmitRun,
    readonly t: ArtifactType,
    readonly key: string,
    readonly rec: SnRecord,
    readonly children: readonly ArtifactChildResult[],
  ) {}

  get sysId(): string {
    return snString(this.rec.sys_id);
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  isPlaced(row: SnRecord): boolean {
    return this.placed.has(row);
  }

  /** Readable child rows of `table` linked through `parentField` to `parentId`, in order. */
  rows(table: string, parentField: string, parentId: string): SnRecord[] {
    const out: SnRecord[] = [];
    const want = parentId.toLowerCase();
    for (const c of this.children) {
      if (c.table !== table || c.parentField !== parentField) continue;
      if (c.redacted || c.error !== undefined || c.reason) continue;
      this.used.add(c);
      const d = this.t.children.find(
        (x) => x.table === c.table && x.parentField === c.parentField,
      );
      const rows = c.records.filter(
        (r) => snString(r[parentField]).toLowerCase() === want,
      );
      out.push(
        ...rows.sort(
          d
            ? childOrder(d)
            : (a, z) => cmp(snString(a.sys_id), snString(z.sys_id)),
        ),
      );
    }
    return out;
  }

  /** Report unmapped fields and conversion problems of one row. */
  private report(
    table: string,
    key: string,
    row: SnRecord,
    api: string,
    out: { unmapped: string[]; problems: [string, string][] },
    where?: string,
  ): void {
    const sysId = snString(row.sys_id);
    for (const [field, problem] of out.problems) {
      this.run.unsupported.push({
        kind: "field",
        table,
        key,
        sys_id: sysId,
        field,
        reason: `${problem}; not emitted.`,
      });
    }
    for (const field of out.unmapped) {
      this.run.unsupported.push({
        kind: "field",
        table,
        key,
        sys_id: sysId,
        field,
        reason: `No ${api} property is mapped for ${field}; not emitted.`,
      });
    }
    if (out.unmapped.length) {
      this.note(
        `Not emitted${where ? ` from ${where}` : ""} (no ${api} property mapped): ${out.unmapped.join(", ")}.`,
      );
    }
  }

  private shape(table: string, extra?: Partial<Shape>): Shape {
    return { table, secretFields: this.t.secretFields, ...extra };
  }

  /** The artefact's own call arguments. */
  topProps(
    specs: readonly UiProp[],
    api: string,
    extra?: Partial<Shape>,
  ): Prop[] {
    const out = args(
      this.run,
      { ...this.t, ...extra },
      specs,
      this.rec,
      this.key,
      [],
    );
    this.report(this.t.table, this.key, this.rec, api, out);
    return out.props;
  }

  /** A child key: `<owner>__<table>_<sys_id prefix>`, as the P-26 Record() rows use. */
  childKey(table: string, row: SnRecord, owner = this.key): string {
    return this.run.key(
      `${owner}__${fluentSlug(table)}_${id8(row)}`,
      snString(row.sys_id),
      table,
    );
  }

  /** A nested child object's properties (the row is placed). */
  childProps(
    table: string,
    row: SnRecord,
    specs: readonly UiProp[],
    api: string,
    skip: readonly string[],
    opts: { owner?: string; shape?: Partial<Shape> } = {},
  ): Prop[] {
    this.placed.add(row);
    const key = this.childKey(table, row, opts.owner);
    const out = args(
      this.run,
      this.shape(table, opts.shape),
      specs,
      row,
      key,
      skip,
    );
    this.report(table, key, row, api, out, `${table} ${id8(row)}`);
    return out.props;
  }

  /** A child row emitted as its own top-level call, keyed like its standalone type. */
  namedProps(
    type: string,
    table: string,
    nameField: string,
    row: SnRecord,
    specs: readonly UiProp[],
    api: string,
    shape?: Partial<Shape>,
  ): { key: string; props: Prop[] } {
    this.placed.add(row);
    const key = this.run.key(
      `${type}_${fluentSlug(snString(row[nameField])) || id8(row)}`,
      snString(row.sys_id),
      table,
    );
    const out = args(this.run, this.shape(table, shape), specs, row, key, []);
    this.report(table, key, row, api, out, `${table} ${id8(row)}`);
    return { key, props: out.props };
  }

  /**
   * A (U) structure with no documented property names: every set field as a
   * camelCase property (references as `Now.ref`, `order` as a number,
   * true / false as booleans). Nothing is dropped.
   */
  passthrough(
    table: string,
    row: SnRecord,
    skip: readonly string[],
    refs: readonly RefField[],
    top = false,
  ): Prop[] {
    this.note(PASSTHROUGH_NOTE);
    if (!top) this.placed.add(row);
    const key = top ? this.key : this.childKey(table, row);
    const props: Prop[] = [
      { key: "$id", value: code(`Now.ID[${tsString(key)}]`) },
    ];
    const secretFields = this.t.secretFields;
    for (const field of setFields(row, new Set([...skip, this.t.scopeField]))) {
      const value = snString(row[field]);
      const prop = camel(field);
      if (isSecret(field, value, secretFields, [], this.run.rules)) {
        props.push(secretProp(this.run, prop));
        continue;
      }
      const r = refs.find((x) => x.field === field);
      let expr: Expr;
      if (r) expr = refExpr(r.table, value);
      else if (value === "true" || value === "false") {
        expr = lit(value === "true");
      } else if (field === "order") {
        expr = convert(value, "number").expr ?? lit(value);
      } else expr = lit(value);
      props.push({ key: prop, value: expr });
    }
    return props;
  }

  /** m2m rows as a reference list; extra m2m fields are reported. */
  refs(
    table: string,
    parentField: string,
    refField: string,
    refTable: string,
    api: string,
  ): Expr[] {
    const out: Expr[] = [];
    for (const row of this.rows(table, parentField, this.sysId)) {
      const value = snString(row[refField]);
      if (!value) continue; // left for finish(): emitted as a Record() row
      this.placed.add(row);
      this.note(M2M_NOTE);
      this.report(
        table,
        this.key,
        row,
        api,
        {
          unmapped: setFields(row, new Set([parentField, refField])),
          problems: [],
        },
        `${table} ${id8(row)}`,
      );
      out.push(refExpr(refTable, value));
    }
    return out;
  }

  /** A top-level call. */
  call(api: string, props: Prop[]): void {
    this.apis.add(api);
    this.body.push(`${api}(${render(obj(props))})`);
  }

  /** A call nested two levels deep (`CatalogItem({ variables: { x: X({…}) } })`). */
  nested(api: string, props: Prop[]): Expr {
    this.apis.add(api);
    return code(`${api}(${render(obj(props), 2)})`);
  }

  /** Mark a row placed now and emit it as a `Record()` row after the main calls. */
  later(table: string, parentField: string, row: SnRecord): void {
    this.placed.add(row);
    this.deferred.push([table, parentField, row]);
  }

  /** Emit one child row as a `Record()` row (the P-26 child form). */
  recordRow(table: string, parentField: string, row: SnRecord): void {
    const c = this.t.children.find(
      (d) => d.table === table && d.parentField === parentField,
    );
    this.placed.add(row);
    const key = this.childKey(table, row);
    const data = recordData(this.run, row, key, {
      table,
      secretFields: this.t.secretFields,
      scriptFields: c?.scriptFields ?? [],
      refFields: c?.refFields ?? [],
      skip: new Set(),
      parent: {
        field: parentField,
        table: c?.parentTable ?? this.t.table,
        byValue: c?.parentKey !== undefined,
      },
    });
    this.apis.add("Record");
    this.body.push(
      `// child of ${this.key}: ${table}\n${recordCall(key, table, data)}`,
    );
  }

  /**
   * Report unreadable / truncated child tables, then emit every row the tree
   * did not place as a `Record()` row with an `unsupported[]` entry.
   */
  finish(api: string): void {
    for (const [table, parentField, row] of this.deferred) {
      this.recordRow(table, parentField, row);
    }
    // Descriptor order, not input order: the output must not depend on it.
    const rank = (c: ArtifactChildResult): number => {
      const i = this.t.children.findIndex(
        (d) => d.table === c.table && d.parentField === c.parentField,
      );
      return i < 0 ? this.t.children.length : i;
    };
    const ordered = [...this.children].sort(
      (a, z) =>
        rank(a) - rank(z) ||
        cmp(a.table, z.table) ||
        cmp(a.parentField, z.parentField),
    );
    for (const c of ordered) {
      if (c.redacted || c.error !== undefined || c.reason) {
        this.run.unsupported.push({
          kind: "child",
          table: c.table,
          key: this.key,
          sys_id: this.sysId,
          reason: `Child table not emitted: ${c.reason ?? c.error ?? "redacted"}`,
        });
        continue;
      }
      if (c.truncated) {
        this.run.unsupported.push({
          kind: "child",
          table: c.table,
          key: this.key,
          sys_id: this.sysId,
          reason: `Only the first ${c.count} child rows were read and emitted.`,
        });
      }
      const d = this.t.children.find(
        (x) => x.table === c.table && x.parentField === c.parentField,
      );
      if (!d) continue;
      const left = c.records
        .filter((r) => !this.placed.has(r))
        .sort(childOrder(d));
      if (!left.length) continue;
      this.run.unsupported.push({
        kind: "child",
        table: c.table,
        key: this.key,
        sys_id: this.sysId,
        reason: this.used.has(c)
          ? `${left.length} ${c.table} row(s) do not fit the ${api} tree (no parent, or no Fluent form); emitted as Record() rows.`
          : `${c.table} (via ${c.parentField}) has no ${api} property; emitted as Record() rows.`,
      });
      for (const row of left) this.recordRow(c.table, c.parentField, row);
    }
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Build = (tree: UiTree) => void;

const withList = (props: Prop[], key: string, items: Expr[]): Prop[] => {
  if (items.length) props.push({ key, value: arr(items) });
  return props;
};

const simple =
  (api: string, specs: readonly UiProp[], shape?: Partial<Shape>): Build =>
  (tree) =>
    tree.call(api, tree.topProps(specs, api, shape));

function widget(api: string): Build {
  return (tree) => {
    const props = tree.topProps(WIDGET, api, WIDGET_SHAPE);
    const templates = tree
      .rows("sp_ng_template", "sp_widget", tree.sysId)
      .map((r) =>
        obj(
          tree.childProps(
            "sp_ng_template",
            r,
            NG_TEMPLATE,
            api,
            ["sp_widget"],
            {
              shape: { markupFields: ["template"] },
            },
          ),
        ),
      );
    withList(props, "templates", templates);
    withList(
      props,
      "dependencies",
      tree.refs(
        "m2m_sp_widget_dependency",
        "sp_widget",
        "sp_dependency",
        "sp_dependency",
        api,
      ),
    );
    withList(
      props,
      "angularProviders",
      tree.refs(
        "m2m_sp_ng_pro_sp_widget",
        "sp_widget",
        "sp_angular_provider",
        "sp_angular_provider",
        api,
      ),
    );
    tree.call(api, props);
  };
}

const page: Build = (tree) => {
  const api = "SPPage";
  const id = (r: SnRecord) => snString(r.sys_id);
  const props = tree.topProps(PAGE, api, { markupFields: ["css"] });
  const containers = tree
    .rows("sp_container", "sp_page", tree.sysId)
    .map((c) => {
      const cp = tree.childProps("sp_container", c, CONTAINER, api, [
        "sp_page",
      ]);
      const rows = tree.rows("sp_row", "sp_container", id(c)).map((r) => {
        const rp = tree.childProps("sp_row", r, ROW, api, ["sp_container"]);
        const cols = tree.rows("sp_column", "sp_row", id(r)).map((col) => {
          const colp = tree.childProps("sp_column", col, COLUMN, api, [
            "sp_row",
          ]);
          const instances = tree
            .rows("sp_instance", "sp_column", id(col))
            .map((i) =>
              obj(
                tree.childProps(
                  "sp_instance",
                  i,
                  INSTANCE,
                  api,
                  ["sp_column"],
                  {
                    shape: { markupFields: ["css"] },
                  },
                ),
              ),
            );
          return obj(withList(colp, "instances", instances));
        });
        return obj(withList(rp, "columns", cols));
      });
      return obj(withList(cp, "rows", rows));
    });
  tree.call(api, withList(props, "containers", containers));
};

function includes(
  api: string,
  specs: readonly UiProp[],
  shape?: Partial<Shape>,
  m2m: [string, string, string, readonly UiProp[]][] = [],
): Build {
  return (tree) => {
    const props = tree.topProps(specs, api, shape);
    for (const [table, parentField, prop, rowSpecs] of m2m) {
      const items = tree
        .rows(table, parentField, tree.sysId)
        .map((r) =>
          obj(tree.childProps(table, r, rowSpecs, api, [parentField])),
        );
      withList(props, prop, items);
    }
    tree.call(api, props);
  };
}

const menu: Build = (tree) => {
  const api = "SPMenu";
  const props = tree.topProps(MENU, api);
  const items = tree
    .rows("sp_rectangle_menu_item", "sp_rectangle_menu", tree.sysId)
    .map((r) =>
      obj(
        tree.childProps("sp_rectangle_menu_item", r, MENU_ITEM, api, [
          "sp_rectangle_menu",
        ]),
      ),
    );
  tree.call(api, withList(props, "items", items));
};

const workspace: Build = (tree) => {
  const api = "Workspace";
  const props = tree.topProps(WORKSPACE, api);
  const properties = tree
    .rows("sys_ux_page_property", "page", tree.sysId)
    .map((r) =>
      obj(
        tree.childProps("sys_ux_page_property", r, PAGE_PROPERTY, api, [
          "page",
        ]),
      ),
    );
  withList(props, "properties", properties);
  for (const r of tree.t.refFields) {
    const value = snString(tree.rec[r.field]);
    if (!value) continue;
    const reason = `UI Builder internals have no Fluent API: the Workspace references ${r.table} ${value} by Now.ref and does not emit it; export it with artifactType '${r.type ?? r.table}' (Record()).`;
    tree.run.unsupported.push({
      kind: "api",
      table: r.table,
      key: tree.key,
      sys_id: value,
      reason,
    });
    tree.note(reason);
  }
  tree.call(api, props);
};

const dashboard: Build = (tree) => {
  const props = tree.passthrough(tree.t.table, tree.rec, [], [], true);
  const tabs = tree
    .rows("par_dashboard_tab", "dashboard", tree.sysId)
    .map((tab) => {
      const tp = tree.passthrough("par_dashboard_tab", tab, ["dashboard"], []);
      const widgets = tree
        .rows("par_dashboard_widget", "tab", snString(tab.sys_id))
        .map((w) =>
          obj(tree.passthrough("par_dashboard_widget", w, ["tab"], [])),
        );
      return obj(withList(tp, "widgets", widgets));
    });
  withList(props, "tabs", tabs);
  const permissions = tree
    .rows("par_dashboard_permission", "dashboard", tree.sysId)
    .map((r) =>
      obj(tree.passthrough("par_dashboard_permission", r, ["dashboard"], [])),
    );
  withList(props, "permissions", permissions);
  tree.call("Dashboard", props);
};

const listMenu: Build = (tree) => {
  const props = tree.passthrough(tree.t.table, tree.rec, [], [], true);
  const categories = tree
    .rows("sys_ux_list_category", "configuration", tree.sysId)
    .map((cat) => {
      const cp = tree.passthrough(
        "sys_ux_list_category",
        cat,
        ["configuration"],
        [],
      );
      const lists = tree
        .rows("sys_ux_list", "category", snString(cat.sys_id))
        .map((l) => obj(tree.passthrough("sys_ux_list", l, ["category"], [])));
      return obj(withList(cp, "lists", lists));
    });
  tree.call("UxListMenuConfig", withList(props, "categories", categories));
};

const applicability: Build = (tree) => {
  const props = tree.passthrough(tree.t.table, tree.rec, [], [], true);
  const lists = tree
    .rows("sys_ux_applicability_m2m_list", "applicability", tree.sysId)
    .map((r) =>
      obj(
        tree.passthrough(
          "sys_ux_applicability_m2m_list",
          r,
          ["applicability"],
          [],
        ),
      ),
    );
  tree.call("Applicability", withList(props, "lists", lists));
};

// -- Catalog ----------------------------------------------------------------

/** The typed variables of an item or a set, as `{ name: XVariable({…}) }` props. */
function variables(
  tree: UiTree,
  parentField: "cat_item" | "variable_set",
  parentId: string,
  owner: string,
  api: string,
): Prop[] {
  const out: Prop[] = [];
  const names = new Set<string>();
  for (const row of tree.rows("item_option_new", parentField, parentId)) {
    const type = snString(row.type);
    const kind = VARIABLE_API[type];
    const sysId = snString(row.sys_id);
    if (!kind) {
      const reason = `Variable type '${type || "(empty)"}' has no Fluent variable API; emitted as a Record() row.`;
      tree.run.unsupported.push({
        kind: "api",
        table: "item_option_new",
        key: owner,
        sys_id: sysId,
        reason,
      });
      tree.later("item_option_new", parentField, row);
      continue;
    }
    const base = snString(row.name) || `variable_${id8(row)}`;
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base}_${i}`;
    names.add(name);
    if (name !== snString(row.name)) {
      tree.run.unsupported.push({
        kind: "field",
        table: "item_option_new",
        key: owner,
        sys_id: sysId,
        field: "name",
        reason: snString(row.name)
          ? `Duplicate variable name '${base}'; emitted as '${name}'.`
          : `The variable has no name; emitted as '${name}'.`,
      });
    }
    const variableApi = `${kind}Variable`;
    const props = tree.childProps(
      "item_option_new",
      row,
      VARIABLE,
      variableApi,
      [parentField, "type", "name"],
      { owner },
    );
    const choices = tree
      .rows("question_choice", "question", sysId)
      .map((c) =>
        obj(
          tree.childProps(
            "question_choice",
            c,
            CHOICE,
            variableApi,
            ["question"],
            { owner },
          ),
        ),
      );
    withList(props, "choices", choices);
    out.push({ key: name, value: tree.nested(variableApi, props) });
  }
  void api;
  return out;
}

function clientScripts(
  tree: UiTree,
  parentField: string,
  parentId: string,
): void {
  const api = "CatalogClientScript";
  for (const row of tree.rows("catalog_script_client", parentField, parentId)) {
    const { props } = tree.namedProps(
      "catalog_client_script",
      "catalog_script_client",
      "name",
      row,
      CLIENT_SCRIPT,
      api,
      { clientFields: ["script"] },
    );
    tree.call(api, props);
  }
}

function policyActions(tree: UiTree, policyId: string, owner: string): Expr[] {
  return tree
    .rows("catalog_ui_policy_action", "ui_policy", policyId)
    .map((r) =>
      obj(
        tree.childProps(
          "catalog_ui_policy_action",
          r,
          UI_POLICY_ACTION,
          "CatalogUiPolicy",
          ["ui_policy"],
          { owner },
        ),
      ),
    );
}

function policies(tree: UiTree, parentField: string, parentId: string): void {
  const api = "CatalogUiPolicy";
  for (const row of tree.rows("catalog_ui_policy", parentField, parentId)) {
    const { key, props } = tree.namedProps(
      "catalog_ui_policy",
      "catalog_ui_policy",
      "short_description",
      row,
      UI_POLICY,
      api,
      UI_POLICY_SHAPE,
    );
    withList(props, "actions", policyActions(tree, snString(row.sys_id), key));
    tree.call(api, props);
  }
}

/** A `VariableSet` call and the logic of the set; `top` for a standalone set. */
function variableSet(tree: UiTree, row: SnRecord, top: boolean): void {
  const api = "VariableSet";
  const { key, props } = top
    ? { key: tree.key, props: tree.topProps(VARIABLE_SET, api) }
    : tree.namedProps(
        "variable_set",
        "item_option_new_set",
        "title",
        row,
        VARIABLE_SET,
        api,
      );
  const setId = snString(row.sys_id);
  const vars = variables(tree, "variable_set", setId, key, api);
  if (vars.length) props.push({ key: "variables", value: obj(vars) });
  tree.call(api, props);
  clientScripts(tree, "variable_set", setId);
  policies(tree, "variable_set", setId);
}

function catalogItem(api: string, extra: readonly UiProp[] = []): Build {
  return (tree) => {
    const props = tree.topProps([...CATALOG_ITEM, ...extra], api);
    const vars = variables(tree, "cat_item", tree.sysId, tree.key, api);
    if (vars.length) props.push({ key: "variables", value: obj(vars) });
    const sets = tree.rows("io_set_item", "sc_cat_item", tree.sysId);
    withList(
      props,
      "variableSets",
      sets.map((r) =>
        obj(tree.childProps("io_set_item", r, IO_SET, api, ["sc_cat_item"])),
      ),
    );
    withList(
      props,
      "categories",
      tree.refs(
        "sc_cat_item_category",
        "sc_cat_item",
        "sc_category",
        "sc_category",
        api,
      ),
    );
    withList(
      props,
      "availableFor",
      tree.refs(
        "sc_cat_item_user_criteria_mtom",
        "sc_cat_item",
        "user_criteria",
        "user_criteria",
        api,
      ),
    );
    tree.call(api, props);
    clientScripts(tree, "cat_item", tree.sysId);
    policies(tree, "catalog_item", tree.sysId);
    for (const io of sets) {
      const setId = snString(io.variable_set);
      if (!setId) continue;
      for (const row of tree.rows("item_option_new_set", "sys_id", setId)) {
        if (!tree.isPlaced(row)) variableSet(tree, row, false);
      }
    }
  };
}

const catalogUiPolicy: Build = (tree) => {
  const api = "CatalogUiPolicy";
  const props = tree.topProps(UI_POLICY, api);
  withList(props, "actions", policyActions(tree, tree.sysId, tree.key));
  tree.call(api, props);
};

// ---------------------------------------------------------------------------
// Dispatch (called from src/api/fluent.ts)
// ---------------------------------------------------------------------------

export interface UiEmitter {
  /** The SDK API of the artefact's own call; equals the descriptor's `sdkApi`. */
  api: string;
  build: Build;
}

/** The P-28 emitters, by registry type id. */
export const UI_EMITTERS: Readonly<Record<string, UiEmitter>> = {
  // Service Portal
  sp_portal: {
    api: "ServicePortal",
    build: simple("ServicePortal", PORTAL, { markupFields: ["css_variables"] }),
  },
  sp_page: { api: "SPPage", build: page },
  sp_widget: { api: "SPWidget", build: widget("SPWidget") },
  sp_header_footer: { api: "SPHeaderFooter", build: widget("SPHeaderFooter") },
  sp_theme: {
    api: "SPTheme",
    build: includes("SPTheme", THEME, undefined, [
      ["m2m_sp_theme_js_include", "sp_theme", "jsIncludes", THEME_JS],
      ["m2m_sp_theme_css_include", "sp_theme", "cssIncludes", THEME_CSS],
    ]),
  },
  sp_menu: { api: "SPMenu", build: menu },
  sp_page_route_map: {
    api: "SPPageRouteMap",
    build: simple("SPPageRouteMap", ROUTE_MAP),
  },
  sp_dependency: {
    api: "SPWidgetDependency",
    build: includes("SPWidgetDependency", DEPENDENCY, undefined, [
      ["m2m_sp_dependency_js_include", "sp_dependency", "jsIncludes", THEME_JS],
      [
        "m2m_sp_dependency_css_include",
        "sp_dependency",
        "cssIncludes",
        THEME_CSS,
      ],
    ]),
  },
  sp_angular_provider: {
    api: "SPAngularProvider",
    build: simple("SPAngularProvider", ANGULAR_PROVIDER),
  },
  sp_js_include: { api: "JsInclude", build: simple("JsInclude", JS_INCLUDE) },
  sp_css_include: {
    api: "CssInclude",
    build: simple("CssInclude", CSS_INCLUDE),
  },
  // Next Experience
  workspace: { api: "Workspace", build: workspace },
  dashboard: { api: "Dashboard", build: dashboard },
  ux_list_menu_config: { api: "UxListMenuConfig", build: listMenu },
  ux_applicability: { api: "Applicability", build: applicability },
  // Service Catalog
  catalog_item: { api: "CatalogItem", build: catalogItem("CatalogItem") },
  record_producer: {
    api: "CatalogItemRecordProducer",
    build: catalogItem("CatalogItemRecordProducer", RECORD_PRODUCER),
  },
  variable_set: {
    api: "VariableSet",
    build: (tree) => variableSet(tree, tree.rec, true),
  },
  catalog_client_script: {
    api: "CatalogClientScript",
    build: simple("CatalogClientScript", CLIENT_SCRIPT),
  },
  catalog_ui_policy: { api: "CatalogUiPolicy", build: catalogUiPolicy },
};

/**
 * The `unsupported[]` reason of a P-28-group type that stays `Record()`;
 * undefined leaves the P-26 reason in place.
 */
export function uiFallbackReason(t: ArtifactType): string | undefined {
  if (t.group === "uib") {
    return `UI Builder internals (${t.table}) have no Fluent API in the SDK; emitted as Record().`;
  }
  if (t.type === "sp_ng_template") {
    return "Angular templates are emitted inside their widget's SPWidget (templates); a standalone template is emitted as Record().";
  }
  return undefined;
}

/** Emit one P-28 artefact's `.now.ts` (and its sidecars) into the run. */
export function emitUi(
  run: EmitRun,
  t: ArtifactType,
  src: FluentSource,
  rec: SnRecord,
): void {
  const e = UI_EMITTERS[t.type]!;
  const sysId = snString(rec.sys_id);
  const name = snString(rec[t.nameField]) || src.name || "";
  const key = run.key(
    `${t.type}_${fluentSlug(name) || sysId.slice(0, 8)}`,
    sysId,
    t.table,
  );
  const tree = new UiTree(run, t, key, rec, src.children ?? []);
  tree.note(UI_NOTE);
  e.build(tree);
  tree.finish(e.api);

  const scope = src.scope?.scope ?? src.scope?.sys_id ?? "unknown";
  const lines = [
    header([`Source: ${t.table} ${sysId} '${name}' (scope ${scope}).`]),
    "",
    "import '@servicenow/sdk/global'",
    `import { ${[...tree.apis].sort(cmp).join(", ")} } from '@servicenow/sdk/core'`,
    "",
    ...tree.notes.map((x) => `// ${oneLine(x)}`),
    "",
    tree.body.join("\n\n"),
    "",
  ];
  run.files.push({ path: `${key}.now.ts`, content: lines.join("\n") });
}
