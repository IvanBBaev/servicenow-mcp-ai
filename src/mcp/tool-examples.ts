import type { ToolName } from "./naming.js";

/**
 * N-37 / N-54: one example call per tool, served in
 * servicenow://reference/tools/{name} next to the input and output schemas
 * (never in tools/list). Each example's arguments parse against the tool's
 * own input schema (test/tool-examples.test.js), so a schema change that
 * breaks one fails the gate. Write tools show the default plan preview
 * (no `apply`); the sys_ids are placeholders.
 */
export interface ToolExample {
  /** What the call does, in one line. */
  summary: string;
  arguments: Record<string, unknown>;
}

const ID = "46d44a0a0a0a0b5700c77f9bf387afe3";
const ID2 = "9d385017c611228701d22104cc95c371";

export const TOOL_EXAMPLES: Record<ToolName, ToolExample> = {
  servicenow_aggregate: {
    summary: "Count active incidents per priority.",
    arguments: {
      table: "incident",
      query: "active=true",
      count: true,
      group_by: ["priority"],
    },
  },
  servicenow_batch: {
    summary: "Read two records in one round trip.",
    arguments: {
      requests: [
        { id: "a", method: "GET", url: `/api/now/table/incident/${ID}` },
        { id: "b", method: "GET", url: `/api/now/table/sys_user/${ID2}` },
      ],
    },
  },
  servicenow_check_capabilities: {
    summary: "Probe write access and the update-set capability.",
    arguments: { groups: ["writes", "update_sets"] },
  },
  servicenow_check_change_conflicts: {
    summary: "Preview a conflict check for one change request.",
    arguments: { sys_id: ID },
  },
  servicenow_check_code_health: {
    summary: "Scan one scope's scripts and ACLs.",
    arguments: { scope: "x_acme_app", limit: 50 },
  },
  servicenow_check_data_health: {
    summary:
      "Duplicates, broken references and stale rows on active incidents.",
    arguments: {
      table: "incident",
      query: "active=true",
      key_fields: ["number"],
    },
  },
  servicenow_compare_instances: {
    summary: "Compare dev with test for one scope, ACLs included.",
    arguments: { a: "dev", b: "test", scope: "x_acme_app", sections: ["acls"] },
  },
  servicenow_compare_update_set: {
    summary: "Compare an update set's records with another profile.",
    arguments: { update_set: "Release 1.4", with_profile: "prod" },
  },
  servicenow_create_change: {
    summary: "Preview a normal change request.",
    arguments: {
      type: "normal",
      values: { short_description: "Patch web tier" },
    },
  },
  servicenow_create_ci: {
    summary: "Preview a Linux server CI.",
    arguments: { table: "cmdb_ci_linux_server", values: { name: "web-01" } },
  },
  servicenow_create_record: {
    summary: "Preview a new incident.",
    arguments: {
      table: "incident",
      values: { short_description: "Email is down", urgency: "2" },
    },
  },
  servicenow_delete_attachment: {
    summary: "Preview deleting one attachment.",
    arguments: { sys_id: ID },
  },
  servicenow_delete_record: {
    summary: "Preview deleting one incident.",
    arguments: { table: "incident", sys_id: ID },
  },
  servicenow_describe_table: {
    summary: "Fields, types and references of incident.",
    arguments: { table: "incident" },
  },
  servicenow_describe_table_logic: {
    summary: "Business rules, client scripts, ACLs and flows on incident.",
    arguments: { table: "incident" },
  },
  servicenow_disable_package: {
    summary: "Unload the cmdb package for this session.",
    arguments: { name: "cmdb" },
  },
  servicenow_document_app: {
    summary: "Return the Markdown of one app without writing it.",
    arguments: { scope: "x_acme_app", write: false },
  },
  servicenow_document_instance: {
    summary: "Write the overview and the security document.",
    arguments: { depth: "overview", kinds: ["security"] },
  },
  servicenow_document_table: {
    summary: "Write the incident table document with its own columns.",
    arguments: { table: "incident", columns: "own" },
  },
  servicenow_download_attachment: {
    summary: "Download one attachment's content.",
    arguments: { sys_id: ID },
  },
  servicenow_enable_package: {
    summary: "Load the cmdb package for this session.",
    arguments: { name: "cmdb" },
  },
  servicenow_explain_access: {
    summary: "Why a user cannot write one incident's assignment group.",
    arguments: {
      user: "abel.tuter",
      table: "incident",
      operation: "write",
      sys_id: ID,
      field: "assignment_group",
    },
  },
  servicenow_explain_artifact: {
    summary: "Explain one business rule.",
    arguments: { artifactType: "business_rule", sys_id: ID },
  },
  servicenow_explain_flow: {
    summary: "Explain a flow as Markdown, with its recent runs.",
    arguments: { sys_id: ID, format: "markdown", runs: 5 },
  },
  servicenow_explain_policy: {
    summary: "Why writes to sys_user are allowed or refused.",
    arguments: { table: "sys_user", action: "write" },
  },
  servicenow_explain_portal: {
    summary: "Explain one portal page.",
    arguments: { portal: "sp", page: "index" },
  },
  servicenow_explain_ui_experience: {
    summary: "Explain a UI Builder experience by URL path.",
    arguments: { path: "now/sow" },
  },
  servicenow_find_tools: {
    summary: "Find the tools for reading attachments.",
    arguments: { query: "download an attachment", limit: 5 },
  },
  servicenow_generate_er_diagram: {
    summary: "ER diagram of incident and problem.",
    arguments: { tables: ["incident", "problem"], columns: "keys", depth: 1 },
  },
  servicenow_generate_table_flow: {
    summary: "Mermaid flow of an update on incident.",
    arguments: { table: "incident", operation: "update" },
  },
  servicenow_get_artifact: {
    summary: "One script include by name.",
    arguments: { artifactType: "script_include", key: "IncidentUtils" },
  },
  servicenow_get_artifact_dependencies: {
    summary: "What a script include uses and what uses it.",
    arguments: {
      artifactType: "script_include",
      key: "IncidentUtils",
      direction: "both",
    },
  },
  servicenow_get_atf_result: {
    summary: "Result of one ATF execution.",
    arguments: { execution_id: ID },
  },
  servicenow_get_attachment: {
    summary: "Metadata of one attachment.",
    arguments: { sys_id: ID },
  },
  servicenow_get_catalog_item: {
    summary: "One catalog item and its variables.",
    arguments: { sys_id: ID },
  },
  servicenow_get_change: {
    summary: "One change request.",
    arguments: { sys_id: ID },
  },
  servicenow_get_ci: {
    summary: "One server CI.",
    arguments: { sys_id: ID, table: "cmdb_ci_server" },
  },
  servicenow_get_cmdb_meta: {
    summary: "Fields and identification rules of a CI class.",
    arguments: { table: "cmdb_ci_linux_server" },
  },
  servicenow_get_email: {
    summary: "One email record.",
    arguments: { sys_id: ID },
  },
  servicenow_get_flow: {
    summary: "One flow's definition.",
    arguments: { sys_id: ID },
  },
  servicenow_get_flow_runs: {
    summary: "Recent runs of one flow.",
    arguments: { flow: ID, limit: 10 },
  },
  servicenow_get_import_set_row: {
    summary: "One import set row and its transform result.",
    arguments: { table: "u_imp_users", sys_id: ID },
  },
  servicenow_get_knowledge_article: {
    summary: "One knowledge article.",
    arguments: { sys_id: ID },
  },
  servicenow_get_knowledge_highlights: {
    summary: "The most viewed articles.",
    arguments: { mode: "most_viewed", limit: 5 },
  },
  servicenow_get_properties: {
    summary: "System properties with a prefix.",
    arguments: { prefix: "glide.ui.", limit: 20 },
  },
  servicenow_get_record: {
    summary: "Three fields of one incident.",
    arguments: {
      table: "incident",
      sys_id: ID,
      fields: ["number", "state", "short_description"],
    },
  },
  servicenow_get_record_history: {
    summary: "Audit and journal history of one incident.",
    arguments: { table: "incident", sys_id: ID, limit: 20 },
  },
  servicenow_get_script: {
    summary: "One business rule's script.",
    arguments: { type: "business_rule", sys_id: ID },
  },
  servicenow_get_status: {
    summary: "Profile, write mode and loaded packages.",
    arguments: {},
  },
  servicenow_get_task_context: {
    summary: "Assignment, approvals and SLAs of one incident.",
    arguments: { number: "INC0010001" },
  },
  servicenow_get_update_set: {
    summary: "The business rules in one update set.",
    arguments: { update_set: "Release 1.4", type: "Business Rule" },
  },
  servicenow_identify_reconcile: {
    summary: "Preview identifying one Linux server through IRE.",
    arguments: {
      items: [
        {
          className: "cmdb_ci_linux_server",
          values: { name: "web-01", serial_number: "SN-1001" },
        },
      ],
    },
  },
  servicenow_insert_import_set_row: {
    summary: "Preview one row into an import set table.",
    arguments: { table: "u_imp_users", values: { u_user_name: "jdoe" } },
  },
  servicenow_lint_script: {
    summary: "Lint one script include.",
    arguments: { type: "script_include", sys_id: ID },
  },
  servicenow_lint_table: {
    summary: "Lint every script on incident.",
    arguments: { table: "incident" },
  },
  servicenow_list_artifacts: {
    summary: "Active business rules of one scope.",
    arguments: {
      artifactType: "business_rule",
      scope: "x_acme_app",
      active: true,
    },
  },
  servicenow_list_atf_suites: {
    summary: "ATF suites with their last results.",
    arguments: { with_results: true, limit: 20 },
  },
  servicenow_list_atf_tests: {
    summary: "Active ATF tests with their last results.",
    arguments: { active: true, with_results: true },
  },
  servicenow_list_attachments: {
    summary: "Attachments of one incident.",
    arguments: { table: "incident", sys_id: ID },
  },
  servicenow_list_catalog_categories: {
    summary: "Categories of one catalog.",
    arguments: { sys_id: ID },
  },
  servicenow_list_catalog_items: {
    summary: "Catalog items matching a text.",
    arguments: { text: "laptop", limit: 10 },
  },
  servicenow_list_catalogs: {
    summary: "Every service catalog.",
    arguments: {},
  },
  servicenow_list_changes: {
    summary: "Scheduled changes.",
    arguments: { query: "state=-2", limit: 10 },
  },
  servicenow_list_ci_relations: {
    summary: "What one CI depends on.",
    arguments: { sys_id: ID, direction: "outbound" },
  },
  servicenow_list_cis: {
    summary: "Linux servers by name.",
    arguments: {
      table: "cmdb_ci_linux_server",
      query: "nameSTARTSWITHweb",
      limit: 20,
    },
  },
  servicenow_list_docs: {
    summary: "Generated documents of the current profile.",
    arguments: {},
  },
  servicenow_list_flows: {
    summary: "Active flows on incident.",
    arguments: { table: "incident", active: true },
  },
  servicenow_list_instances: {
    summary: "Configured profiles.",
    arguments: {},
  },
  servicenow_list_packages: {
    summary: "Tool packages and their state.",
    arguments: {},
  },
  servicenow_list_scripts: {
    summary: "Active business rules on incident.",
    arguments: { type: "business_rule", table: "incident", active: true },
  },
  servicenow_list_tables: {
    summary: "Tables whose name contains a text.",
    arguments: { filter: "incident" },
  },
  servicenow_list_update_sets: {
    summary: "Update sets in progress.",
    arguments: { state: "in progress", limit: 10 },
  },
  servicenow_list_writes: {
    summary: "Failed writes of this profile.",
    arguments: { result: "failed", limit: 20 },
  },
  servicenow_lookup_directory: {
    summary: "Find a user, with role history.",
    arguments: { kind: "user", term: "jdoe", role_history: true },
  },
  servicenow_order_catalog_item: {
    summary: "Preview ordering one catalog item.",
    arguments: { sys_id: ID, quantity: 1 },
  },
  servicenow_query_table: {
    summary: "Five open P1 incidents, newest first.",
    arguments: {
      table: "incident",
      query: "active=true^priority=1^ORDERBYDESCsys_created_on",
      fields: ["number", "short_description", "state"],
      limit: 5,
    },
  },
  servicenow_read_doc: {
    summary: "Read one generated document.",
    arguments: { path: "tables/incident.md" },
  },
  servicenow_read_ops: {
    summary: "Errors in the system log of the last hour.",
    arguments: { kind: "syslog", level: "error", minutes: 60 },
  },
  servicenow_revert_write: {
    summary: "Preview reverting one journalled write.",
    arguments: { entry_id: "2026-10-09T10:00:00.000Z-1" },
  },
  servicenow_review_upgrade: {
    summary: "The upgrade history, newest first.",
    arguments: {},
  },
  servicenow_run_atf_suite: {
    summary: "Preview running one ATF suite.",
    arguments: { sys_id: ID },
  },
  servicenow_run_atf_test: {
    summary: "Preview running one ATF test.",
    arguments: { sys_id: ID },
  },
  servicenow_search_code: {
    summary: "Script includes that call GlideRecord on sys_user.",
    arguments: { text: "new GlideRecord('sys_user')", type: "script_include" },
  },
  servicenow_search_docs: {
    summary: "Search the generated documents.",
    arguments: { text: "assignment group" },
  },
  servicenow_search_knowledge: {
    summary: "Knowledge articles about VPN.",
    arguments: { search: "vpn", limit: 5 },
  },
  servicenow_send_email: {
    summary: "Preview an email.",
    arguments: {
      to: ["ops@example.com"],
      subject: "Maintenance",
      body: "Tonight 22:00.",
    },
  },
  servicenow_set_credentials: {
    summary:
      "Ask the user for a new API key (the secret never travels in the call).",
    arguments: { profile: "dev", auth: "apikey", request_secrets: ["api_key"] },
  },
  servicenow_set_property: {
    summary: "Preview changing one system property.",
    arguments: { name: "glide.ui.session_timeout", value: "60" },
  },
  servicenow_snapshot_instance: {
    summary: "Snapshot one scope's ACLs and properties.",
    arguments: { scope: "x_acme_app", sections: ["acls", "properties"] },
  },
  servicenow_test_connection: {
    summary: "Check that the profile can reach the instance.",
    arguments: {},
  },
  servicenow_trace_table_event: {
    summary: "Everything that runs on an incident update.",
    arguments: { table: "incident", operation: "update" },
  },
  servicenow_update_change: {
    summary: "Preview updating one change request.",
    arguments: { sys_id: ID, values: { risk: "3" } },
  },
  servicenow_update_ci: {
    summary: "Preview updating one CI.",
    arguments: {
      sys_id: ID,
      table: "cmdb_ci_server",
      values: { environment: "Production" },
    },
  },
  servicenow_update_record: {
    summary: "Preview updating one incident.",
    arguments: { table: "incident", sys_id: ID, values: { state: "2" } },
  },
  servicenow_upload_attachment: {
    summary: "Preview attaching a text file to one incident.",
    arguments: {
      table: "incident",
      sys_id: ID,
      file_name: "notes.txt",
      content_base64: "aGVsbG8=",
      content_type: "text/plain",
    },
  },
  servicenow_upsert_artifact: {
    summary: "Preview creating or updating a script include by name.",
    arguments: {
      artifactType: "script_include",
      key: "AcmeUtils",
      values: { script: "var AcmeUtils = Class.create();" },
    },
  },
  servicenow_upsert_record: {
    summary: "Preview creating or updating a property by name.",
    arguments: {
      table: "sys_properties",
      key: { name: "x_acme.enabled" },
      values: { value: "true" },
    },
  },
  servicenow_use_instance: {
    summary: "Switch the session to the test profile.",
    arguments: { name: "test" },
  },
  servicenow_where_used: {
    summary: "Where a field is used, structural references included.",
    arguments: {
      kind: "field",
      name: "incident.assignment_group",
      structural: true,
    },
  },
  servicenow_write_doc: {
    summary: "Write a note into the docs folder.",
    arguments: { path: "notes/upgrade.md", content: "# Upgrade notes\n" },
  },
};
