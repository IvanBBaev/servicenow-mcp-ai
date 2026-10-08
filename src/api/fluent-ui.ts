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
 * Property names are type-checked against the pinned @servicenow/sdk 4.12.2 and
 * the goldens built with `now-sdk build` (P-29, `npm run fluent:verify`, owner
 * gate O-7); instance behaviour is not verified (O-5). The P-26 rules hold: every set field is
 * either emitted or reported in `unsupported[]` (never lost silently), child
 * rows that do not fit the tree are emitted as `Record()` rows, secrets become
 * the credential placeholder, and the output is deterministic.
 */
import type { ArtifactType } from "../core/artifacts/registry.js";
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
  SECRET_PLACEHOLDER,
  secretProp,
  setFields,
  sidecar,
  sidecarSuffix,
  type Conv,
  type EmitRun,
  type FluentSource,
} from "./fluent-emit.js";

/** The `warnings[]` entry (and header note) of a `servicenow_generate_fluent` run over a P-28 type. */
export const UI_VERIFIED_NOTE =
  "The portal / workspace / catalog shapes (P-28) are type-checked against @servicenow/sdk 4.12.2 (npm run fluent:verify); instance behaviour (P-29 / O-5) is not verified: review before deploying.";

const NO_ID_NOTE =
  "Nested structures the SDK gives no $id (variables, choices, includes, variable-set links, UI policy actions) are matched by their natural key on install; their sys_ids are not kept.";

const PAGE_ID_NOTE =
  "SPPage takes no $id: now-sdk build gives the page a new sys_id, so on the source instance the install can add a second page with the same id (pageId); check before deploying (O-5).";

const M2M_NOTE =
  "Many-to-many rows are emitted as references; the rows' own sys_ids are not kept.";

// ---------------------------------------------------------------------------
// Property specs
// ---------------------------------------------------------------------------

type UiConv =
  | Conv
  | "json"
  | "tristate"
  | "derived"
  | "widgetOptions"
  /** A variable reference: every `IO:` prefix removed (`IO:<sys_id>` → `<sys_id>`). */
  | "io"
  /** A choice map whose `omit` values (the platform's "no action") emit nothing. */
  | { readonly map: Record<string, string>; readonly omit: readonly string[] }
  | { readonly ref: string }
  | { readonly refList: string };

interface UiProp {
  prop: string;
  field: string;
  as?: UiConv;
  /** The property applies only when this holds for the row; otherwise the field is consumed silently. */
  when?: (rec: SnRecord) => boolean;
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
/** A true / false / ignore field: a boolean, or nothing for `ignore`. */
const tri = (field: string, prop = field): UiProp => ({
  prop,
  field,
  as: "tristate",
});
/** A field the SDK derives from other properties: consumed, never emitted. */
const derived = (field: string): UiProp => ({
  prop: "",
  field,
  as: "derived",
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
  {
    prop: "category",
    field: "category",
    as: {
      map: {
        standard: "standard",
        other: "otherApplications",
        custom: "custom",
        sample: "sample",
        kb: "knowledgeBase",
        sp_platform: "servicePortal",
        sc: "serviceCatalog",
      },
    },
  },
  p("data_table", "dataTable"),
  p("controller_as", "controllerAs"),
  b("public"),
  list("roles"),
  b("has_preview", "hasPreview"),
  { prop: "optionSchema", field: "option_schema", as: "widgetOptions" },
  json("demo_data", "demoData"),
  list("field_list", "fields"),
  s("template", "htmlTemplate"),
  s("css", "customCss"),
  s("client_script", "clientScript"),
  s("script", "serverScript"),
  s("link", "linkScript"),
  b("internal"),
  b("servicenow"),
];
/** `sp_header_footer` only: the static header / footer flag. */
const HEADER_FOOTER: UiProp[] = [...WIDGET, b("static")];
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
  s("css", "css"),
  b("omit_watcher", "omitWatcher"),
  b("use_seo_script", "useSeoScript"),
  s("seo_script", "seoScript"),
  p("dynamic_title_structure", "dynamicTitleStructure"),
  p("human_readable_url_structure", "humanReadableUrlStructure"),
];
const CONTAINER: UiProp[] = [
  p("name"),
  p("width"),
  p("background_color", "backgroundColor"),
  p("background_image", "backgroundImage"),
  p("background_style", "backgroundStyle"),
  p("class_name", "cssClass"),
  b("bootstrap_alt", "bootstrapAlt"),
  p("title"),
  b("subheader"),
  p("container_class_name", "parentClass"),
  p("semantic_tag", "semanticTag"),
  n("order"),
];
const ROW: UiProp[] = [
  p("class_name", "cssClass"),
  p("semantic_tag", "semanticTag"),
  n("order"),
];
const COLUMN: UiProp[] = [
  n("size"),
  n("size_sm", "sizeSm"),
  n("size_xs", "sizeXs"),
  n("size_lg", "sizeLg"),
  p("class_name", "cssClass"),
  p("semantic_tag", "semanticTag"),
  n("order"),
];
const INSTANCE: UiProp[] = [
  ref("sp_widget", "widget", "sp_widget"),
  p("id"),
  // A page instance takes the raw parameter string (SPMenu takes JSON).
  p("widget_parameters", "widgetParameters"),
  p("title"),
  p("url"),
  p("class_name", "cssClass"),
  s("css", "css"),
  p("color"),
  p("size"),
  p("glyph"),
  list("roles"),
  p("short_description", "shortDescription"),
  b("active"),
  n("order"),
  b("async_load", "asyncLoad"),
  p("async_load_trigger", "asyncLoadTrigger"),
  p("async_load_device_type", "asyncLoadDeviceType"),
  b("preserve_placeholder_size", "preservePlaceholderSize"),
  b("advanced_placeholder_dimensions", "advancedPlaceholderDimensions"),
  p("placeholder_dimensions", "placeholderDimensions"),
  s("placeholder_dimensions_script", "placeholderConfigurationScript"),
  s("placeholder_template", "placeholderTemplate"),
];

const PORTAL: UiProp[] = [
  p("title"),
  p("url_suffix", "urlSuffix"),
  ref("homepage", "homePage", "sp_page"),
  ref("login_page", "loginPage", "sp_page"),
  ref("notfound_page", "notFoundPage", "sp_page"),
  ref("theme", "theme", "sp_theme"),
  ref("sp_rectangle_menu", "mainMenu", "sp_instance_menu"),
  b("default", "defaultPortal"),
  p("logo"),
  p("icon"),
  p("quick_start_config", "quickStartConfig"),
  b("hide_portal_name", "hidePortalName"),
  s("css_variables", "cssVariables"),
  p("logo_alt_text", "logoAltText"),
  ref("dark_theme", "darkTheme", "sp_theme"),
  ref("sc_category_page", "categoryHomePage", "sp_page"),
  ref("sc_catalog_page", "catalogHomePage", "sp_page"),
  ref("kb_knowledge_page", "knowledgeHomePage", "sp_page"),
  ref(
    "search_results_configuration",
    "searchResultsConfiguration",
    "sys_search_results_config",
  ),
  ref("search_application", "searchApplication", "sys_search_context_config"),
  ref("chat_queue", "chatQueue", "chat_queue"),
  ref("text_index_group", "textIndexGroup", "ts_index_group"),
  b("enable_ais", "enableAiSearch"),
  b(
    "enable_certificate_based_authentication",
    "enableCertificateBasedAuthentication",
  ),
  b("enable_web_embeddables", "enableWebEmbeddables"),
  b("enable_favorites", "enableFavorites"),
  b("inactive"),
  b("rtl_enabled", "supportRightToLeftLanguages"),
  ref("alternate_portal", "alternatePortal", "sp_portal"),
];

const THEME: UiProp[] = [
  p("name"),
  s("css_variables", "customCss"),
  ref("header", "header", "sp_header_footer"),
  ref("footer", "footer", "sp_header_footer"),
  p("logo"),
  p("icon"),
  p("logo_alt_text", "logoAltText"),
  b("navbar_fixed", "fixedHeader"),
  b("footer_fixed", "fixedFooter"),
  b("turn_off_scss_compilation", "turnOffScssCompilation"),
  ref(
    "matching_now_experience_theme",
    "matchingNextExperienceTheme",
    "sys_ux_theme",
  ),
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
  p("column"),
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
  p("short_description", "shortDescription"),
  b("active"),
  list("roles"),
  ref("sc_category", "scCategory", "sc_category"),
  ref("sc_cat_item", "catItem", "sc_cat_item"),
  ref("kb_topic", "kbTopic", "kb_topic"),
  ref("kb_article", "kbArticle", "kb_knowledge"),
  ref("kb_category", "kbCategory", "kb_category"),
  p("display_date", "displayDate"),
  s("record_script", "script"),
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
  derived("source"),
  p("url"),
  ref("sys_ui_script", "sysUiScript", "sys_ui_script"),
];
const CSS_INCLUDE: UiProp[] = [
  p("name"),
  derived("source"),
  p("url"),
  ref("sp_css", "spCss", "sp_css"),
  p("rtl_css_file_url", "rtlCssUrl"),
  b("lazy_load", "lazyLoad"),
];

const WORKSPACE: UiProp[] = [p("title"), p("path"), b("active"), n("order")];
const DASHBOARD: UiProp[] = [
  p("name"),
  p("description"),
  b("active"),
  b("certified"),
];
const DASH_TAB: UiProp[] = [p("name"), b("active"), derived("order")];
const DASH_WIDGET: UiProp[] = [
  p("component"),
  json("component_props", "componentProps"),
  n("h", "height"),
  n("w", "width"),
  derived("x"),
  derived("y"),
];
const DASH_PERMISSION: UiProp[] = [
  ref("user", "user", "sys_user"),
  ref("group", "group", "sys_user_group"),
  ref("role", "role", "sys_user_role"),
  b("can_read", "canRead"),
  b("can_write", "canWrite"),
  b("can_share", "canShare"),
  b("owner"),
];
const LIST_MENU: UiProp[] = [p("name"), p("description"), b("active")];
const LIST_CATEGORY: UiProp[] = [
  p("title"),
  p("description"),
  b("active"),
  n("order"),
];
/** `sys_ux_list` hide_* toggles, all booleans named like the field. */
const UX_LIST_HIDE = [
  "cell_filter",
  "checkbox_hover",
  "column_filtering",
  "column_grouping",
  "column_resizing",
  "column_sorting",
  "drag_and_drop",
  "empty_state_image",
  "first_page",
  "header",
  "highlight_content",
  "highlighted_values",
  "inline_editing",
  "last_page",
  "last_refreshed_text",
  "links",
  "list_actions",
  "menu_button",
  "next_page",
  "option_to_save_as",
  "pages",
  "pagination",
  "panel_advanced",
  "panel_button",
  "panel_condition_delete",
  "panel_footer",
  "panel_restore",
  "personalization",
  "previous_page",
  "quick_edit",
  "range",
  "record_count_badge",
  "reference_links",
  "refresh_button",
  "row_count",
  "row_selector",
  "rows_per_page_selector",
  "select_all",
  "sharing_button",
  "title",
];
const UX_LIST: UiProp[] = [
  p("title"),
  p("table"),
  p("view"),
  p("columns"),
  p("condition"),
  p("fixed_query", "fixedQuery"),
  p("groups"),
  p("roles"),
  p("group_by_column", "groupByColumn"),
  b("active"),
  n("order"),
  b("enable_infinite_scroll", "enableInfiniteScroll"),
  ...UX_LIST_HIDE.map((x) => b(`hide_${x}`, camel(`hide_${x}`))),
  p("highlight_content_color", "highlightContentColor"),
  p("highlight_content_pattern", "highlightContentPattern"),
  p("list_attributes", "listAttributes"),
  p("live_updates", "liveUpdates"),
  n("max_characters", "maxCharacters"),
  b("word_wrap", "wordWrap"),
  b("override_word_wrap_user_pref", "overrideWordWrapUserPref"),
];
const APPLICABILITY: UiProp[] = [
  p("name"),
  p("description"),
  b("active"),
  list("roles"),
  p("role_names", "roleNames"),
];

// Catalog specs follow the SDK 4.12.2 record → Fluent transforms
// (sdk-build-plugins service-catalog) and the sdk-core types.

/** Fields of `CatalogItemBaseConfig`, `M2MRelationships`, `PortalSettings` and `AvailabilityConfig`: both item APIs. */
const CATALOG_BASE: UiProp[] = [
  p("name"),
  p("short_description", "shortDescription"),
  p("description"),
  b("active"),
  n("order"),
  {
    prop: "availability",
    field: "availability",
    as: {
      map: {
        on_desktop: "desktopOnly",
        on_mobile: "mobileOnly",
        on_both: "both",
      },
    },
  },
  b("checked_out", "checkedOut"),
  list("meta"),
  ref("model", "model", "cmdb_model"),
  ref("owner", "owner", "sys_user"),
  list("roles"),
  b("show_variable_help_on_load", "showVariableHelpOnLoad"),
  b("start_closed", "startClosed"),
  p("state"),
  n("version"),
  ref("view", "view", "sys_ui_view"),
  p("icon"),
  p("image"),
  b("no_search", "noSearch"),
  p("picture"),
  p("mobile_picture", "mobilePicture"),
  {
    prop: "mobilePictureType",
    field: "mobile_picture_type",
    as: {
      map: {
        use_desktop_picture: "desktopPicture",
        use_mobile_picture: "mobilePicture",
        use_no_picture: "noPicture",
      },
    },
  },
  refList("sc_catalogs", "catalogs", "sc_catalog"),
  // `categories` (the m2m rows, else this field) is built by catalogItem().
  derived("category"),
  b("no_cart_v2", "hideAddToCart"),
  b("no_wishlist_v2", "hideAddToWishList"),
  b("no_delivery_time_v2", "hideDeliveryTime"),
  b("no_quantity_v2", "hideQuantitySelector"),
  b("no_save_as_draft", "hideSaveAsDraft"),
  b("hide_sp", "hideSP"),
  b("mandatory_attachment", "mandatoryAttachment"),
  b("no_attachment_v2", "hideAttachment"),
  b("make_item_non_conversational", "makeItemNonConversational"),
  b("visible_bundle", "visibleBundle"),
  b("visible_guide", "visibleGuide"),
  b("visible_standalone", "visibleStandalone"),
];
/** `CatalogItem` only: fulfilment, pricing, legacy cart, portal settings, delivery and access. */
const CATALOG_ITEM: UiProp[] = [
  ...CATALOG_BASE,
  {
    prop: "fulfillmentAutomationLevel",
    field: "fulfillment_automation_level",
    as: {
      map: {
        unspecified: "unspecified",
        manual: "manual",
        semi_automated: "semiAutomated",
        fully_automated: "fullyAutomated",
      },
    },
  },
  ref("group", "fulfillmentGroup", "sys_user_group"),
  ref("delivery_plan", "executionPlan", "sc_cat_item_delivery_plan"),
  ref("flow_designer_flow", "flow", "sys_hub_flow"),
  ref("workflow", "workflow", "wf_workflow"),
  n("cost"),
  p("display_price_property", "displayPriceProperty"),
  b("ignore_price", "ignorePrice"),
  b("mobile_hide_price", "mobileHidePrice"),
  b("omit_price", "omitPrice"),
  b("billable"),
  p("recurring_frequency", "recurringFrequency"),
  b("no_cart", "noCart"),
  b("no_order", "noOrder"),
  b("no_order_now", "noOrderNow"),
  b("no_proceed_checkout", "noProceedCheckout"),
  b("no_quantity", "noQuantity"),
  p("request_method", "requestMethod"),
  ref("custom_cart", "customCart", "sys_ui_macro"),
  b("use_sc_layout", "useScLayout"),
  s("delivery_plan_script", "deliveryPlanScript"),
  s("entitlement_script", "entitlementScript"),
  p("access_type", "accessType"),
  ref("location", "location", "cmn_location"),
  ref("vendor", "vendor", "core_company"),
];
const RECORD_PRODUCER: UiProp[] = [
  ...CATALOG_BASE,
  p("table_name", "table"),
  s("script", "script"),
  s("post_insert_script", "postInsertScript"),
  s("save_script", "saveScript"),
  p("save_options", "saveOptions"),
  b("allow_edit", "allowEdit"),
  b("can_cancel", "canCancel"),
  {
    prop: "redirectUrl",
    field: "redirect_url",
    as: {
      map: {
        generated_record: "generatedRecord",
        catalog_home: "catalogHomePage",
      },
    },
  },
];
const IO_SET: UiProp[] = [
  ref("variable_set", "variableSet", "item_option_new_set"),
  n("order"),
];
const VARIABLE_SET: UiProp[] = [
  p("title"),
  p("internal_name", "internalName"),
  p("name"),
  p("description"),
  {
    prop: "type",
    field: "type",
    as: { map: { one_to_one: "singleRow", one_to_many: "multiRow" } },
  },
  n("order"),
  p("layout"),
  b("display_title", "displayTitle"),
  p("set_attributes", "setAttributes"),
  n("version"),
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
  "7": "Checkbox",
  "8": "Reference",
  "9": "Date",
  "10": "DateTime",
  "11": "Label",
  "12": "Break",
  "14": "Custom",
  "15": "UIPage",
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

/** The properties every variable kind has (`Break`, `ContainerEnd` and `ContainerSplit` have only these). */
const VAR_CORE: UiProp[] = [
  n("order"),
  b("active"),
  b("disable_initial_slot_fill", "disableInitialSlotFill"),
];
const VAR_QUESTION = p("question_text", "question");
/** `BaseVariableConfig` apart from `question` and the core. */
const VAR_BASE: UiProp[] = [
  p("conversational_label", "conversationalLabel"),
  p("tooltip"),
  p("example_text", "exampleText"),
  b("show_help", "showHelp"),
  p("help_tag", "helpTag"),
  p("help_text", "helpText"),
  p("instructions"),
  n("variable_width", "width"),
  p("attributes"),
  p("default_value", "defaultValue"),
  list("read_roles", "readRoles"),
  list("write_roles", "writeRoles"),
  list("create_roles", "createRoles"),
  b("visible_bundle", "visibleBundle"),
  b("visible_guide", "visibleGuide"),
  b("visible_standalone", "visibleStandalone"),
  b("visible_summary", "visibleSummary"),
  b("not_available_conversation", "removeFromConversationalInterfaces"),
  b("map_to_field", "mapToField"),
  { ...p("field"), when: (r) => snString(r.map_to_field) === "true" },
  b("show_help_on_load", "alwaysExpand"),
  p("description"),
  b("global"),
  ref("delivery_plan", "deliveryPlan", "sc_cat_item_delivery_plan"),
  {
    prop: "visibility",
    field: "visibility",
    as: { map: { "1": "Always", "2": "Bundle", "3": "Standalone" } },
  },
  p("category"),
  b("pricing_implications", "pricingImplications"),
  b("use_dynamic_default", "useDynamicDefault"),
  b("unique"),
  s("read_script", "readScript"),
  s("post_insert_script", "postInsertScript"),
  p("dynamic_value_dot_walk_path", "dotWalkPath"),
  p("dynamic_value_field", "dependentQuestion"),
];
/** `VariableConfig`: the interactive kinds. */
const VAR_INTERACTIVE: UiProp[] = [
  b("mandatory"),
  b("read_only", "readOnly"),
  b("hidden"),
];
const qualifier = (mode: string) => (r: SnRecord) =>
  snString(r.use_reference_qualifier) === mode;
const VAR_QUALIFIER: UiProp[] = [
  p("use_reference_qualifier", "useReferenceQualifier"),
  {
    ...p("reference_qual_condition", "referenceQualCondition"),
    when: qualifier("simple"),
  },
  { ...p("dynamic_ref_qual", "dynamicRefQual"), when: qualifier("dynamic") },
  { ...p("reference_qual", "referenceQual"), when: qualifier("advanced") },
];
const fromChoices = (r: SnRecord) => snString(r.lookup_source) === "choices";
const fromTable = (r: SnRecord) => !fromChoices(r);
const VAR_LOOKUP: UiProp[] = [
  p("choice_direction", "choiceDirection"),
  b("include_none", "includeNone"),
  b("lookup_unique", "uniqueValuesOnly"),
  p("reference_qual", "referenceQual"),
  { ...p("lookup_source", "lookupSource"), when: fromChoices },
  { ...p("choice_table", "choiceTable"), when: fromChoices },
  { ...p("choice_field", "choiceField"), when: fromChoices },
  {
    ...p("lookup_dependent_question", "choicesDependOn"),
    when: fromChoices,
  },
  { ...p("lookup_table", "lookupFromTable"), when: fromTable },
  { ...p("lookup_value", "lookupValueField"), when: fromTable },
  { ...list("lookup_label", "lookupLabelFields"), when: fromTable },
  { ...p("lookup_price", "lookupPriceField"), when: fromTable },
  { ...p("rec_lookup_price", "lookupRecurringPriceField"), when: fromTable },
];
const VAR_CUSTOM: UiProp[] = [
  ref("macro", "macro", "sys_ui_macro"),
  ref("summary_macro", "summaryMacro", "sys_ui_macro"),
  ref("sp_widget", "widget", "sp_widget"),
  ref("macroponent", "macroponent", "sys_ux_macroponent"),
  ref("topic_block", "topicBlock", "sys_cs_topic"),
];
const VAR_SINGLE_LINE: UiProp[] = [p("validate_regex", "validateRegex")];

/** Each kind's own properties on top of the base (and, unless listed in VAR_NOT_INTERACTIVE, the interactive ones). */
const VARIABLE_EXTRA: Readonly<Record<string, readonly UiProp[]>> = {
  Reference: [
    p("reference", "referenceTable"),
    list("delete_roles", "deleteRoles"),
    ...VAR_QUALIFIER,
  ],
  RequestedFor: [
    b("enable_also_request_for", "enableAlsoRequestFor"),
    list("roles_to_use_also_request_for", "rolesToUseAlsoRequestFor"),
    ...VAR_QUALIFIER,
  ],
  LookupSelectBox: VAR_LOOKUP,
  LookupMultipleChoice: VAR_LOOKUP,
  ListCollector: [
    p("list_table", "listTable"),
    p("reference_qual", "referenceQual"),
  ],
  SelectBox: [
    p("choice_table", "choiceTable"),
    p("choice_field", "choiceField"),
    b("include_none", "includeNone"),
    b("lookup_unique", "uniqueValuesOnly"),
  ],
  MultipleChoice: [
    p("choice_direction", "choiceDirection"),
    b("include_none", "includeNone"),
    b("do_not_select_first", "doNotSelectFirstChoice"),
  ],
  NumericScale: [
    n("scale_min", "scaleMin"),
    n("scale_max", "scaleMax"),
    b("do_not_select_first", "doNotSelectFirstChoice"),
  ],
  Custom: VAR_CUSTOM,
  CustomWithLabel: VAR_CUSTOM,
  Masked: [
    b("mask_use_confirmation", "useConfirmation"),
    b("mask_use_encryption", "useEncryption"),
  ],
  Html: [p("default_html_value", "defaultHTML")],
  RichTextLabel: [p("rich_text", "richText")],
  SingleLineText: VAR_SINGLE_LINE,
  WideSingleLineText: VAR_SINGLE_LINE,
  YesNo: [b("include_none", "includeNone")],
  UIPage: [ref("ui_page", "uiPage", "sys_ui_page")],
  Checkbox: [
    b("mandatory", "selectionRequired"),
    b("read_only", "readOnly"),
    b("hidden"),
  ],
  ContainerStart: [p("layout"), b("display_title", "displayTitle")],
};
/** Kinds typed as `BaseVariableConfig` (no mandatory / readOnly / hidden). */
const VAR_NOT_INTERACTIVE = new Set([
  "Custom",
  "CustomWithLabel",
  "RichTextLabel",
  "UIPage",
  "Checkbox",
  "ContainerStart",
  "Label",
]);
const VAR_MINIMAL = new Set(["Break", "ContainerEnd", "ContainerSplit"]);
/** Kinds whose type omits or relaxes `question`. */
const VAR_NO_QUESTION = new Set(["RichTextLabel", ...VAR_MINIMAL]);

/** The properties of one variable kind. */
function variableSpecs(kind: string): UiProp[] {
  if (VAR_MINIMAL.has(kind)) return VAR_CORE;
  return [
    ...(VAR_NO_QUESTION.has(kind) ? [] : [VAR_QUESTION]),
    ...VAR_CORE,
    ...VAR_BASE,
    ...(VAR_NOT_INTERACTIVE.has(kind) ? [] : VAR_INTERACTIVE),
    ...(VARIABLE_EXTRA[kind] ?? []),
  ];
}
/** Every field some variable kind maps: a field another kind does not have is dropped silently, as the SDK does. */
const VARIABLE_FIELDS: readonly string[] = [
  ...new Set(
    [
      VAR_QUESTION,
      ...VAR_CORE,
      ...VAR_BASE,
      ...VAR_INTERACTIVE,
      ...Object.values(VARIABLE_EXTRA).flat(),
    ].map((x) => x.field),
  ),
];
/** Kinds with a `choices` object. */
const VAR_CHOICES = new Set(["MultipleChoice", "SelectBox"]);
const CHOICE: UiProp[] = [
  p("text", "label"),
  n("order", "sequence"),
  b("inactive"),
];
const CATALOG_APPLIES: UiProp[] = [
  b("applies_catalog", "appliesOnCatalogItemView"),
  b("applies_req_item", "appliesOnRequestedItems"),
  b("applies_sc_task", "appliesOnCatalogTasks"),
  b("applies_target_record", "appliesOnTargetRecord"),
];
const UI_TYPE: UiConv = {
  map: { "0": "desktop", "1": "mobileOrServicePortal", "10": "all" },
};
const CLIENT_SCRIPT: UiProp[] = [
  p("name"),
  p("applies_to", "appliesTo"),
  ref("cat_item", "catalogItem", "sc_cat_item"),
  ref("variable_set", "variableSet", "item_option_new_set"),
  p("type"),
  { prop: "variableName", field: "cat_variable", as: "io" },
  { prop: "uiType", field: "ui_type", as: UI_TYPE },
  b("active"),
  b("global"),
  b("isolate_script", "isolateScript"),
  ...CATALOG_APPLIES,
  b("va_supported", "vaSupported"),
  p("published_ref", "publishedRef"),
  n("order"),
  s("script", "script"),
];
const UI_POLICY: UiProp[] = [
  p("short_description", "shortDescription"),
  p("description"),
  p("applies_to", "appliesTo"),
  ref("catalog_item", "catalogItem", "sc_cat_item"),
  ref("variable_set", "variableSet", "item_option_new_set"),
  { prop: "catalogCondition", field: "catalog_conditions", as: "io" },
  n("order"),
  b("active"),
  b("global"),
  b("on_load", "onLoad"),
  b("reverse_if_false", "reverseIfFalse"),
  b("run_scripts", "runScripts"),
  { prop: "runScriptsInUiType", field: "ui_type", as: UI_TYPE },
  b("isolate_script", "isolateScript"),
  ...CATALOG_APPLIES,
  b("va_supported", "vaSupported"),
  s("script_true", "executeIfTrue"),
  s("script_false", "executeIfFalse"),
];
const UI_POLICY_SHAPE = { clientFields: ["script_true", "script_false"] };
const UI_POLICY_ACTION: UiProp[] = [
  { prop: "variableName", field: "catalog_variable", as: "io" },
  tri("visible"),
  tri("mandatory"),
  tri("disabled", "readOnly"),
  tri("cleared"),
  n("order"),
  p("value"),
  {
    prop: "valueAction",
    field: "value_action",
    as: {
      map: { clear_value: "clearValue", set_value: "setValue" },
      omit: ["ignore"],
    },
  },
  p("field_message", "variableMessage"),
  {
    prop: "variableMessageType",
    field: "field_message_type",
    as: {
      map: { info: "info", warning: "warning", error: "error" },
      omit: ["none"],
    },
  },
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
function jsonValue(run: EmitRun, value: string): Expr {
  try {
    return jsonExpr(redactJson(run, JSON.parse(value)));
  } catch {
    return lit(value);
  }
}

/** A parsed JSON value with every credential-like key's value replaced by the placeholder. */
function redactJson(run: EmitRun, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => redactJson(run, x));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const leaf = x === null || typeof x !== "object";
    if (leaf && isSecret(k, String(x ?? ""), [], [], run.rules)) {
      run.secrets++;
      out[k] = SECRET_PLACEHOLDER;
    } else out[k] = redactJson(run, x);
  }
  return out;
}

/**
 * A widget `option_schema`: the SDK's `WidgetOption[]` takes camelCase keys
 * (`default_value` → `defaultValue`) and requires `label` and `section`.
 */
function widgetOptions(value: string): { expr?: Expr; problem?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { problem: "option_schema is not JSON" };
  }
  if (!Array.isArray(parsed)) return { expr: jsonExpr(parsed) };
  const options = parsed.map((o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return o;
    const src = o as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) out[camel(k)] = src[k];
    out.label ??= out.name;
    out.section ??= "other";
    out.type ??= "string";
    return out;
  });
  return { expr: jsonExpr(options) };
}

/** snake_case → camelCase. */
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
  withId = true,
): { props: Prop[]; unmapped: string[]; problems: [string, string][] } {
  const props: Prop[] = withId
    ? [{ key: "$id", value: code(`Now.ID[${tsString(key)}]`) }]
    : [];
  const consumed = new Set<string>([...skip, shape.scopeField ?? "sys_scope"]);
  const problems: [string, string][] = [];
  for (const spec of specs) {
    consumed.add(spec.field);
    const value = snString(rec[spec.field]);
    if (value === "") continue;
    if (spec.when && !spec.when(rec)) continue;
    if (isSecret(spec.field, value, shape.secretFields, [], run.rules)) {
      props.push(secretProp(run, spec.prop));
      continue;
    }
    const as = spec.as;
    if (as === "derived") continue;
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
      expr = jsonValue(run, value);
    } else if (as === "widgetOptions") {
      ({ expr, problem } = widgetOptions(value));
    } else if (as === "io") {
      expr = lit(value.replace(/IO:/g, ""));
    } else if (typeof as === "object" && "omit" in as) {
      if (!as.omit.includes(value)) ({ expr, problem } = convert(value, as));
    } else if (as === "tristate") {
      if (value !== "ignore") ({ expr, problem } = convert(value, "boolean"));
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

  /** Mark a row consumed by a derived property (not emitted on its own). */
  place(row: SnRecord): void {
    this.placed.add(row);
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

  /** The artefact's own call arguments (`withId` false: the API has no `$id`). */
  topProps(
    specs: readonly UiProp[],
    api: string,
    extra?: Partial<Shape>,
    withId = true,
  ): Prop[] {
    const out = args(
      this.run,
      { ...this.t, ...extra },
      specs,
      this.rec,
      this.key,
      [],
      withId,
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

  /**
   * A nested child object's properties (the row is placed). `withId` false:
   * the SDK structure has no `$id` (the row's sys_id is not kept and no key
   * is registered).
   */
  childProps(
    table: string,
    row: SnRecord,
    specs: readonly UiProp[],
    api: string,
    skip: readonly string[],
    opts: { owner?: string; shape?: Partial<Shape>; withId?: boolean } = {},
  ): Prop[] {
    this.placed.add(row);
    const withId = opts.withId ?? true;
    const key = withId
      ? this.childKey(table, row, opts.owner)
      : `${opts.owner ?? this.key}__${fluentSlug(table)}_${id8(row)}`;
    if (!withId) this.note(NO_ID_NOTE);
    const out = args(
      this.run,
      this.shape(table, opts.shape),
      specs,
      row,
      key,
      skip,
      withId,
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

function widget(api: string, specs: readonly UiProp[] = WIDGET): Build {
  return (tree) => {
    const props = tree.topProps(specs, api, WIDGET_SHAPE);
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
  // SPPage has no $id: the SDK mints the page's sys_id (P-29 oracle).
  tree.note(PAGE_ID_NOTE);
  const props = tree.topProps(PAGE, api, { markupFields: ["css"] }, false);
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
      const items = tree.rows(table, parentField, tree.sysId).map((r) =>
        obj(
          tree.childProps(table, r, rowSpecs, api, [parentField], {
            withId: false,
          }),
        ),
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

/** The `chrome_tab` page property's new-tab tables (`newTabMenu[].routeInfo.fields.table`). */
function chromeTabTables(value: string): string[] | undefined {
  try {
    const menu = (JSON.parse(value) as { newTabMenu?: unknown }).newTabMenu;
    if (!Array.isArray(menu)) return undefined;
    const tables = menu
      .map(
        (m) =>
          (m as { routeInfo?: { fields?: { table?: unknown } } })?.routeInfo
            ?.fields?.table,
      )
      .filter((t): t is string => typeof t === "string" && t !== "");
    return [...new Set(tables)];
  } catch {
    return undefined;
  }
}

const workspace: Build = (tree) => {
  const api = "Workspace";
  const props = tree.topProps(WORKSPACE, api);
  // Only two page properties have a Workspace form: listConfigId (listConfig)
  // and chrome_tab (tables). The others stay Record() rows (finish()).
  for (const r of tree.rows("sys_ux_page_property", "page", tree.sysId)) {
    const name = snString(r.name);
    const value = snString(r.value);
    if (name === "listConfigId" && value) {
      props.push({
        key: "listConfig",
        value: refExpr("sys_ux_list_menu_config", value),
      });
      tree.place(r);
    } else if (name === "chrome_tab") {
      const tables = chromeTabTables(value);
      if (!tables) continue;
      if (tables.length) {
        props.push({ key: "tables", value: arr(tables.map((t) => lit(t))) });
      }
      tree.place(r);
    }
  }
  // The type marks `tables` optional, but now-sdk build reads it as an array
  // (WorkspacePlugin: "Failed to cast UndefinedShape to ArrayShape").
  if (!props.some((x) => x.key === "tables")) {
    props.push({ key: "tables", value: arr([]) });
  }
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

/**
 * A dashboard widget: `x` / `y` become `position`; `componentProps`, `height`
 * and `width` are required (the SDK reads the `h` / `w` columns; a row that
 * carries `height` / `width` instead is accepted too).
 */
function dashboardWidget(tree: UiTree, row: SnRecord, api: string): Expr {
  const props = tree.childProps("par_dashboard_widget", row, DASH_WIDGET, api, [
    "tab",
    "height",
    "width",
  ]);
  if (!props.some((x) => x.key === "componentProps")) {
    props.push({ key: "componentProps", value: obj([]) });
  }
  const coord = (f: string, fallback = "0"): Expr =>
    convert(snString(row[f]) || fallback, "number").expr ??
    lit(Number(fallback));
  for (const key of ["height", "width"] as const) {
    if (!props.some((x) => x.key === key)) {
      props.push({ key, value: coord(key, "1") });
    }
  }
  props.push({
    key: "position",
    value: obj([
      { key: "x", value: coord("x") },
      { key: "y", value: coord("y") },
    ]),
  });
  return obj(props);
}

const dashboard: Build = (tree) => {
  const api = "Dashboard";
  const props = tree.topProps(DASHBOARD, api);
  const tabs = tree
    .rows("par_dashboard_tab", "dashboard", tree.sysId)
    .map((tab) => {
      const tp = tree.childProps("par_dashboard_tab", tab, DASH_TAB, api, [
        "dashboard",
      ]);
      const widgets = tree
        .rows("par_dashboard_widget", "tab", snString(tab.sys_id))
        .map((w) => dashboardWidget(tree, w, api));
      // `widgets` is required on a tab.
      tp.push({ key: "widgets", value: arr(widgets) });
      return obj(tp);
    });
  withList(props, "tabs", tabs);
  const permissions = tree
    .rows("par_dashboard_permission", "dashboard", tree.sysId)
    .map((r) =>
      obj(
        tree.childProps("par_dashboard_permission", r, DASH_PERMISSION, api, [
          "dashboard",
        ]),
      ),
    );
  withList(props, "permissions", permissions);
  tree.call(api, props);
};

const listMenu: Build = (tree) => {
  const api = "UxListMenuConfig";
  const props = tree.topProps(LIST_MENU, api);
  const categories = tree
    .rows("sys_ux_list_category", "configuration", tree.sysId)
    .map((cat) => {
      const cp = tree.childProps(
        "sys_ux_list_category",
        cat,
        LIST_CATEGORY,
        api,
        ["configuration"],
      );
      const lists = tree
        .rows("sys_ux_list", "category", snString(cat.sys_id))
        .map((l) =>
          obj(tree.childProps("sys_ux_list", l, UX_LIST, api, ["category"])),
        );
      // `lists` is required on a category.
      cp.push({ key: "lists", value: arr(lists) });
      return obj(cp);
    });
  tree.call(api, withList(props, "categories", categories));
};

// The applicability's list links (sys_ux_applicability_m2m_list) belong to the
// list (UxList.applicabilities), not to the Applicability: finish() emits them
// as Record() rows.
const applicability: Build = simple("Applicability", APPLICABILITY);

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
    const specs = variableSpecs(kind);
    const own = new Set(specs.map((x) => x.field));
    const props = tree.childProps(
      "item_option_new",
      row,
      specs,
      variableApi,
      [
        parentField,
        "type",
        "name",
        // The lookup / reference mode a `when` reads; other kinds' fields.
        "lookup_source",
        ...VARIABLE_FIELDS.filter((f) => !own.has(f)),
      ],
      { owner, withId: false },
    );
    if (
      !VAR_NO_QUESTION.has(kind) &&
      !props.some((x) => x.key === "question")
    ) {
      props.unshift({ key: "question", value: lit("") });
    }
    // `choices` is an object keyed by the choice value (choice kinds only).
    const choices: Prop[] = [];
    for (const c of tree.rows("question_choice", "question", sysId)) {
      if (!VAR_CHOICES.has(kind)) {
        tree.later("question_choice", "question", c);
        continue;
      }
      const value = snString(c.value);
      if (!value || choices.some((x) => x.key === value)) {
        tree.later("question_choice", "question", c);
        continue;
      }
      choices.push({
        key: value,
        value: obj(
          tree.childProps(
            "question_choice",
            c,
            CHOICE,
            variableApi,
            ["question", "value"],
            { owner, withId: false },
          ),
        ),
      });
    }
    if (choices.length) props.push({ key: "choices", value: obj(choices) });
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
          { owner, withId: false },
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

function catalogItem(api: string, specs: readonly UiProp[]): Build {
  return (tree) => {
    const props = tree.topProps(specs, api);
    // PortalSettings: `hideAttachment` must be false (or absent) when
    // `mandatoryAttachment` is true; the platform ignores it then.
    const mandatory = props.find((x) => x.key === "mandatoryAttachment");
    if (mandatory && render(mandatory.value) === "true") {
      const i = props.findIndex((x) => x.key === "hideAttachment");
      if (i >= 0) props.splice(i, 1);
    }
    const vars = variables(tree, "cat_item", tree.sysId, tree.key, api);
    if (vars.length) props.push({ key: "variables", value: obj(vars) });
    const sets = tree.rows("io_set_item", "sc_cat_item", tree.sysId);
    withList(
      props,
      "variableSets",
      sets.map((r) => {
        const link = tree.childProps(
          "io_set_item",
          r,
          IO_SET,
          api,
          ["sc_cat_item"],
          { withId: false },
        );
        // `order` is required on a variable-set link (the SDK defaults it to 0).
        if (!link.some((x) => x.key === "order")) {
          link.push({ key: "order", value: lit(0) });
        }
        return obj(link);
      }),
    );
    const categories = tree.refs(
      "sc_cat_item_category",
      "sc_cat_item",
      "sc_category",
      "sc_category",
      api,
    );
    // No m2m rows: the item's own `category` field, as the SDK reads it.
    const category = snString(tree.rec.category);
    if (!categories.length && category) {
      categories.push(refExpr("sc_category", category));
    }
    withList(props, "categories", categories);
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
  sp_header_footer: {
    api: "SPHeaderFooter",
    build: widget("SPHeaderFooter", HEADER_FOOTER),
  },
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
  catalog_item: {
    api: "CatalogItem",
    build: catalogItem("CatalogItem", CATALOG_ITEM),
  },
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
  tree.note(UI_VERIFIED_NOTE);
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
