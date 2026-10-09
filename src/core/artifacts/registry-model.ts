/**
 * The artefact registry's model: SDK API lists, groups, tiers, the
 * descriptor shapes and the building blocks the data files share.
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
export const BASE = {
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
export const SCRIPT_TOOL_TIERS: Tier[] = ["R", "A", "S"];

/** The read tier alone: P-9 descriptors served by the generic artefact tools. */
export const READ_TIER: Tier[] = ["R"];

/**
 * Children of a flow or subflow (FLW-4 … FLW-8). Which of the `_v2` / plain
 * instance tables is authoritative per release is O-5 item 5; get_flow reads
 * the plain trigger/action tables today.
 */
export const FLOW_CHILDREN: ArtifactChild[] = [
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
export const EXPLAINED_SCRIPT_TIERS: Tier[] = ["R", "X", "A", "S"];

/** P-7 seeds: listed / read by the generic artefact tools and explained. */
export const SEED_TIERS: Tier[] = ["R", "X"];

/**
 * P-8: the choices of every variable read so far (item and set variables:
 * child rows accumulate per table, so one read covers both).
 */
export const VARIABLE_CHOICES: ArtifactChild[] = [
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
export const VARIABLE_WRITE_FIELDS = [
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
export function catalogLogic(
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

export const CATALOG_POLICY_ACTIONS: ArtifactChild = {
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
export const CATALOG_ITEM_CHILDREN: ArtifactChild[] = [
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
export const SCAN_CHECKS: [string, string, SdkApi, string[]][] = [
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
export const AI_AGENTS_APP = "Now Assist AI Agents (sn_aia)";
