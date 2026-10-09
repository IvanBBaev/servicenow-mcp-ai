import { readBool } from "../core/settings-manifest.js";

/**
 * M-7 (B2): the tool naming convention v3 — every tool is
 * `servicenow_<verb>_<noun>`. The idiomatic single-word API names
 * (`aggregate`, `batch`, `where_used`) and the IRE term `identify_reconcile`
 * are kept as they are.
 *
 * This module is the single source of truth for tool names:
 * - {@link TOOLS} names every tool; `ToolSpec.name` is typed against it, so a
 *   spec cannot carry a name missing here, and prompts reference tools through
 *   it (a renamed tool is a compile error, not a stale prompt).
 * - {@link TOOL_RENAMES} maps every v2 name to its v3 name. The registry
 *   registers the old names as aliases under `SN_LEGACY_TOOL_NAMES=1`, and
 *   `npm run docs:readme` renders the README / CHANGELOG rename table from it.
 */
export const TOOLS = {
  aggregate: "servicenow_aggregate",
  batch: "servicenow_batch",
  check_capabilities: "servicenow_check_capabilities",
  check_change_conflicts: "servicenow_check_change_conflicts",
  check_code_health: "servicenow_check_code_health",
  check_data_health: "servicenow_check_data_health",
  compare_instances: "servicenow_compare_instances",
  compare_update_set: "servicenow_compare_update_set",
  create_change: "servicenow_create_change",
  create_ci: "servicenow_create_ci",
  create_record: "servicenow_create_record",
  delete_attachment: "servicenow_delete_attachment",
  delete_record: "servicenow_delete_record",
  describe_table: "servicenow_describe_table",
  describe_table_logic: "servicenow_describe_table_logic",
  disable_package: "servicenow_disable_package",
  document_app: "servicenow_document_app",
  document_instance: "servicenow_document_instance",
  document_table: "servicenow_document_table",
  download_attachment: "servicenow_download_attachment",
  enable_package: "servicenow_enable_package",
  explain_artifact: "servicenow_explain_artifact",
  explain_flow: "servicenow_explain_flow",
  explain_policy: "servicenow_explain_policy",
  explain_portal: "servicenow_explain_portal",
  explain_ui_experience: "servicenow_explain_ui_experience",
  find_tools: "servicenow_find_tools",
  generate_er_diagram: "servicenow_generate_er_diagram",
  generate_fluent: "servicenow_generate_fluent",
  generate_table_flow: "servicenow_generate_table_flow",
  get_artifact: "servicenow_get_artifact",
  get_artifact_dependencies: "servicenow_get_artifact_dependencies",
  get_atf_result: "servicenow_get_atf_result",
  get_attachment: "servicenow_get_attachment",
  get_catalog_item: "servicenow_get_catalog_item",
  get_change: "servicenow_get_change",
  get_ci: "servicenow_get_ci",
  get_cmdb_meta: "servicenow_get_cmdb_meta",
  get_email: "servicenow_get_email",
  get_flow: "servicenow_get_flow",
  get_flow_runs: "servicenow_get_flow_runs",
  get_import_set_row: "servicenow_get_import_set_row",
  get_knowledge_article: "servicenow_get_knowledge_article",
  get_knowledge_highlights: "servicenow_get_knowledge_highlights",
  get_properties: "servicenow_get_properties",
  get_record: "servicenow_get_record",
  get_record_history: "servicenow_get_record_history",
  get_script: "servicenow_get_script",
  get_status: "servicenow_get_status",
  get_task_context: "servicenow_get_task_context",
  get_update_set: "servicenow_get_update_set",
  identify_reconcile: "servicenow_identify_reconcile",
  insert_import_set_row: "servicenow_insert_import_set_row",
  lint_script: "servicenow_lint_script",
  lint_table: "servicenow_lint_table",
  list_artifacts: "servicenow_list_artifacts",
  list_atf_suites: "servicenow_list_atf_suites",
  list_atf_tests: "servicenow_list_atf_tests",
  list_attachments: "servicenow_list_attachments",
  list_catalog_categories: "servicenow_list_catalog_categories",
  list_catalog_items: "servicenow_list_catalog_items",
  list_catalogs: "servicenow_list_catalogs",
  list_changes: "servicenow_list_changes",
  list_ci_relations: "servicenow_list_ci_relations",
  list_cis: "servicenow_list_cis",
  list_docs: "servicenow_list_docs",
  list_flows: "servicenow_list_flows",
  list_instances: "servicenow_list_instances",
  list_packages: "servicenow_list_packages",
  list_scripts: "servicenow_list_scripts",
  list_tables: "servicenow_list_tables",
  list_update_sets: "servicenow_list_update_sets",
  list_writes: "servicenow_list_writes",
  lookup_directory: "servicenow_lookup_directory",
  order_catalog_item: "servicenow_order_catalog_item",
  query_table: "servicenow_query_table",
  read_doc: "servicenow_read_doc",
  read_ops: "servicenow_read_ops",
  revert_write: "servicenow_revert_write",
  review_upgrade: "servicenow_review_upgrade",
  run_atf_suite: "servicenow_run_atf_suite",
  run_atf_test: "servicenow_run_atf_test",
  search_code: "servicenow_search_code",
  search_docs: "servicenow_search_docs",
  search_knowledge: "servicenow_search_knowledge",
  send_email: "servicenow_send_email",
  set_credentials: "servicenow_set_credentials",
  set_property: "servicenow_set_property",
  snapshot_instance: "servicenow_snapshot_instance",
  test_connection: "servicenow_test_connection",
  trace_table_event: "servicenow_trace_table_event",
  update_change: "servicenow_update_change",
  update_ci: "servicenow_update_ci",
  update_record: "servicenow_update_record",
  upload_attachment: "servicenow_upload_attachment",
  upsert_artifact: "servicenow_upsert_artifact",
  upsert_record: "servicenow_upsert_record",
  use_instance: "servicenow_use_instance",
  where_used: "servicenow_where_used",
  write_doc: "servicenow_write_doc",
} as const;

/** Every tool name (v3). */
export type ToolName = (typeof TOOLS)[keyof typeof TOOLS];

/** One renamed tool: its v2 name, its v3 name and why it changed. */
export interface ToolRename {
  from: string;
  to: ToolName;
  reason: string;
}

/**
 * M-7 (B2): every v2 tool name that v3 renamed — the one source the legacy
 * aliases, the manifest's `toolRenames` and the generated README / CHANGELOG
 * table are built from.
 */
export const TOOL_RENAMES: readonly ToolRename[] = [
  {
    from: "servicenow_artifact_dependencies",
    to: TOOLS.get_artifact_dependencies,
    reason: "No verb.",
  },
  {
    from: "servicenow_change_conflicts",
    to: TOOLS.check_change_conflicts,
    reason: "No verb.",
  },
  {
    from: "servicenow_code_health",
    to: TOOLS.check_code_health,
    reason: "No verb.",
  },
  {
    from: "servicenow_data_health",
    to: TOOLS.check_data_health,
    reason: "No verb; parallels check_code_health.",
  },
  {
    from: "servicenow_docs_list",
    to: TOOLS.list_docs,
    reason: "Noun before verb.",
  },
  {
    from: "servicenow_docs_read",
    to: TOOLS.read_doc,
    reason: "Noun before verb.",
  },
  {
    from: "servicenow_docs_search",
    to: TOOLS.search_docs,
    reason: "Noun before verb.",
  },
  {
    from: "servicenow_docs_write",
    to: TOOLS.write_doc,
    reason: "Noun before verb.",
  },
  {
    from: "servicenow_knowledge_highlights",
    to: TOOLS.get_knowledge_highlights,
    reason: "No verb.",
  },
  {
    from: "servicenow_ops_read",
    to: TOOLS.read_ops,
    reason: "Noun before verb.",
  },
  {
    from: "servicenow_table_logic",
    to: TOOLS.describe_table_logic,
    reason: "No verb.",
  },
];

/** The v3 name of a v2 name, or undefined when the name was not renamed. */
export function renamedTo(from: string): ToolName | undefined {
  return TOOL_RENAMES.find((r) => r.from === from)?.to;
}

/**
 * True when `SN_LEGACY_TOOL_NAMES=1`: the v2 tool names register as aliases
 * and the v2 parameter names are accepted (read at registration and call
 * time). A deprecated bridge for one minor cycle.
 */
export function legacyToolNames(): boolean {
  return readBool("SN_LEGACY_TOOL_NAMES");
}

/**
 * M-7 (TE-4): tools that overlap another tool and are kept on purpose. The
 * manifest publishes the reason per tool (`overlap`), so a client or a
 * reviewer sees why both exist.
 */
export const TOOL_OVERLAPS: Readonly<Partial<Record<ToolName, string>>> = {
  servicenow_get_status:
    "Kept beside test_connection and check_capabilities: local only (no request) — configuration, profile, policy and packages; also servicenow://status.",
  servicenow_test_connection:
    "Kept beside get_status and check_capabilities: one authenticated round trip that proves the credentials work.",
  servicenow_check_capabilities:
    "Kept beside get_status and test_connection: probes which admin tables and features the user can reach; also servicenow://capabilities.",
  servicenow_list_atf_tests:
    "Kept beside list_atf_suites: tests and suites are different tables, run by different tools (run_atf_test / run_atf_suite).",
  servicenow_list_atf_suites:
    "Kept beside list_atf_tests: tests and suites are different tables, run by different tools (run_atf_test / run_atf_suite).",
};
