/**
 * P-1 — the artefact registry (project/SDK-PARITY.md §5(a)).
 *
 * One data-driven list of every ServiceNow artefact type the server knows:
 * where it lives (primary table + ordered child tables), how it is named and
 * keyed, which fields hold script bodies, encoded JSON, dependency references
 * or credential material, and which ServiceNow SDK (Fluent) API describes it.
 * It holds data, not behaviour: readers, decoders and tree builders are keyed
 * by descriptor elsewhere.
 *
 * Descriptors flagged `scriptTools: true` are served by the script-intelligence
 * tools (list / get / search_code / where_used / lint_script / snapshot /
 * compare / check_code_health); `SCRIPT_TYPES` in `src/api/scripts.ts` is a derived
 * view over exactly those, in registry order. The nine legacy script types
 * (`business_rule` … `acl`) come first and are `verified:true`; S-4 widened the
 * view to the other script-bearing tables (portal widgets, UI pages / scripts /
 * macros, processors, email / fix / validation scripts, transform maps and
 * entries, script actions, catalog client scripts, data sources, REST message
 * functions, dictionary calculations and defaults), all `verified:false`. The
 * remaining descriptors are seeds for the epic's generic tools (P-5 onwards).
 *
 * P-9 completed the Next Experience, UI Builder, Service Portal, Flow Designer
 * and legacy-workflow rows at the R tier. Their script-bearing tables (UIB
 * client scripts and data brokers, Angular providers and templates, portal
 * themes / CSS / search sources) are `scriptToolsOptIn`: reachable through the
 * script tools only on explicit request, so the default sweep is unchanged.
 *
 * P-8 added the Service Catalog definition records (items, record producers,
 * variable sets, variables, catalog client scripts and UI policies), the ATF /
 * scan-check / assessment rows, the AI Agent and Now Assist rows and the
 * application / dependency / customer-update / source-control rows. The AI
 * rows carry `licensed`: on an instance without the plugin they answer
 * `available:false` instead of an error.
 *
 * N-8 added reports and Performance Analytics (the `reporting` group): report
 * definitions and report sources, PA indicators, indicator sources, breakdowns,
 * PA scripts and PA dashboards, all read-only (R + X) seeds with reference
 * fields, so `list_artifacts`, `explain_artifact`, `artifact_dependencies`,
 * `document_app` and snapshot / compare cover them without new tools. The PA
 * rows carry `licensed` (gate O-9). PA scripts hold a script field but are not
 * script-tools types, so no tool enum grows.
 *
 * `verified:false` means gate O-5 has not confirmed the table and field names on
 * a live instance; names come from the 2026-09-23 SDK coverage inventory, and
 * anything the inventory marked (U) is unverified by definition.
 */

/** The ServiceNow SDK release every `sdkSince` value is measured against. */
export const SDK_BASELINE = "4.12.2";

/**
 * Fluent API names published in SDK {@link SDK_BASELINE} (gap matrix §4), plus
 * `Record` — the generic fallback for tables without a dedicated API. P-4 diffs
 * this list against the SDK docs index. `next`-only APIs (4.13 `DatabaseView`)
 * are deliberately absent until they reach `latest`.
 */
export const SDK_APIS = [
  // Core platform / data model
  "Table",
  "ChoiceSet",
  "StateModel",
  "Property",
  "UserPreference",
  "Role",
  "Acl",
  "CrossScopePrivilege",
  "UserCriteria",
  "Record",
  // Server-side logic
  "BusinessRule",
  "ScriptInclude",
  "ScriptAction",
  "ScheduledScript",
  "RestApi",
  "RestMessage",
  "GraphQLApi",
  "Alias",
  "AliasTemplate",
  "RetryPolicy",
  "DataLookup",
  "ImportSet",
  "EmailNotification",
  "InboundEmailAction",
  "Sla",
  // Classic UI
  "ClientScript",
  "UiAction",
  "UiPolicy",
  "DataPolicy",
  "UiPage",
  "Form",
  "List",
  "ApplicationMenu",
  // Next Experience
  "Workspace",
  "Dashboard",
  "UxListMenuConfig",
  "Applicability",
  // Service Portal
  "ServicePortal",
  "SPWidget",
  "SPWidgetDependency",
  "SPAngularProvider",
  "JsInclude",
  "CssInclude",
  "SPPage",
  "SPTheme",
  "SPMenu",
  "SPHeaderFooter",
  "SPPageRouteMap",
  // Flow Designer / Workflow Studio
  "Flow",
  "Subflow",
  "Action",
  "PlaybookDefinition",
  // Service Catalog
  "CatalogItem",
  "CatalogItemRecordProducer",
  "VariableSet",
  "CatalogClientScript",
  "CatalogUiPolicy",
  // Testing, quality and assessment
  "Test",
  "TestSuite",
  "LinterCheck",
  "ScriptOnlyCheck",
  "ColumnTypeCheck",
  "TableCheck",
  "Assessment",
  "RiskAssessment",
  // AI
  "AiAgent",
  "AiAgenticWorkflow",
  "NowAssistSkillConfig",
] as const;

/**
 * Fluent APIs published only on the npm `next` dist-tag (SDK-PARITY §2 rule 4).
 * A descriptor may name one only while it is `verified:false` and has no G
 * tier; the API moves to {@link SDK_APIS} once it reaches `latest` and O-5
 * confirms its tables. `scripts/sdk-drift.mjs` reports these as known.
 */
export const SDK_NEXT_APIS = ["DatabaseView"] as const;

/**
 * A Fluent API name on the baseline (or `next`-only, see
 * {@link SDK_NEXT_APIS}), or `none` when the SDK has no API.
 */
export type SdkApi =
  | (typeof SDK_APIS)[number]
  | (typeof SDK_NEXT_APIS)[number]
  | "none";

/**
 * Decoders a `jsonFields` entry may name. `json` is a tolerant JSON parse;
 * `flow-values` is the Flow Designer `values` format (plain or base64 + gzip
 * JSON, P-10); `uib-composition` is the UI Builder macroponent layout (P-14).
 */
export const DECODER_IDS = ["json", "flow-values", "uib-composition"] as const;
export type DecoderId = (typeof DECODER_IDS)[number];

/** Gap-matrix groups (SDK-PARITY.md §4.1 … §4.13). */
export const ARTIFACT_GROUPS = [
  "core",
  "server",
  "classic-ui",
  "next-experience",
  "uib",
  "portal",
  "flow",
  "workflow",
  "catalog",
  "quality",
  "ai",
  "application",
  "reporting",
] as const;
export type ArtifactGroup = (typeof ARTIFACT_GROUPS)[number];

/** Capability tiers (SDK-PARITY.md §3). */
export type Tier = "R" | "X" | "A" | "S" | "W" | "G";

/** A field holding encoded JSON and how to read it. */
export interface JsonField {
  field: string;
  decoder: DecoderId;
  /** `false` = plan-only: writes are previewed, never applied (§5(c)). */
  writable: boolean;
}

/** A reference field that forms a dependency edge. */
export interface RefField {
  field: string;
  /** Table the reference points at. */
  table: string;
  /** Registry type of the target, when that table is a registered type. */
  type?: string;
}

/** A child table read together with its parent artefact. */
export interface ArtifactChild {
  table: string;
  /** Reference field on the child pointing at its parent record. */
  parentField: string;
  /**
   * Table `parentField` points at, when the child hangs off another child
   * (`sp_row.sp_container`) rather than the artefact's primary table.
   */
  parentTable?: string;
  /**
   * Field of the parent row whose value `parentField` holds; `sys_id` when
   * absent. Set for children linked by value rather than by reference, e.g.
   * `sys_dictionary.name` = `sys_db_object.name`.
   */
  parentKey?: string;
  /**
   * Further `{field, parentKey}` pairs the child must match on the primary
   * record (a composite link such as `sys_choice` name + element). Only for
   * children of the primary table.
   */
  alsoMatch?: { field: string; parentKey: string }[];
  /** Field that orders siblings, when order matters. */
  orderField?: string;
  nameField?: string;
  scriptFields?: string[];
  jsonFields?: JsonField[];
  refFields?: RefField[];
  /**
   * Further fields `servicenow_upsert_artifact` may write on this child (P-23),
   * besides the ones named above (`nameField`, `orderField`, script, JSON and
   * reference fields). Never `parentField` — the tool sets that link itself.
   */
  writeFields?: string[];
  /** Instance-wide unique fields checked before a write (P-24), see {@link UniqueRule}. */
  unique?: UniqueRule[];
  /** Overrides the parent's `verified` for this child table. */
  verified?: boolean;
}

/** One artefact type (SDK-PARITY.md §5(a)). */
export interface ArtifactType {
  /** Stable id, e.g. `business_rule`, `sp_widget`. */
  type: string;
  group: ArtifactGroup;
  /** Fluent API name, `Record` (generic fallback) or `none`. */
  sdkApi: SdkApi;
  /**
   * SDK version that introduced `sdkApi` (`"<=3.0"` for APIs older than the
   * inventory's release-note window); `null` when `sdkApi` is `none`, or when
   * the inventory does not record the version (O-5 item 1).
   */
  sdkSince: string | null;
  /** Primary table. */
  table: string;
  children: ArtifactChild[];
  /** Field holding the human-readable name. */
  nameField: string;
  /** Natural key (the SDK coalescing key); `["sys_id"]` when there is none. */
  keyFields: string[];
  scopeField: string;
  /** Field holding the active flag; absent when the table has none. */
  activeField?: string;
  /** Field(s) holding executable source code. */
  scriptFields: string[];
  /**
   * Subset of `scriptFields` that runs in the browser: `lint_script` applies
   * the client rule set to these and the server rule set to the rest.
   */
  clientFields?: string[];
  /**
   * Subset of `scriptFields` that is not JavaScript (HTML, Jelly, CSS, request
   * templates): searched by `search_code` / `where_used`, skipped by the linter.
   */
  markupFields?: string[];
  /**
   * Encoded query narrowing the primary table to records of this kind (e.g.
   * dictionary entries that carry a calculation or a scripted default). ANDed
   * into every listing, search, count and diff of the type.
   */
  baseQuery?: string;
  jsonFields: JsonField[];
  refFields: RefField[];
  /** Fields always redacted in results, journals, snapshots and Fluent. */
  secretFields: string[];
  /** Tiers artefact-aware tools serve today (partial coverage counts). */
  tiers: Tier[];
  /** Whether O-5 confirmed the tables and fields on a live instance. */
  verified: boolean;
  /** Listed by the script-intelligence tools (the `SCRIPT_TYPES` view). */
  scriptTools?: boolean;
  /**
   * Served by list_scripts / get_script / search_code only on explicit
   * request (`type`, or search_code `extended:true`), never by the default
   * sweep, where_used, lint_script, check_code_health, snapshot or compare (P-9).
   * Mutually exclusive with `scriptTools`.
   */
  scriptToolsOptIn?: boolean;
  /**
   * The licensed plugin / store app that owns the tables (P-8, O-9). When the
   * primary table is absent, artefact reads answer `available:false` and name
   * it as `requires` instead of failing.
   */
  licensed?: string;
  /** Field referencing the table the artefact applies to, when applicable. */
  appliesToField?: string;
  /** Metadata fields surfaced in script listings (besides name/sys_id/audit). */
  metaFields?: string[];
  /**
   * Fields that say when the artefact runs, for `explain_artifact` (P-6).
   * Absent: a generic trigger list (`when`, `order`, `condition`, …) applies.
   */
  whenFields?: string[];
  /**
   * Further fields `servicenow_upsert_artifact` may write (P-23), besides the
   * ones the descriptor already names (name, key, scope, active, script, JSON,
   * reference, applies-to, meta and when fields).
   */
  writeFields?: string[];
  /**
   * P-24 SDK pre-flight: field sets that must be unique across the instance
   * (`sp_widget.id`, `sp_portal.url_suffix`, …). `servicenow_upsert_artifact`
   * refuses a plan whose written value is already held by another record.
   */
  unique?: UniqueRule[];
  /**
   * P-24 SDK pre-flight (unverified, O-5): fields whose value the ServiceNow
   * SDK expects to start with the application scope name (`x_acme_…`) when
   * the record is created in a non-global scope. `servicenow_upsert_artifact`
   * reports a mismatch as a plan warning, not a refusal.
   */
  scopePrefixFields?: string[];
}

/**
 * One uniqueness rule (P-24): the written values of `fields` may not already
 * be held by another record of `table` (default: the descriptor's table; an
 * extending table such as `sp_header_footer` checks its base `sp_widget`).
 * Empty values are not checked.
 */
export interface UniqueRule {
  fields: string[];
  table?: string;
}

/** Defaults shared by most descriptors (every artefact extends sys_metadata). */
const BASE = {
  children: [] as ArtifactChild[],
  keyFields: ["sys_id"],
  scopeField: "sys_scope",
  jsonFields: [] as JsonField[],
  refFields: [] as RefField[],
  secretFields: [] as string[],
};

/**
 * The script-intelligence tiers of the nine legacy script types: listed and
 * read (R), linted and searched (A), counted and diffed by snapshot / compare
 * (S). The nine are `verified:true` because every release since 1.0 has read
 * them in production.
 */
const SCRIPT_TOOL_TIERS: Tier[] = ["R", "A", "S"];

/** The read tier alone: P-9 descriptors served by the generic artefact tools. */
const READ_TIER: Tier[] = ["R"];

/**
 * Children of a flow or subflow (FLW-4 … FLW-8). Which of the `_v2` / plain
 * instance tables is authoritative per release is O-5 item 5; get_flow reads
 * the plain trigger/action tables today.
 */
const FLOW_CHILDREN: ArtifactChild[] = [
  { table: "sys_hub_trigger_instance", parentField: "flow" },
  {
    table: "sys_hub_action_instance",
    parentField: "flow",
    orderField: "order",
    jsonFields: [{ field: "values", decoder: "flow-values", writable: false }],
  },
  {
    table: "sys_hub_flow_logic_instance_v2",
    parentField: "flow",
    orderField: "order",
    jsonFields: [{ field: "values", decoder: "flow-values", writable: false }],
  },
  {
    table: "sys_hub_sub_flow_instance_v2",
    parentField: "flow",
    orderField: "order",
    jsonFields: [{ field: "values", decoder: "flow-values", writable: false }],
  },
  { table: "sys_hub_flow_input", parentField: "model", nameField: "name" },
  { table: "sys_hub_flow_output", parentField: "model", nameField: "name" },
  {
    table: "sys_hub_flow_variable",
    parentField: "model",
    nameField: "name",
  },
  { table: "sys_hub_flow_stage", parentField: "flow", orderField: "order" },
];

/**
 * P-7: the core, server-logic and classic-UI script types are also explained
 * (X) by `servicenow_explain_artifact`. Their script-tools view is unchanged.
 */
const EXPLAINED_SCRIPT_TIERS: Tier[] = ["R", "X", "A", "S"];

/** P-7 seeds: listed / read by the generic artefact tools and explained. */
const SEED_TIERS: Tier[] = ["R", "X"];

/**
 * P-8: the choices of every variable read so far (item and set variables:
 * child rows accumulate per table, so one read covers both).
 */
const VARIABLE_CHOICES: ArtifactChild[] = [
  {
    table: "question_choice",
    parentField: "question",
    parentTable: "item_option_new",
    orderField: "order",
    nameField: "text",
    // P-24 (U, O-5).
    writeFields: ["value"],
  },
];

/**
 * P-24 (CAT-1 … CAT-3, U until O-5): the variable fields servicenow_upsert_artifact
 * may write besides `name` and `order`. `name` must be a valid variable name.
 */
const VARIABLE_WRITE_FIELDS = [
  "question_text",
  "type",
  "mandatory",
  "default_value",
  "help_text",
  "active",
  "reference",
];

/**
 * P-8: catalog client scripts, catalog UI policies and their actions that
 * reference the parent through `field` (`cat_item` / `catalog_item` on an
 * item, `variable_set` on a set). `via` hangs them off another child instead.
 */
function catalogLogic(
  scriptField: string,
  policyField: string,
  via?: { parentTable: string; parentKey: string },
): ArtifactChild[] {
  return [
    {
      table: "catalog_script_client",
      parentField: scriptField,
      nameField: "name",
      scriptFields: ["script"],
      // P-24 (U, O-5).
      writeFields: ["type", "ui_type", "active"],
      ...via,
    },
    {
      table: "catalog_ui_policy",
      parentField: policyField,
      orderField: "order",
      nameField: "short_description",
      scriptFields: ["script_true", "script_false"],
      writeFields: [
        "active",
        "catalog_conditions",
        "on_load",
        "reverse_if_false",
      ],
      ...via,
    },
  ];
}

const CATALOG_POLICY_ACTIONS: ArtifactChild = {
  table: "catalog_ui_policy_action",
  parentField: "ui_policy",
  parentTable: "catalog_ui_policy",
  nameField: "catalog_variable",
  // P-24 (U, O-5).
  writeFields: ["visible", "mandatory", "disabled"],
};

/**
 * P-8 (CAT-1 … CAT-6): what a catalog item or record producer form is made
 * of — its own variables, the variable sets it includes (and theirs), the
 * choices of every variable, catalog client scripts and UI policies of the
 * item and of its sets, then categories and user criteria. Children of the
 * same table accumulate, so `question_choice` / `catalog_ui_policy_action`
 * cover both the item's rows and its sets' rows.
 */
const CATALOG_ITEM_CHILDREN: ArtifactChild[] = [
  {
    table: "item_option_new",
    parentField: "cat_item",
    orderField: "order",
    nameField: "name",
    writeFields: VARIABLE_WRITE_FIELDS,
  },
  {
    table: "io_set_item",
    parentField: "sc_cat_item",
    orderField: "order",
    refFields: [
      {
        field: "variable_set",
        table: "item_option_new_set",
        type: "variable_set",
      },
    ],
  },
  {
    table: "item_option_new_set",
    parentField: "sys_id",
    parentTable: "io_set_item",
    parentKey: "variable_set",
    nameField: "title",
  },
  {
    table: "item_option_new",
    parentField: "variable_set",
    parentTable: "io_set_item",
    parentKey: "variable_set",
    orderField: "order",
    nameField: "name",
  },
  ...VARIABLE_CHOICES,
  ...catalogLogic("cat_item", "catalog_item"),
  ...catalogLogic("variable_set", "variable_set", {
    parentTable: "io_set_item",
    parentKey: "variable_set",
  }),
  CATALOG_POLICY_ACTIONS,
  {
    table: "sc_cat_item_category",
    parentField: "sc_cat_item",
    nameField: "sc_category",
    verified: false,
  },
  {
    table: "sc_cat_item_user_criteria_mtom",
    parentField: "sc_cat_item",
    nameField: "user_criteria",
    verified: false,
  },
];

/** P-8 (QA-3): the four scan-check tables, `[type, table, sdkApi, meta]`. */
const SCAN_CHECKS: [string, string, SdkApi, string[]][] = [
  ["linter_check", "scan_linter_check", "LinterCheck", []],
  ["script_only_check", "scan_script_only_check", "ScriptOnlyCheck", []],
  [
    "column_type_check",
    "scan_column_type_check",
    "ColumnTypeCheck",
    ["column_type"],
  ],
  ["table_check", "scan_table_check", "TableCheck", ["table", "conditions"]],
];

/**
 * N-8 (gate O-9): the licensed plugin behind the `pa_*` tables. On an instance
 * without it, PA reads answer `available:false` and name it as `requires`.
 */
export const PERFORMANCE_ANALYTICS = "Performance Analytics (com.snc.pa)";

/** P-8 (AI-1, AI-2): the licensed store app behind the `sn_aia_*` tables. */
const AI_AGENTS_APP = "Now Assist AI Agents (sn_aia)";

export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  // -- The nine script types behind list_scripts / search_code / … ----------
  // Order matters: SCRIPT_TYPES keeps it, and so do tool enums and reports.
  {
    ...BASE,
    type: "business_rule",
    group: "server",
    sdkApi: "BusinessRule",
    sdkSince: "<=3.0",
    table: "sys_script",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    appliesToField: "collection",
    // `global` marks the rules that run on every table (S-1: the table-flow
    // diagram lists them alongside the inherited ones).
    metaFields: [
      "collection",
      "global",
      "when",
      "order",
      "active",
      "condition",
    ],
  },
  {
    ...BASE,
    type: "script_include",
    group: "server",
    sdkApi: "ScriptInclude",
    sdkSince: "4.0",
    table: "sys_script_include",
    nameField: "name",
    keyFields: ["api_name"],
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    metaFields: ["api_name", "client_callable", "access", "active"],
  },
  {
    ...BASE,
    type: "client_script",
    group: "classic-ui",
    sdkApi: "ClientScript",
    sdkSince: "<=3.0",
    table: "sys_script_client",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    clientFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    appliesToField: "table",
    metaFields: ["table", "type", "ui_type", "field", "active"],
    whenFields: ["type", "field", "ui_type", "condition"],
  },
  {
    ...BASE,
    type: "ui_policy",
    group: "classic-ui",
    sdkApi: "UiPolicy",
    sdkSince: "4.2",
    table: "sys_ui_policy",
    // servicenow_get_artifact reads the actions (P-5); their names stay
    // unverified until O-5 confirms them on a live instance.
    children: [
      {
        table: "sys_ui_policy_action",
        parentField: "ui_policy",
        nameField: "field",
        // P-23: the action flags upsert_artifact may write (unverified, O-5).
        writeFields: [
          "table",
          "visible",
          "mandatory",
          "disabled",
          "cleared",
          "value",
          "value_action",
          "field_message",
          "field_message_type",
        ],
        verified: false,
      },
    ],
    nameField: "short_description",
    activeField: "active",
    scriptFields: ["script_true", "script_false"],
    clientFields: ["script_true", "script_false"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    appliesToField: "table",
    metaFields: ["table", "active", "run_scripts"],
    writeFields: [
      "conditions",
      "description",
      "global",
      "inherit",
      "on_load",
      "order",
      "reverse_if_false",
      "ui_type",
      "view",
      "isolate_script",
    ],
  },
  {
    ...BASE,
    type: "ui_action",
    group: "classic-ui",
    sdkApi: "UiAction",
    sdkSince: "4.0",
    table: "sys_ui_action",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    appliesToField: "table",
    metaFields: ["table", "action_name", "active", "client", "order"],
  },
  {
    ...BASE,
    type: "scheduled_job",
    group: "server",
    sdkApi: "ScheduledScript",
    sdkSince: "4.5",
    table: "sysauto_script",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    metaFields: ["active", "run_type", "run_time"],
  },
  {
    ...BASE,
    type: "transform",
    group: "server",
    sdkApi: "ImportSet",
    sdkSince: "4.2",
    table: "sys_transform_script",
    nameField: "map",
    activeField: "active",
    scriptFields: ["script"],
    refFields: [
      { field: "map", table: "sys_transform_map", type: "transform_map" },
    ],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    metaFields: ["map", "when", "order"],
  },
  {
    ...BASE,
    type: "rest_operation",
    group: "server",
    sdkApi: "RestApi",
    sdkSince: "<=3.0",
    table: "sys_ws_operation",
    nameField: "name",
    activeField: "active",
    scriptFields: ["operation_script"],
    refFields: [
      {
        field: "web_service_definition",
        table: "sys_ws_definition",
        type: "rest_api",
      },
    ],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    metaFields: [
      "web_service_definition",
      "http_method",
      "operation_uri",
      "active",
    ],
  },
  {
    ...BASE,
    type: "acl",
    group: "core",
    sdkApi: "Acl",
    sdkSince: "<=3.0",
    table: "sys_security_acl",
    children: [
      {
        table: "sys_security_acl_role",
        parentField: "sys_security_acl",
        refFields: [
          { field: "sys_user_role", table: "sys_user_role", type: "role" },
        ],
        verified: false,
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: true,
    scriptTools: true,
    metaFields: ["operation", "type", "active", "admin_overrides"],
  },

  // -- S-4: the widened script-tools view (all unverified until O-5) ---------
  // Appended after the nine so their order, enums and reports are unchanged.
  {
    ...BASE,
    type: "script_action",
    group: "server",
    sdkApi: "ScriptAction",
    sdkSince: "4.0",
    table: "sysevent_script_action",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["event_name", "order", "active"],
  },
  {
    ...BASE,
    type: "transform_map",
    group: "server",
    sdkApi: "ImportSet",
    sdkSince: "4.2",
    table: "sys_transform_map",
    children: [
      {
        table: "sys_transform_entry",
        parentField: "map",
        nameField: "target_field",
        scriptFields: ["source_script"],
      },
      {
        table: "sys_transform_script",
        parentField: "map",
        orderField: "order",
        scriptFields: ["script"],
      },
    ],
    nameField: "name",
    activeField: "active",
    // The map-level script runs only when `run_script` is set.
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    appliesToField: "target_table",
    metaFields: ["source_table", "target_table", "run_script", "active"],
  },
  {
    ...BASE,
    type: "transform_entry",
    group: "server",
    sdkApi: "ImportSet",
    sdkSince: "4.2",
    table: "sys_transform_entry",
    nameField: "target_field",
    scriptFields: ["source_script"],
    refFields: [
      { field: "map", table: "sys_transform_map", type: "transform_map" },
    ],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: [
      "map",
      "source_field",
      "target_table",
      "target_field",
      "use_source_script",
    ],
  },
  {
    ...BASE,
    type: "fix_script",
    group: "server",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_script_fix",
    nameField: "name",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["description"],
  },
  {
    ...BASE,
    type: "email_script",
    group: "server",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_script_email",
    nameField: "name",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: [],
  },
  {
    ...BASE,
    type: "processor",
    group: "server",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_processor",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["path", "type", "active"],
  },
  {
    ...BASE,
    type: "data_source",
    group: "server",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_data_source",
    nameField: "name",
    // `data_loader` backs "Custom (Load by Script)", `parsing_script` the
    // "Custom (Parse by Script)" file format.
    scriptFields: ["data_loader", "parsing_script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["type", "format", "import_set_table_name"],
  },
  {
    ...BASE,
    type: "rest_message_fn",
    group: "server",
    sdkApi: "RestMessage",
    sdkSince: null,
    table: "sys_rest_message_fn",
    nameField: "function_name",
    // Not JavaScript: the endpoint and body templates carry `${variable}`
    // substitutions, so they are searched but never linted.
    scriptFields: ["rest_endpoint", "content"],
    markupFields: ["rest_endpoint", "content"],
    refFields: [{ field: "rest_message", table: "sys_rest_message" }],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["rest_message", "http_method", "rest_endpoint"],
  },
  // Classic UI
  {
    ...BASE,
    type: "ui_script",
    group: "classic-ui",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_ui_script",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    clientFields: ["script"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["global", "ui_type", "active"],
  },
  {
    ...BASE,
    type: "ui_page",
    group: "classic-ui",
    sdkApi: "UiPage",
    sdkSince: "4.0",
    table: "sys_ui_page",
    nameField: "name",
    keyFields: ["name"],
    // `html` is Jelly and routinely embeds <g:evaluate> server script.
    scriptFields: ["html", "client_script", "processing_script"],
    clientFields: ["client_script"],
    markupFields: ["html"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["category", "description"],
  },
  {
    ...BASE,
    type: "ui_macro",
    group: "classic-ui",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_ui_macro",
    nameField: "name",
    activeField: "active",
    // Jelly XML: searched for embedded script and references, not linted.
    scriptFields: ["xml"],
    markupFields: ["xml"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["description", "active"],
  },
  {
    ...BASE,
    type: "validation_script",
    group: "classic-ui",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_script_validator",
    // The table has no name field; the description is what lists show.
    nameField: "description",
    activeField: "active",
    scriptFields: ["validator"],
    clientFields: ["validator"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["internal_type", "ui_type", "active"],
  },
  // Service Portal
  {
    ...BASE,
    type: "sp_widget",
    group: "portal",
    sdkApi: "SPWidget",
    sdkSince: "4.0",
    table: "sp_widget",
    children: [
      {
        table: "sp_ng_template",
        parentField: "sp_widget",
        nameField: "id",
        // P-24: the Angular template body; ids are unique instance-wide.
        writeFields: ["template"],
        unique: [{ fields: ["id"] }],
      },
      {
        table: "m2m_sp_widget_dependency",
        parentField: "sp_widget",
        // P-24 (U): the dependency the widget loads.
        writeFields: ["sp_dependency"],
      },
      {
        table: "m2m_sp_ng_pro_sp_widget",
        parentField: "sp_widget",
        refFields: [
          {
            field: "sp_angular_provider",
            table: "sp_angular_provider",
            type: "sp_angular_provider",
          },
        ],
      },
    ],
    nameField: "name",
    keyFields: ["id"],
    // `script` is the server script; the client controller and the link
    // function run in the browser; `css` is SCSS.
    scriptFields: ["script", "client_script", "link", "css"],
    clientFields: ["client_script", "link"],
    markupFields: ["css"],
    jsonFields: [
      { field: "option_schema", decoder: "json", writable: true },
      { field: "demo_data", decoder: "json", writable: true },
    ],
    tiers: SCRIPT_TOOL_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["id", "data_table"],
    // P-24 (U, O-5): SP-2 fields upsert_artifact may write, SDK pre-flight.
    writeFields: [
      "template",
      "controller_as",
      "description",
      "public",
      "roles",
      "has_preview",
    ],
    unique: [{ fields: ["id"] }],
    scopePrefixFields: ["id"],
  },
  // Service Catalog
  {
    ...BASE,
    type: "catalog_client_script",
    group: "catalog",
    sdkApi: "CatalogClientScript",
    sdkSince: null,
    table: "catalog_script_client",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    clientFields: ["script"],
    refFields: [
      { field: "cat_item", table: "sc_cat_item", type: "catalog_item" },
      {
        field: "variable_set",
        table: "item_option_new_set",
        type: "variable_set",
      },
    ],
    // P-8: also explained (X).
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    metaFields: ["cat_item", "variable_set", "type", "ui_type", "active"],
    whenFields: ["type", "cat_variable", "ui_type"],
  },
  // Data model
  {
    ...BASE,
    type: "dictionary_script",
    group: "core",
    sdkApi: "Table",
    sdkSince: null,
    table: "sys_dictionary",
    // Only calculated columns (`virtual` is the "Calculated" flag) and
    // scripted defaults; plain dictionary entries are not script artefacts.
    baseQuery: "virtual=true^ORdefault_valueSTARTSWITHjavascript:",
    nameField: "element",
    keyFields: ["name", "element"],
    activeField: "active",
    scriptFields: ["calculation", "default_value"],
    tiers: EXPLAINED_SCRIPT_TIERS,
    verified: false,
    scriptTools: true,
    appliesToField: "name",
    metaFields: ["name", "internal_type", "virtual", "active"],
  },

  // -- Seeds (not exposed through any tool yet; all unverified until O-5) ----
  // Server-side logic
  {
    ...BASE,
    type: "rest_api",
    group: "server",
    sdkApi: "RestApi",
    sdkSince: "<=3.0",
    table: "sys_ws_definition",
    children: [
      {
        table: "sys_ws_operation",
        parentField: "web_service_definition",
        nameField: "name",
        scriptFields: ["operation_script"],
      },
      { table: "sys_ws_version", parentField: "web_service_definition" },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
  },
  // -- P-7: core, server-logic and classic-UI rows (SDK-PARITY §4.1 – §4.3) --
  // All unverified until O-5: names come from the SDK inventory.
  // Core platform / data model
  {
    ...BASE,
    type: "table",
    group: "core",
    sdkApi: "Table",
    sdkSince: "<=3.0",
    table: "sys_db_object",
    // Columns, overrides, labels and choices hang off the table name.
    children: [
      {
        table: "sys_dictionary",
        parentField: "name",
        parentKey: "name",
        orderField: "element",
        nameField: "element",
      },
      {
        table: "sys_dictionary_override",
        parentField: "name",
        parentKey: "name",
        nameField: "element",
      },
      {
        table: "sys_documentation",
        parentField: "name",
        parentKey: "name",
        orderField: "element",
        nameField: "element",
      },
      {
        table: "sys_choice",
        parentField: "name",
        parentKey: "name",
        orderField: "element",
        nameField: "label",
      },
    ],
    nameField: "name",
    keyFields: ["name"],
    scriptFields: [],
    refFields: [
      { field: "super_class", table: "sys_db_object", type: "table" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["label", "super_class", "is_extendable"],
  },
  {
    ...BASE,
    type: "choice_set",
    group: "core",
    sdkApi: "ChoiceSet",
    sdkSince: null,
    table: "sys_choice_set",
    children: [
      {
        table: "sys_choice",
        parentField: "name",
        parentKey: "name",
        alsoMatch: [{ field: "element", parentKey: "element" }],
        orderField: "sequence",
        nameField: "label",
      },
    ],
    nameField: "element",
    keyFields: ["name", "element"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
  },
  {
    ...BASE,
    type: "state_model",
    group: "core",
    sdkApi: "StateModel",
    sdkSince: "4.10",
    table: "sttrm_model",
    children: [
      { table: "sttrm_state", parentField: "model", nameField: "label" },
      {
        table: "sttrm_state_transition",
        parentField: "model",
        nameField: "name",
        refFields: [
          { field: "from_state", table: "sttrm_state" },
          { field: "to_state", table: "sttrm_state" },
        ],
      },
      {
        table: "sttrm_transition_condition",
        parentField: "transition",
        parentTable: "sttrm_state_transition",
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "state_field"],
  },
  {
    ...BASE,
    type: "property",
    group: "core",
    sdkApi: "Property",
    sdkSince: null,
    table: "sys_properties",
    nameField: "name",
    keyFields: ["name"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["type", "value", "is_private", "read_roles", "write_roles"],
  },
  {
    ...BASE,
    type: "user_preference",
    group: "core",
    sdkApi: "UserPreference",
    sdkSince: null,
    table: "sys_user_preference",
    nameField: "name",
    keyFields: ["name", "user"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["user", "value", "system"],
  },
  {
    ...BASE,
    type: "role",
    group: "core",
    sdkApi: "Role",
    sdkSince: null,
    table: "sys_user_role",
    children: [
      {
        table: "sys_user_role_contains",
        parentField: "role",
        refFields: [
          { field: "contains", table: "sys_user_role", type: "role" },
        ],
      },
    ],
    nameField: "name",
    keyFields: ["name"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["elevated_privilege", "assignable_by", "description"],
  },
  {
    ...BASE,
    type: "cross_scope_privilege",
    group: "core",
    sdkApi: "CrossScopePrivilege",
    sdkSince: null,
    table: "sys_scope_privilege",
    nameField: "target_name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: [
      "source_scope",
      "target_scope",
      "target_type",
      "operation",
      "status",
    ],
  },
  {
    ...BASE,
    type: "user_criteria",
    group: "core",
    sdkApi: "UserCriteria",
    sdkSince: null,
    table: "user_criteria",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["advanced", "match_all", "active"],
  },
  {
    ...BASE,
    type: "field_style",
    group: "core",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ui_style",
    nameField: "element",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
    metaFields: ["name", "element", "value", "style"],
  },
  {
    ...BASE,
    type: "schedule",
    group: "core",
    sdkApi: "Record",
    sdkSince: null,
    table: "cmn_schedule",
    children: [
      {
        table: "cmn_schedule_span",
        parentField: "schedule",
        nameField: "name",
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["type", "time_zone"],
  },
  {
    ...BASE,
    type: "event",
    group: "core",
    sdkApi: "Record",
    sdkSince: null,
    table: "sysevent_register",
    nameField: "event_name",
    keyFields: ["event_name"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "fired_by", "queue", "description"],
  },
  {
    ...BASE,
    type: "relationship",
    group: "core",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_relationship",
    nameField: "name",
    scriptFields: ["query_with"],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["basic_apply_to", "basic_query_from"],
  },
  {
    ...BASE,
    type: "ldap_server",
    group: "core",
    sdkApi: "Record",
    sdkSince: null,
    table: "ldap_server_config",
    children: [
      { table: "ldap_server_url", parentField: "server", orderField: "order" },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    secretFields: ["password"],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["active", "dn", "ssl"],
  },
  // Server-side logic
  {
    ...BASE,
    type: "js_module",
    group: "server",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_module",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
  },
  {
    ...BASE,
    type: "rest_message",
    group: "server",
    sdkApi: "RestMessage",
    sdkSince: "4.8",
    table: "sys_rest_message",
    children: [
      {
        table: "sys_rest_message_fn",
        parentField: "rest_message",
        nameField: "function_name",
      },
      {
        table: "sys_rest_message_headers",
        parentField: "rest_message",
        nameField: "name",
      },
      {
        table: "sys_rest_message_fn_parameters",
        parentField: "rest_message_function",
        parentTable: "sys_rest_message_fn",
        nameField: "name",
      },
      {
        table: "sys_rest_message_fn_headers",
        parentField: "rest_message_function",
        parentTable: "sys_rest_message_fn",
        nameField: "name",
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["rest_endpoint", "authentication_type", "use_mid_server"],
  },
  {
    ...BASE,
    type: "graphql_api",
    group: "server",
    sdkApi: "GraphQLApi",
    sdkSince: "4.11",
    table: "sys_graphql_schema",
    children: [
      {
        table: "sys_graphql_resolver",
        parentField: "schema",
        nameField: "name",
        scriptFields: ["script"],
      },
      {
        table: "sys_graphql_resolver_mapping",
        parentField: "schema",
        nameField: "path",
        refFields: [{ field: "resolver", table: "sys_graphql_resolver" }],
      },
      {
        table: "sys_graphql_typeresolver",
        parentField: "schema",
        nameField: "name",
        scriptFields: ["script"],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["schema_namespace", "requires_authentication", "active"],
  },
  {
    ...BASE,
    type: "alias",
    group: "server",
    sdkApi: "Alias",
    sdkSince: "4.8",
    table: "sys_alias",
    nameField: "name",
    scriptFields: [],
    refFields: [
      {
        field: "configuration_template",
        table: "sys_alias_templates",
        type: "alias_template",
      },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["id", "type", "connection_type"],
  },
  {
    ...BASE,
    type: "alias_template",
    group: "server",
    sdkApi: "AliasTemplate",
    sdkSince: null,
    table: "sys_alias_templates",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
  },
  {
    ...BASE,
    type: "retry_policy",
    group: "server",
    sdkApi: "RetryPolicy",
    sdkSince: "4.8",
    table: "sys_retry_policy",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
  },
  {
    ...BASE,
    type: "data_lookup",
    group: "server",
    sdkApi: "DataLookup",
    sdkSince: "4.8",
    table: "dl_definition",
    // The matcher table itself (a dl_matcher extension) is named by
    // `matcher_table`, not linked as a child.
    children: [
      {
        table: "dl_definition_rel_match",
        parentField: "definition",
        nameField: "source_field",
      },
      {
        table: "dl_definition_rel_set",
        parentField: "definition",
        nameField: "target_field",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "matcher_table", "active"],
  },
  {
    ...BASE,
    type: "email_notification",
    group: "server",
    sdkApi: "EmailNotification",
    sdkSince: null,
    table: "sysevent_email_action",
    nameField: "name",
    activeField: "active",
    scriptFields: ["advanced_condition"],
    refFields: [{ field: "template", table: "sysevent_email_template" }],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "collection",
    metaFields: ["collection", "generation_type", "event_name", "active"],
    whenFields: [
      "generation_type",
      "event_name",
      "action_insert",
      "action_update",
      "condition",
      "weight",
    ],
  },
  {
    ...BASE,
    type: "inbound_email_action",
    group: "server",
    sdkApi: "InboundEmailAction",
    sdkSince: null,
    table: "sysevent_in_email_action",
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "type", "action", "order", "active"],
    whenFields: ["type", "order", "condition", "stop_processing"],
  },
  {
    ...BASE,
    type: "sla",
    group: "server",
    sdkApi: "Sla",
    sdkSince: "4.3",
    table: "contract_sla",
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    refFields: [
      { field: "schedule", table: "cmn_schedule", type: "schedule" },
      { field: "workflow", table: "wf_workflow", type: "workflow" },
      { field: "flow", table: "sys_hub_flow", type: "flow" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "collection",
    metaFields: ["collection", "type", "duration", "active"],
    whenFields: [
      "start_condition",
      "pause_condition",
      "stop_condition",
      "reset_condition",
      "cancel_condition",
      "duration",
    ],
  },
  // Classic UI
  {
    ...BASE,
    type: "data_policy",
    group: "classic-ui",
    sdkApi: "DataPolicy",
    sdkSince: "4.7",
    table: "sys_data_policy2",
    children: [
      {
        table: "sys_data_policy_rule",
        parentField: "sys_data_policy",
        nameField: "field",
        writeFields: ["table", "mandatory", "disabled"],
      },
    ],
    nameField: "short_description",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "model_table",
    metaFields: [
      "model_table",
      "apply_import_set",
      "apply_soap",
      "use_as_ui_policy",
      "active",
    ],
    whenFields: ["conditions", "reverse_if_false", "inherit"],
    writeFields: ["description"],
  },
  {
    ...BASE,
    type: "workspace_form_action",
    group: "classic-ui",
    sdkApi: "UiAction",
    sdkSince: "4.0",
    table: "sys_ux_form_action",
    nameField: "label",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "action_name", "order", "active"],
  },
  {
    ...BASE,
    type: "form",
    group: "classic-ui",
    sdkApi: "Form",
    sdkSince: "4.6",
    table: "sys_ui_form",
    // Form → form sections (ordered) → the elements of each section, linked
    // by the section's sys_id held in `sys_ui_form_section.sys_ui_section`.
    children: [
      {
        table: "sys_ui_form_section",
        parentField: "sys_ui_form",
        orderField: "position",
        refFields: [
          {
            field: "sys_ui_section",
            table: "sys_ui_section",
            type: "ui_section",
          },
        ],
      },
      {
        table: "sys_ui_element",
        parentField: "sys_ui_section",
        parentTable: "sys_ui_form_section",
        parentKey: "sys_ui_section",
        orderField: "position",
        nameField: "element",
      },
    ],
    nameField: "name",
    keyFields: ["name", "view"],
    scriptFields: [],
    refFields: [{ field: "view", table: "sys_ui_view", type: "ui_view" }],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
    metaFields: ["name", "view"],
  },
  {
    ...BASE,
    type: "ui_section",
    group: "classic-ui",
    sdkApi: "Form",
    sdkSince: "4.6",
    table: "sys_ui_section",
    children: [
      {
        table: "sys_ui_element",
        parentField: "sys_ui_section",
        orderField: "position",
        nameField: "element",
      },
    ],
    nameField: "name",
    scriptFields: [],
    refFields: [{ field: "view", table: "sys_ui_view", type: "ui_view" }],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
    metaFields: ["name", "view", "caption"],
  },
  {
    ...BASE,
    type: "list",
    group: "classic-ui",
    sdkApi: "List",
    sdkSince: null,
    table: "sys_ui_list",
    children: [
      {
        table: "sys_ui_list_element",
        parentField: "list_id",
        orderField: "position",
        nameField: "element",
      },
    ],
    nameField: "name",
    scriptFields: [],
    refFields: [{ field: "view", table: "sys_ui_view", type: "ui_view" }],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
    metaFields: ["name", "view", "parent", "relationship"],
  },
  {
    ...BASE,
    type: "application_menu",
    group: "classic-ui",
    sdkApi: "ApplicationMenu",
    sdkSince: null,
    table: "sys_app_application",
    children: [
      {
        table: "sys_app_module",
        parentField: "application",
        orderField: "order",
        nameField: "title",
      },
    ],
    nameField: "title",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["category", "order", "roles", "active"],
  },
  {
    ...BASE,
    type: "ui_view",
    group: "classic-ui",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ui_view",
    children: [
      {
        table: "sysrule_view",
        parentField: "view",
        nameField: "name",
        scriptFields: ["script"],
      },
    ],
    nameField: "name",
    keyFields: ["name"],
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["title"],
  },
  {
    ...BASE,
    type: "list_control",
    group: "classic-ui",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ui_list_control",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "name",
    metaFields: ["name", "related_list", "omit_new_button", "omit_edit_button"],
  },
  // Next Experience (SDK APIs; P-9, SDK-PARITY §4.4)
  {
    ...BASE,
    type: "workspace",
    group: "next-experience",
    sdkApi: "Workspace",
    sdkSince: "4.3",
    table: "sys_ux_page_registry",
    children: [
      {
        table: "sys_ux_page_property",
        parentField: "page",
        nameField: "name",
        jsonFields: [{ field: "value", decoder: "json", writable: false }],
      },
    ],
    nameField: "title",
    keyFields: ["path"],
    refFields: [
      {
        field: "root_macroponent",
        table: "sys_ux_macroponent",
        type: "uib_macroponent",
      },
      {
        field: "admin_panel",
        table: "sys_ux_app_config",
        type: "uib_app_config",
      },
    ],
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "dashboard",
    group: "next-experience",
    sdkApi: "Dashboard",
    sdkSince: null,
    table: "par_dashboard",
    children: [
      {
        table: "par_dashboard_tab",
        parentField: "dashboard",
        orderField: "order",
        nameField: "name",
      },
      {
        table: "par_dashboard_widget",
        parentField: "tab",
        parentTable: "par_dashboard_tab",
      },
      { table: "par_dashboard_permission", parentField: "dashboard" },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "ux_list_menu_config",
    group: "next-experience",
    sdkApi: "UxListMenuConfig",
    sdkSince: null,
    table: "sys_ux_list_menu_config",
    children: [
      {
        table: "sys_ux_list_category",
        parentField: "configuration",
        orderField: "order",
        nameField: "title",
      },
      {
        table: "sys_ux_list",
        parentField: "category",
        parentTable: "sys_ux_list_category",
        orderField: "order",
        nameField: "title",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "ux_applicability",
    group: "next-experience",
    sdkApi: "Applicability",
    sdkSince: null,
    table: "sys_ux_applicability",
    children: [
      { table: "sys_ux_applicability_m2m_list", parentField: "applicability" },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  // UI Builder internals (no Fluent API: `Record()`; SDK-PARITY §4.5)
  {
    ...BASE,
    type: "uib_app_config",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_app_config",
    children: [
      {
        table: "sys_ux_app_route",
        parentField: "app_config",
        nameField: "name",
        jsonFields: [{ field: "parameters", decoder: "json", writable: false }],
        refFields: [
          {
            field: "parent_macroponent",
            table: "sys_ux_macroponent",
            type: "uib_macroponent",
          },
        ],
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_route",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_app_route",
    nameField: "name",
    scriptFields: [],
    jsonFields: [
      { field: "parameters", decoder: "json", writable: false },
      { field: "optional_parameters", decoder: "json", writable: false },
    ],
    refFields: [
      {
        field: "app_config",
        table: "sys_ux_app_config",
        type: "uib_app_config",
      },
      {
        field: "screen_type",
        table: "sys_ux_screen_type",
        type: "uib_screen_type",
      },
      {
        field: "parent_macroponent",
        table: "sys_ux_macroponent",
        type: "uib_macroponent",
      },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_screen_type",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_screen_type",
    // Page variants: one screen per audience / condition, ordered.
    children: [
      {
        table: "sys_ux_screen",
        parentField: "screen_type",
        orderField: "order",
        nameField: "name",
        jsonFields: [
          { field: "macroponent_config", decoder: "json", writable: false },
          { field: "event_mappings", decoder: "json", writable: false },
        ],
        refFields: [
          {
            field: "macroponent",
            table: "sys_ux_macroponent",
            type: "uib_macroponent",
          },
        ],
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_screen",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_screen",
    children: [{ table: "sys_ux_screen_condition", parentField: "screen" }],
    nameField: "name",
    scriptFields: [],
    jsonFields: [
      { field: "macroponent_config", decoder: "json", writable: false },
      { field: "event_mappings", decoder: "json", writable: false },
    ],
    refFields: [
      {
        field: "screen_type",
        table: "sys_ux_screen_type",
        type: "uib_screen_type",
      },
      {
        field: "macroponent",
        table: "sys_ux_macroponent",
        type: "uib_macroponent",
      },
      {
        field: "app_config",
        table: "sys_ux_app_config",
        type: "uib_app_config",
      },
      { field: "applicability", table: "sys_ux_applicability" },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_macroponent",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_macroponent",
    children: [
      {
        table: "sys_ux_client_script",
        parentField: "macroponent",
        nameField: "name",
        scriptFields: ["script"],
      },
    ],
    nameField: "name",
    scriptFields: [],
    // UIB layout JSON is plan-only until a round-trip test exists (§5(c)).
    jsonFields: [
      { field: "composition", decoder: "uib-composition", writable: false },
      { field: "data", decoder: "json", writable: false },
      { field: "props", decoder: "json", writable: false },
      { field: "internal_event_mappings", decoder: "json", writable: false },
      { field: "state_properties", decoder: "json", writable: false },
      { field: "dispatched_events", decoder: "json", writable: false },
      { field: "handled_events", decoder: "json", writable: false },
      { field: "required_translations", decoder: "json", writable: false },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  // UI Builder client scripts and data brokers carry code: opt-in script
  // tools (see `scriptToolsOptIn`).
  {
    ...BASE,
    type: "uib_client_script",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_client_script",
    nameField: "name",
    scriptFields: ["script"],
    clientFields: ["script"],
    refFields: [
      {
        field: "macroponent",
        table: "sys_ux_macroponent",
        type: "uib_macroponent",
      },
    ],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["macroponent", "type"],
  },
  {
    ...BASE,
    type: "uib_client_script_include",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_client_script_include",
    nameField: "name",
    scriptFields: ["script"],
    clientFields: ["script"],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: [],
  },
  {
    ...BASE,
    type: "uib_data_broker_transform",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_data_broker_transform",
    nameField: "name",
    // Server-side transform; `properties` is the broker's input schema.
    scriptFields: ["script"],
    jsonFields: [{ field: "properties", decoder: "json", writable: false }],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["mutates_server_data"],
  },
  {
    ...BASE,
    type: "uib_data_broker_scriptlet",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_data_broker_scriptlet",
    nameField: "name",
    // Client-side scriptlet: runs in the browser.
    scriptFields: ["script"],
    clientFields: ["script"],
    jsonFields: [{ field: "properties", decoder: "json", writable: false }],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: [],
  },
  {
    ...BASE,
    type: "uib_event",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_event",
    nameField: "label",
    keyFields: ["name"],
    scriptFields: [],
    jsonFields: [{ field: "props", decoder: "json", writable: false }],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_component",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_lib_component",
    nameField: "name",
    keyFields: ["tag"],
    scriptFields: [],
    jsonFields: [{ field: "properties", decoder: "json", writable: false }],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_theme",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_theme",
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_style",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_style",
    nameField: "name",
    scriptFields: [],
    jsonFields: [{ field: "style", decoder: "json", writable: false }],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_form_action",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_form_action",
    nameField: "label",
    scriptFields: [],
    refFields: [
      { field: "action", table: "sys_ui_action" },
      { field: "applicability", table: "sys_ux_applicability" },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_form_action_layout",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_form_action_layout",
    children: [
      {
        table: "sys_ux_form_action_layout_item",
        parentField: "form_action_layout",
        orderField: "order",
        refFields: [
          {
            field: "form_action",
            table: "sys_ux_form_action",
            type: "uib_form_action",
          },
        ],
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "uib_composite_definition",
    group: "uib",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_ux_composite_definition",
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  // Service Portal (SDK-PARITY §4.6; `sp_widget` itself is in the S-4 view)
  {
    ...BASE,
    type: "sp_portal",
    group: "portal",
    sdkApi: "ServicePortal",
    sdkSince: null,
    table: "sp_portal",
    nameField: "title",
    keyFields: ["url_suffix"],
    refFields: [
      { field: "homepage", table: "sp_page", type: "sp_page" },
      { field: "login_page", table: "sp_page", type: "sp_page" },
      { field: "notfound_page", table: "sp_page", type: "sp_page" },
      { field: "theme", table: "sp_theme", type: "sp_theme" },
      {
        field: "sp_rectangle_menu",
        table: "sp_instance_menu",
        type: "sp_menu",
      },
    ],
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5).
    writeFields: ["quick_start_config", "default", "logo", "icon"],
    unique: [{ fields: ["url_suffix"] }],
  },
  {
    ...BASE,
    type: "sp_page",
    group: "portal",
    sdkApi: "SPPage",
    sdkSince: "4.5",
    table: "sp_page",
    // Layout: page → containers → rows → columns → widget instances.
    // P-24: upsert_artifact writes the whole tree as one plan; each nested
    // child names its parent child by position (`parent`). The layout field
    // names beyond the links, `order` and `widget_parameters` are (U), O-5.
    children: [
      {
        table: "sp_container",
        parentField: "sp_page",
        orderField: "order",
        writeFields: [
          "name",
          "width",
          "background_color",
          "background_image",
          "class_name",
        ],
      },
      {
        table: "sp_row",
        parentField: "sp_container",
        parentTable: "sp_container",
        orderField: "order",
        writeFields: ["class_name"],
      },
      {
        table: "sp_column",
        parentField: "sp_row",
        parentTable: "sp_row",
        orderField: "order",
        writeFields: ["size", "class_name"],
      },
      {
        table: "sp_instance",
        parentField: "sp_column",
        parentTable: "sp_column",
        orderField: "order",
        jsonFields: [
          { field: "widget_parameters", decoder: "json", writable: true },
        ],
        refFields: [
          { field: "sp_widget", table: "sp_widget", type: "sp_widget" },
        ],
        writeFields: [
          "title",
          "class_name",
          "css",
          "color",
          "size",
          "roles",
          "short_description",
          "active",
        ],
      },
    ],
    nameField: "title",
    keyFields: ["id"],
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    writeFields: ["public", "roles", "draft", "short_description", "internal"],
    unique: [{ fields: ["id"] }],
    scopePrefixFields: ["id"],
  },
  {
    ...BASE,
    type: "sp_ng_template",
    group: "portal",
    sdkApi: "SPWidget",
    sdkSince: "4.0",
    table: "sp_ng_template",
    nameField: "id",
    keyFields: ["id"],
    // Angular HTML template: searched, never linted.
    scriptFields: ["template"],
    markupFields: ["template"],
    refFields: [{ field: "sp_widget", table: "sp_widget", type: "sp_widget" }],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["sp_widget"],
    unique: [{ fields: ["id"] }],
    scopePrefixFields: ["id"],
  },
  {
    ...BASE,
    type: "sp_dependency",
    group: "portal",
    sdkApi: "SPWidgetDependency",
    sdkSince: null,
    table: "sp_dependency",
    children: [
      {
        table: "m2m_sp_dependency_js_include",
        parentField: "sp_dependency",
        orderField: "order",
        refFields: [
          {
            field: "sp_js_include",
            table: "sp_js_include",
            type: "sp_js_include",
          },
        ],
      },
      {
        table: "m2m_sp_dependency_css_include",
        parentField: "sp_dependency",
        orderField: "order",
        refFields: [
          {
            field: "sp_css_include",
            table: "sp_css_include",
            type: "sp_css_include",
          },
        ],
      },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5): SP-3 fields; `module` is the Angular module name.
    writeFields: ["module", "include_on_page_load"],
    unique: [{ fields: ["name"] }, { fields: ["module"] }],
  },
  {
    ...BASE,
    type: "sp_angular_provider",
    group: "portal",
    sdkApi: "SPAngularProvider",
    sdkSince: null,
    table: "sp_angular_provider",
    nameField: "name",
    keyFields: ["name"],
    // Directives, services and factories: all run in the browser.
    scriptFields: ["script"],
    clientFields: ["script"],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["type"],
    unique: [{ fields: ["name"] }],
  },
  {
    ...BASE,
    type: "sp_js_include",
    group: "portal",
    sdkApi: "JsInclude",
    sdkSince: null,
    table: "sp_js_include",
    nameField: "display_name",
    scriptFields: [],
    refFields: [
      { field: "sys_ui_script", table: "sys_ui_script", type: "ui_script" },
    ],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5).
    writeFields: ["source", "url"],
  },
  {
    ...BASE,
    type: "sp_css_include",
    group: "portal",
    sdkApi: "CssInclude",
    sdkSince: null,
    table: "sp_css_include",
    nameField: "name",
    scriptFields: [],
    refFields: [{ field: "sp_css", table: "sp_css", type: "sp_css" }],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5).
    writeFields: ["source", "url"],
  },
  {
    ...BASE,
    type: "sp_theme",
    group: "portal",
    sdkApi: "SPTheme",
    sdkSince: null,
    table: "sp_theme",
    children: [
      {
        table: "m2m_sp_theme_js_include",
        parentField: "sp_theme",
        orderField: "order",
        // P-24 (U, O-5).
        writeFields: ["sp_js_include"],
      },
      {
        table: "m2m_sp_theme_css_include",
        parentField: "sp_theme",
        orderField: "order",
        writeFields: ["sp_css_include"],
      },
    ],
    nameField: "name",
    // SCSS variables: searched, never linted.
    scriptFields: ["css_variables"],
    markupFields: ["css_variables"],
    refFields: [
      { field: "header", table: "sp_header_footer", type: "sp_header_footer" },
      { field: "footer", table: "sp_header_footer", type: "sp_header_footer" },
    ],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["header", "footer"],
  },
  {
    ...BASE,
    type: "sp_menu",
    group: "portal",
    sdkApi: "SPMenu",
    sdkSince: null,
    table: "sp_instance_menu",
    children: [
      {
        table: "sp_rectangle_menu_item",
        parentField: "sp_rectangle_menu",
        orderField: "order",
        nameField: "label",
        refFields: [{ field: "sp_page", table: "sp_page", type: "sp_page" }],
        // P-24 (U, O-5).
        writeFields: ["type", "url", "condition"],
      },
    ],
    nameField: "title",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "sp_header_footer",
    group: "portal",
    sdkApi: "SPHeaderFooter",
    sdkSince: null,
    // Extends sp_widget, so the `sp_widget` script view already searches its
    // code; no script fields here to avoid duplicate hits.
    table: "sp_header_footer",
    nameField: "name",
    keyFields: ["id"],
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5): the widget fields it inherits; ids are unique across
    // sp_widget and every table extending it.
    writeFields: [
      "template",
      "css",
      "script",
      "client_script",
      "link",
      "controller_as",
    ],
    unique: [{ fields: ["id"], table: "sp_widget" }],
    scopePrefixFields: ["id"],
  },
  {
    ...BASE,
    type: "sp_page_route_map",
    group: "portal",
    sdkApi: "SPPageRouteMap",
    sdkSince: null,
    table: "sp_page_route_map",
    nameField: "short_description",
    activeField: "active",
    scriptFields: [],
    refFields: [
      { field: "route_from_page", table: "sp_page", type: "sp_page" },
      { field: "route_to_page", table: "sp_page", type: "sp_page" },
    ],
    tiers: READ_TIER,
    verified: false,
    // P-24 (U, O-5).
    writeFields: ["portals", "roles", "order"],
  },
  // Portal tables the SDK does not model (SP-11).
  {
    ...BASE,
    type: "sp_css",
    group: "portal",
    sdkApi: "none",
    sdkSince: null,
    table: "sp_css",
    nameField: "name",
    scriptFields: ["css"],
    markupFields: ["css"],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: [],
  },
  {
    ...BASE,
    type: "sp_search_source",
    group: "portal",
    sdkApi: "none",
    sdkSince: null,
    table: "sp_search_source",
    nameField: "name",
    keyFields: ["id"],
    // Server scripts of a scripted search source.
    scriptFields: ["data_fetch_script", "facet_generation_script"],
    tiers: READ_TIER,
    verified: false,
    scriptToolsOptIn: true,
    metaFields: ["id", "is_scripted_source"],
  },
  // Flow Designer / Workflow Studio (SDK-PARITY §4.7). Trigger, action and
  // logic instances, flow I/O, variables and stages (FLW-4…8) are children of
  // the flow / subflow they belong to.
  {
    ...BASE,
    type: "flow",
    group: "flow",
    sdkApi: "Flow",
    sdkSince: "4.3",
    table: "sys_hub_flow",
    children: FLOW_CHILDREN,
    nameField: "name",
    keyFields: ["internal_name"],
    activeField: "active",
    scriptFields: [],
    jsonFields: [{ field: "label_cache", decoder: "json", writable: false }],
    refFields: [
      { field: "latest_snapshot", table: "sys_hub_flow_snapshot" },
      { field: "master_snapshot", table: "sys_hub_flow_snapshot" },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "subflow",
    group: "flow",
    sdkApi: "Subflow",
    sdkSince: null,
    table: "sys_hub_flow",
    // Subflows share sys_hub_flow with flows; `flow` lists both.
    baseQuery: "type=subflow",
    children: FLOW_CHILDREN,
    nameField: "name",
    keyFields: ["internal_name"],
    activeField: "active",
    scriptFields: [],
    jsonFields: [{ field: "label_cache", decoder: "json", writable: false }],
    refFields: [
      { field: "latest_snapshot", table: "sys_hub_flow_snapshot" },
      { field: "master_snapshot", table: "sys_hub_flow_snapshot" },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "flow_action",
    group: "flow",
    sdkApi: "Action",
    sdkSince: null,
    table: "sys_hub_action_type_definition",
    children: [
      {
        table: "sys_hub_action_input",
        parentField: "model",
        nameField: "name",
      },
      {
        table: "sys_hub_action_output",
        parentField: "model",
        nameField: "name",
      },
      {
        table: "sys_hub_step_instance",
        parentField: "action",
        orderField: "order",
        jsonFields: [
          { field: "values", decoder: "flow-values", writable: false },
        ],
      },
    ],
    nameField: "name",
    keyFields: ["internal_name"],
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "flow_trigger_definition",
    group: "flow",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_hub_trigger_definition",
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "flow_context",
    group: "flow",
    sdkApi: "none",
    sdkSince: null,
    // Runtime (FLW-9): read only, never snapshotted or written.
    table: "sys_flow_context",
    children: [
      {
        table: "sys_flow_log",
        parentField: "context",
        orderField: "sys_created_on",
      },
    ],
    nameField: "name",
    scriptFields: [],
    refFields: [{ field: "flow", table: "sys_hub_flow", type: "flow" }],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "playbook",
    group: "flow",
    sdkApi: "PlaybookDefinition",
    sdkSince: null,
    table: "sys_pd_process_definition",
    children: [
      {
        table: "sys_pd_lane",
        parentField: "process_definition",
        orderField: "order",
        nameField: "label",
      },
      {
        table: "sys_pd_activity",
        parentField: "lane",
        parentTable: "sys_pd_lane",
        orderField: "order",
        nameField: "label",
      },
      { table: "sys_pd_trigger_instance", parentField: "process_definition" },
      {
        table: "sys_pd_process_input",
        parentField: "model",
        nameField: "name",
      },
      {
        table: "sys_pd_process_output",
        parentField: "model",
        nameField: "name",
      },
    ],
    nameField: "label",
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "playbook_context",
    group: "flow",
    sdkApi: "none",
    sdkSince: null,
    // Runtime (FLW-11).
    table: "sys_pd_context",
    children: [{ table: "sys_pd_activity_context", parentField: "context" }],
    nameField: "name",
    scriptFields: [],
    refFields: [
      {
        field: "process_definition",
        table: "sys_pd_process_definition",
        type: "playbook",
      },
    ],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "decision_table",
    group: "flow",
    sdkApi: "Record",
    sdkSince: null,
    table: "sys_decision",
    children: [
      { table: "sys_decision_input", parentField: "model", nameField: "label" },
      {
        table: "sys_decision_question",
        parentField: "decision_table",
        orderField: "order",
      },
    ],
    nameField: "name",
    scriptFields: [],
    // P-11: explained by the `decision-table` enricher (explainers.ts).
    tiers: SEED_TIERS,
    verified: false,
  },
  // Legacy workflow (no SDK API; SDK-PARITY §4.8). Inbound references (WF-6)
  // are the `workflow` refFields of the referring types.
  {
    ...BASE,
    type: "workflow",
    group: "workflow",
    sdkApi: "none",
    sdkSince: null,
    table: "wf_workflow",
    children: [
      { table: "wf_workflow_version", parentField: "workflow" },
      {
        table: "wf_activity",
        parentField: "workflow",
        orderField: "order",
        nameField: "name",
      },
      {
        table: "wf_transition",
        parentField: "from",
        parentTable: "wf_activity",
      },
      {
        table: "wf_condition",
        parentField: "activity",
        parentTable: "wf_activity",
        orderField: "order",
        nameField: "name",
      },
      {
        table: "wf_stage",
        parentField: "workflow_version",
        parentTable: "wf_workflow_version",
        orderField: "order",
        nameField: "name",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "workflow_activity_definition",
    group: "workflow",
    sdkApi: "none",
    sdkSince: null,
    table: "wf_activity_definition",
    nameField: "name",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
  },
  {
    ...BASE,
    type: "workflow_context",
    group: "workflow",
    sdkApi: "none",
    sdkSince: null,
    // Runtime (WF-5).
    table: "wf_context",
    children: [
      { table: "wf_executing", parentField: "context" },
      {
        table: "wf_history",
        parentField: "context",
        orderField: "sys_created_on",
      },
      { table: "wf_log", parentField: "context", orderField: "sys_created_on" },
    ],
    nameField: "name",
    scriptFields: [],
    refFields: [{ field: "workflow", table: "wf_workflow", type: "workflow" }],
    tiers: READ_TIER,
    verified: false,
  },
  // -- P-8: catalog, quality, AI and application rows (SDK-PARITY §4.9 –
  // §4.12). Definition records, not the `sn_sc` consumer view; all unverified
  // until O-5. The AI rows live in licensed store apps (O-9, `licensed`).
  // Service Catalog
  {
    ...BASE,
    type: "catalog_item",
    group: "catalog",
    sdkApi: "CatalogItem",
    sdkSince: "4.3",
    table: "sc_cat_item",
    children: CATALOG_ITEM_CHILDREN,
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    refFields: [{ field: "workflow", table: "wf_workflow", type: "workflow" }],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["sys_class_name", "category", "sc_catalogs", "order"],
    // P-24 (CAT-1, U until O-5).
    writeFields: ["short_description", "description"],
  },
  {
    ...BASE,
    type: "record_producer",
    group: "catalog",
    sdkApi: "CatalogItemRecordProducer",
    sdkSince: null,
    // Extends sc_cat_item: the same variables, sets, scripts and policies.
    table: "sc_cat_item_producer",
    children: CATALOG_ITEM_CHILDREN,
    nameField: "name",
    activeField: "active",
    scriptFields: ["script"],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table_name",
    metaFields: ["table_name", "category", "sc_catalogs", "order"],
    writeFields: ["short_description", "description"],
  },
  {
    ...BASE,
    type: "variable_set",
    group: "catalog",
    sdkApi: "VariableSet",
    sdkSince: null,
    table: "item_option_new_set",
    children: [
      {
        table: "item_option_new",
        parentField: "variable_set",
        orderField: "order",
        nameField: "name",
        writeFields: VARIABLE_WRITE_FIELDS,
      },
      ...VARIABLE_CHOICES,
      ...catalogLogic("variable_set", "variable_set"),
      CATALOG_POLICY_ACTIONS,
      // Where the set is used.
      {
        table: "io_set_item",
        parentField: "variable_set",
        orderField: "order",
        refFields: [
          { field: "sc_cat_item", table: "sc_cat_item", type: "catalog_item" },
        ],
      },
    ],
    nameField: "title",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["internal_name", "type", "order"],
    // P-24 (CAT-2, U until O-5).
    writeFields: ["description"],
  },
  {
    ...BASE,
    type: "catalog_variable",
    group: "catalog",
    // Variables are modelled inside CatalogItem / VariableSet, not on their own.
    sdkApi: "none",
    sdkSince: null,
    table: "item_option_new",
    children: [
      {
        table: "question_choice",
        parentField: "question",
        orderField: "order",
        nameField: "text",
        writeFields: ["value"],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    refFields: [
      { field: "cat_item", table: "sc_cat_item", type: "catalog_item" },
      {
        field: "variable_set",
        table: "item_option_new_set",
        type: "variable_set",
      },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: [
      "question_text",
      "type",
      "order",
      "mandatory",
      "cat_item",
      "variable_set",
    ],
    writeFields: ["default_value", "help_text", "reference"],
  },
  {
    ...BASE,
    type: "catalog_ui_policy",
    group: "catalog",
    sdkApi: "CatalogUiPolicy",
    sdkSince: null,
    table: "catalog_ui_policy",
    children: [
      {
        table: "catalog_ui_policy_action",
        parentField: "ui_policy",
        nameField: "catalog_variable",
        writeFields: ["visible", "mandatory", "disabled"],
      },
    ],
    nameField: "short_description",
    activeField: "active",
    scriptFields: ["script_true", "script_false"],
    clientFields: ["script_true", "script_false"],
    refFields: [
      { field: "catalog_item", table: "sc_cat_item", type: "catalog_item" },
      {
        field: "variable_set",
        table: "item_option_new_set",
        type: "variable_set",
      },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["applies_to", "catalog_item", "variable_set", "order"],
    whenFields: ["catalog_conditions", "on_load", "reverse_if_false"],
  },
  // Testing, quality and assessment
  {
    ...BASE,
    type: "atf_test",
    group: "quality",
    sdkApi: "Test",
    sdkSince: null,
    table: "sys_atf_test",
    children: [
      {
        table: "sys_atf_step",
        parentField: "test",
        orderField: "order",
        nameField: "step_config",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["description", "active"],
  },
  {
    ...BASE,
    type: "atf_test_suite",
    group: "quality",
    sdkApi: "TestSuite",
    sdkSince: null,
    table: "sys_atf_test_suite",
    children: [
      {
        table: "sys_atf_test_suite_test",
        parentField: "test_suite",
        orderField: "order",
        nameField: "test",
        refFields: [{ field: "test", table: "sys_atf_test", type: "atf_test" }],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    refFields: [
      { field: "parent", table: "sys_atf_test_suite", type: "atf_test_suite" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["parent", "active"],
  },
  ...SCAN_CHECKS.map(
    ([type, table, sdkApi, meta]): ArtifactType => ({
      ...BASE,
      type,
      group: "quality",
      sdkApi,
      sdkSince: null,
      table,
      nameField: "name",
      activeField: "active",
      scriptFields: ["script"],
      tiers: SEED_TIERS,
      verified: false,
      metaFields: ["category", "priority", "short_description", ...meta],
    }),
  ),
  {
    ...BASE,
    type: "assessment",
    group: "quality",
    sdkApi: "Assessment",
    sdkSince: null,
    table: "asmt_metric_type",
    children: [
      {
        table: "asmt_metric_category",
        parentField: "metric_type",
        nameField: "name",
      },
      {
        table: "asmt_metric",
        parentField: "metric_type",
        orderField: "order",
        nameField: "name",
      },
      {
        table: "asmt_metric_definition",
        parentField: "metric",
        parentTable: "asmt_metric",
        orderField: "order",
        nameField: "display",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "condition", "active"],
  },
  {
    ...BASE,
    type: "risk_assessment",
    group: "quality",
    sdkApi: "RiskAssessment",
    sdkSince: null,
    table: "change_risk_asmt",
    children: [
      {
        table: "change_risk_asmt_threshold",
        parentField: "risk_assessment",
        orderField: "order",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["condition", "active"],
  },
  // AI (licensed store apps: absent tables answer available:false)
  {
    ...BASE,
    type: "ai_agent",
    group: "ai",
    sdkApi: "AiAgent",
    sdkSince: null,
    table: "sn_aia_agent",
    children: [
      { table: "sn_aia_agent_config", parentField: "agent" },
      { table: "sn_aia_agent_tool_m2m", parentField: "agent" },
      {
        table: "sn_aia_tool",
        parentField: "sys_id",
        parentTable: "sn_aia_agent_tool_m2m",
        parentKey: "tool",
        nameField: "name",
      },
      { table: "sn_aia_trigger_configuration", parentField: "agent" },
      { table: "sn_aia_version", parentField: "agent" },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    licensed: AI_AGENTS_APP,
    metaFields: ["description", "active"],
  },
  {
    ...BASE,
    type: "ai_agentic_workflow",
    group: "ai",
    sdkApi: "AiAgenticWorkflow",
    sdkSince: null,
    table: "sn_aia_usecase",
    children: [
      {
        table: "sn_aia_team",
        parentField: "sys_id",
        parentKey: "team",
        nameField: "name",
      },
      {
        table: "sn_aia_team_member",
        parentField: "team",
        parentTable: "sn_aia_team",
        refFields: [
          { field: "agent", table: "sn_aia_agent", type: "ai_agent" },
        ],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    licensed: AI_AGENTS_APP,
    metaFields: ["description", "team", "active"],
  },
  {
    ...BASE,
    type: "now_assist_skill",
    group: "ai",
    sdkApi: "NowAssistSkillConfig",
    sdkSince: null,
    // The inventory lists the family as `sn_nowassist_skill_*` (U).
    table: "sn_nowassist_skill_config",
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    licensed: "Now Assist Skill Kit (sn_nowassist_skill)",
  },
  // Application, scope and delivery
  {
    ...BASE,
    type: "application",
    group: "application",
    // now.config.json, not a Fluent API.
    sdkApi: "none",
    sdkSince: null,
    table: "sys_app",
    children: [
      {
        table: "sys_scope_dependency",
        parentField: "scope",
        nameField: "dependency",
      },
      {
        table: "sys_package_dependency",
        parentField: "sys_package",
        nameField: "dependency",
      },
    ],
    nameField: "name",
    keyFields: ["scope"],
    activeField: "active",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["scope", "version", "vendor", "active"],
  },
  {
    ...BASE,
    type: "app_dependency",
    group: "application",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_scope_dependency",
    nameField: "dependency",
    scopeField: "scope",
    scriptFields: [],
    refFields: [
      { field: "scope", table: "sys_app", type: "application" },
      { field: "dependency", table: "sys_app", type: "application" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    metaFields: ["scope", "dependency", "min_version"],
  },
  {
    ...BASE,
    type: "customer_update",
    group: "application",
    sdkApi: "none",
    sdkSince: null,
    // The payload is XML, not JSON: explain shows it capped, undecoded.
    table: "sys_update_xml",
    nameField: "name",
    scopeField: "application",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    metaFields: ["type", "target_name", "action", "update_set", "update_guid"],
  },
  {
    ...BASE,
    type: "source_control",
    group: "application",
    sdkApi: "none",
    sdkSince: null,
    table: "sys_repo_config",
    nameField: "url",
    scriptFields: [],
    tiers: READ_TIER,
    verified: false,
    metaFields: ["url", "branch", "application"],
  },
  // -- N-8: reports and Performance Analytics (SDK-PARITY §4.13) -----------
  // Read-only seeds. O-5: verify on a live instance — every table and field
  // below comes from the SDK table schemas (`sys_report`, `pa_dashboards`) or
  // the platform documentation (the other `pa_*` tables) and is unverified.
  {
    ...BASE,
    type: "report",
    group: "reporting",
    // The Fluent `Record()` fallback only; no report API on the baseline.
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance (sys_report, sys_report_users_groups).
    table: "sys_report",
    children: [
      {
        table: "sys_report_users_groups",
        parentField: "report_id",
        refFields: [
          { field: "user_id", table: "sys_user" },
          { field: "group_id", table: "sys_user_group" },
        ],
      },
    ],
    nameField: "title",
    scriptFields: [],
    // O-5: verify on a live instance.
    refFields: [
      {
        field: "report_source",
        table: "sys_report_source",
        type: "report_source",
      },
      { field: "report_drilldown", table: "sys_report_drill" },
      { field: "list_ui_view", table: "sys_ui_view" },
      { field: "group", table: "sys_user_group" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    // O-5: verify on a live instance (`type` is not in the SDK schema).
    metaFields: [
      "table",
      "type",
      "field",
      "aggregate",
      "filter",
      "field_list",
      "is_published",
      "roles",
    ],
  },
  {
    ...BASE,
    type: "report_source",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance.
    table: "sys_report_source",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    appliesToField: "table",
    metaFields: ["table", "filter"],
  },
  {
    ...BASE,
    type: "pa_indicator",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance (pa_indicators, pa_indicator_breakdowns).
    table: "pa_indicators",
    children: [
      {
        table: "pa_indicator_breakdowns",
        parentField: "indicator",
        refFields: [
          { field: "breakdown", table: "pa_breakdowns", type: "pa_breakdown" },
        ],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    // O-5: verify on a live instance.
    refFields: [
      { field: "cube", table: "pa_cubes", type: "pa_indicator_source" },
      { field: "script", table: "pa_scripts", type: "pa_script" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    licensed: PERFORMANCE_ANALYTICS,
    metaFields: [
      "type",
      "cube",
      "aggregate",
      "field",
      "conditions",
      "frequency",
      "formula",
      "active",
    ],
  },
  {
    ...BASE,
    type: "pa_indicator_source",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance.
    table: "pa_cubes",
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
    licensed: PERFORMANCE_ANALYTICS,
    appliesToField: "facts_table",
    metaFields: ["facts_table", "conditions", "frequency"],
  },
  {
    ...BASE,
    type: "pa_breakdown",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance (pa_breakdowns, pa_breakdown_mappings).
    table: "pa_breakdowns",
    children: [
      {
        table: "pa_breakdown_mappings",
        parentField: "breakdown",
        refFields: [
          { field: "script", table: "pa_scripts", type: "pa_script" },
        ],
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    // O-5: verify on a live instance.
    refFields: [{ field: "dimension", table: "pa_dimensions" }],
    tiers: SEED_TIERS,
    verified: false,
    licensed: PERFORMANCE_ANALYTICS,
    metaFields: ["dimension", "active"],
  },
  {
    ...BASE,
    type: "pa_script",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance. A script field, but not a script-tools
    // type: list_scripts / search_code do not sweep it (no enum growth).
    table: "pa_scripts",
    nameField: "name",
    scriptFields: ["script"],
    tiers: SEED_TIERS,
    verified: false,
    licensed: PERFORMANCE_ANALYTICS,
    appliesToField: "facts_table",
    metaFields: ["facts_table", "fields"],
  },
  {
    ...BASE,
    type: "pa_dashboard",
    group: "reporting",
    sdkApi: "none",
    sdkSince: null,
    // O-5: verify on a live instance (pa_m2m_dashboard_tabs, pa_tabs).
    table: "pa_dashboards",
    children: [
      {
        table: "pa_m2m_dashboard_tabs",
        parentField: "dashboard",
        orderField: "order",
      },
      {
        table: "pa_tabs",
        parentField: "sys_id",
        parentTable: "pa_m2m_dashboard_tabs",
        parentKey: "tab",
        nameField: "name",
      },
    ],
    nameField: "name",
    activeField: "active",
    scriptFields: [],
    // From the SDK `pa_dashboards` schema; O-5: verify on a live instance.
    refFields: [
      {
        field: "experience_dashboard",
        table: "par_dashboard",
        type: "dashboard",
      },
      {
        field: "managed_breakdown",
        table: "pa_breakdowns",
        type: "pa_breakdown",
      },
      { field: "breakdown_source", table: "pa_dimensions" },
      { field: "group", table: "pa_dashboards_group" },
      { field: "owner", table: "sys_user" },
    ],
    tiers: SEED_TIERS,
    verified: false,
    licensed: PERFORMANCE_ANALYTICS,
    metaFields: ["description", "group", "owner", "active"],
  },
  // -- next-only (SDK 4.13.0 on npm `next`; SDK-PARITY CORE-3) -------------
  // The API page returned 404 at inventory time: the tables are unverified.
  {
    ...BASE,
    type: "database_view",
    group: "core",
    sdkApi: "DatabaseView",
    sdkSince: "4.13.0",
    table: "sys_db_view",
    children: [
      { table: "sys_db_view_table", parentField: "view", orderField: "order" },
    ],
    nameField: "name",
    scriptFields: [],
    tiers: SEED_TIERS,
    verified: false,
  },
];

/** Registry lookup by type id. */
export function getArtifactType(type: string): ArtifactType | undefined {
  return ARTIFACT_TYPES.find((t) => t.type === type);
}

/**
 * Consistency problems in a descriptor list (empty when valid): duplicate
 * type ids, unknown groups / SDK APIs / decoders, a `next`-only SDK API on a
 * verified or G-tier type, a `sdkSince` on a type the
 * SDK does not model, script-tools / opt-in types without script fields or
 * with both flags, client / markup fields that are not script fields,
 * children without a parent field or with a parent table
 * that is neither the primary table nor an earlier child, an empty value link
 * (`parentKey` / `alsoMatch`) or an `alsoMatch` on a nested child, empty
 * or system-field P-24 unique / scope-prefix rules, and references to
 * unregistered types.
 */
export function validateArtifactTypes(
  types: readonly ArtifactType[] = ARTIFACT_TYPES,
): string[] {
  const problems: string[] = [];
  const ids = new Set(types.map((t) => t.type));
  const seen = new Set<string>();
  const checkJson = (where: string, fields: JsonField[] | undefined) => {
    for (const j of fields ?? []) {
      if (!(DECODER_IDS as readonly string[]).includes(j.decoder)) {
        problems.push(`${where}: unknown decoder '${j.decoder}' on ${j.field}`);
      }
    }
  };
  const checkRefs = (where: string, refs: RefField[] | undefined) => {
    for (const r of refs ?? []) {
      if (r.type !== undefined && !ids.has(r.type)) {
        problems.push(`${where}: ${r.field} references unknown type ${r.type}`);
      }
    }
  };
  const checkUnique = (where: string, rules: UniqueRule[] | undefined) => {
    for (const r of rules ?? []) {
      if (
        !r.fields.length ||
        r.fields.some((f) => !f || f.startsWith("sys_"))
      ) {
        problems.push(`${where}: a unique rule needs non-system fields`);
      }
    }
  };
  for (const t of types) {
    const where = t.type;
    if (seen.has(t.type)) problems.push(`${where}: duplicate type`);
    seen.add(t.type);
    if (!(ARTIFACT_GROUPS as readonly string[]).includes(t.group)) {
      problems.push(`${where}: unknown group '${t.group}'`);
    }
    if ((SDK_NEXT_APIS as readonly string[]).includes(t.sdkApi)) {
      if (t.verified || t.tiers.includes("G")) {
        problems.push(
          `${where}: next-only sdkApi '${t.sdkApi}' must be verified:false without a G tier`,
        );
      }
    } else if (
      t.sdkApi !== "none" &&
      !(SDK_APIS as readonly string[]).includes(t.sdkApi)
    ) {
      problems.push(`${where}: sdkApi '${t.sdkApi}' is not on the baseline`);
    }
    if (t.sdkApi === "none" && t.sdkSince !== null) {
      problems.push(`${where}: sdkSince set but sdkApi is 'none'`);
    }
    if (!t.table || !t.nameField || t.keyFields.length === 0) {
      problems.push(`${where}: table, nameField and keyFields are required`);
    }
    if (t.scriptTools && t.scriptFields.length === 0) {
      problems.push(`${where}: a script-tools type needs scriptFields`);
    }
    if (t.scriptToolsOptIn && t.scriptTools) {
      problems.push(`${where}: scriptTools and scriptToolsOptIn are exclusive`);
    }
    if (t.scriptToolsOptIn && t.scriptFields.length === 0) {
      problems.push(`${where}: an opt-in script type needs scriptFields`);
    }
    for (const f of [...(t.clientFields ?? []), ...(t.markupFields ?? [])]) {
      if (!t.scriptFields.includes(f)) {
        problems.push(`${where}: ${f} is not one of its scriptFields`);
      }
    }
    checkJson(where, t.jsonFields);
    checkRefs(where, t.refFields);
    for (const f of t.writeFields ?? []) {
      if (f.startsWith("sys_")) {
        problems.push(`${where}: writeFields may not name system field ${f}`);
      }
    }
    checkUnique(where, t.unique);
    for (const f of t.scopePrefixFields ?? []) {
      if (!f || f.startsWith("sys_")) {
        problems.push(`${where}: scopePrefixFields may not name ${f || "''"}`);
      }
    }
    const tables = new Set([t.table]);
    for (const c of t.children) {
      const cw = `${where} > ${c.table}`;
      if (!c.parentField) problems.push(`${cw}: missing parentField`);
      if (c.parentTable !== undefined && !tables.has(c.parentTable)) {
        problems.push(
          `${cw}: parentTable ${c.parentTable} is not declared before it`,
        );
      }
      if (
        c.parentKey === "" ||
        c.alsoMatch?.some((m) => !m.field || !m.parentKey)
      ) {
        problems.push(`${cw}: empty parentKey or alsoMatch field`);
      }
      if (c.alsoMatch?.length && (c.parentTable ?? t.table) !== t.table) {
        problems.push(`${cw}: alsoMatch needs the primary table as parent`);
      }
      for (const f of c.writeFields ?? []) {
        if (f.startsWith("sys_") || f === c.parentField) {
          problems.push(`${cw}: writeFields may not name ${f}`);
        }
      }
      checkUnique(cw, c.unique);
      tables.add(c.table);
      checkJson(cw, c.jsonFields);
      checkRefs(cw, c.refFields);
    }
  }
  return problems;
}
