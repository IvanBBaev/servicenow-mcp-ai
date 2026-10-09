import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
import { type Conv } from "./fluent-emit.js";

/**
 * P-28 property specs: how each portal, workspace and catalog field maps
 * onto its Fluent property (data for the builders in `src/api/fluent-ui.ts`),
 * and `camel`, which the specs call while the module loads.
 */

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

export interface UiProp {
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
export const WIDGET: UiProp[] = [
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
export const HEADER_FOOTER: UiProp[] = [...WIDGET, b("static")];

export const WIDGET_SHAPE = {
  clientFields: ["client_script", "link"],
  markupFields: ["template", "css"],
};

export const NG_TEMPLATE: UiProp[] = [p("id"), s("template", "htmlTemplate")];

export const PAGE: UiProp[] = [
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

export const CONTAINER: UiProp[] = [
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

export const ROW: UiProp[] = [
  p("class_name", "cssClass"),
  p("semantic_tag", "semanticTag"),
  n("order"),
];

export const COLUMN: UiProp[] = [
  n("size"),
  n("size_sm", "sizeSm"),
  n("size_xs", "sizeXs"),
  n("size_lg", "sizeLg"),
  p("class_name", "cssClass"),
  p("semantic_tag", "semanticTag"),
  n("order"),
];

export const INSTANCE: UiProp[] = [
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

export const PORTAL: UiProp[] = [
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

export const THEME: UiProp[] = [
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

export const THEME_JS: UiProp[] = [
  ref("sp_js_include", "include", "sp_js_include"),
  n("order"),
];

export const THEME_CSS: UiProp[] = [
  ref("sp_css_include", "include", "sp_css_include"),
  n("order"),
];

export const MENU: UiProp[] = [
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

export const MENU_ITEM: UiProp[] = [
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

export const ROUTE_MAP: UiProp[] = [
  p("short_description", "shortDescription"),
  ref("route_from_page", "routeFromPage", "sp_page"),
  ref("route_to_page", "routeToPage", "sp_page"),
  refList("portals", "portals", "sp_portal"),
  list("roles"),
  b("active"),
  n("order"),
];

export const DEPENDENCY: UiProp[] = [
  p("name"),
  p("module", "angularModuleName"),
  b("include_on_page_load", "includeOnPageLoad"),
];

export const ANGULAR_PROVIDER: UiProp[] = [
  p("name"),
  p("type"),
  s("script", "script"),
];

export const JS_INCLUDE: UiProp[] = [
  p("display_name", "name"),
  derived("source"),
  p("url"),
  ref("sys_ui_script", "sysUiScript", "sys_ui_script"),
];

export const CSS_INCLUDE: UiProp[] = [
  p("name"),
  derived("source"),
  p("url"),
  ref("sp_css", "spCss", "sp_css"),
  p("rtl_css_file_url", "rtlCssUrl"),
  b("lazy_load", "lazyLoad"),
];

export const WORKSPACE: UiProp[] = [
  p("title"),
  p("path"),
  b("active"),
  n("order"),
];

export const DASHBOARD: UiProp[] = [
  p("name"),
  p("description"),
  b("active"),
  b("certified"),
];

export const DASH_TAB: UiProp[] = [p("name"), b("active"), derived("order")];

export const DASH_WIDGET: UiProp[] = [
  p("component"),
  json("component_props", "componentProps"),
  n("h", "height"),
  n("w", "width"),
  derived("x"),
  derived("y"),
];

export const DASH_PERMISSION: UiProp[] = [
  ref("user", "user", "sys_user"),
  ref("group", "group", "sys_user_group"),
  ref("role", "role", "sys_user_role"),
  b("can_read", "canRead"),
  b("can_write", "canWrite"),
  b("can_share", "canShare"),
  b("owner"),
];

export const LIST_MENU: UiProp[] = [p("name"), p("description"), b("active")];

export const LIST_CATEGORY: UiProp[] = [
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

export const UX_LIST: UiProp[] = [
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

export const APPLICABILITY: UiProp[] = [
  p("name"),
  p("description"),
  b("active"),
  list("roles"),
  p("role_names", "roleNames"),
];

// Catalog specs follow the SDK 4.13.6 record → Fluent transforms
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
export const CATALOG_ITEM: UiProp[] = [
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

export const RECORD_PRODUCER: UiProp[] = [
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

export const IO_SET: UiProp[] = [
  ref("variable_set", "variableSet", "item_option_new_set"),
  n("order"),
];

export const VARIABLE_SET: UiProp[] = [
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
export const VARIABLE_API: Readonly<Record<string, string>> = {
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
export const VAR_NO_QUESTION = new Set(["RichTextLabel", ...VAR_MINIMAL]);

/** The properties of one variable kind. */
export function variableSpecs(kind: string): UiProp[] {
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
export const VARIABLE_FIELDS: readonly string[] = [
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
export const VAR_CHOICES = new Set(["MultipleChoice", "SelectBox"]);

export const CHOICE: UiProp[] = [
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

export const CLIENT_SCRIPT: UiProp[] = [
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

export const UI_POLICY: UiProp[] = [
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

export const UI_POLICY_SHAPE = {
  clientFields: ["script_true", "script_false"],
};

export const UI_POLICY_ACTION: UiProp[] = [
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

/** snake_case → camelCase. */
export function camel(field: string): string {
  return field.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}
