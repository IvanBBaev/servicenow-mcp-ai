---
name: sn-impact
description: Estimate the blast radius of changing a ServiceNow table, field or script — what references it and what automation runs around it. Use before renaming, deleting or changing a field, table, script include or business rule.
---

# sn-impact — who depends on this?

Read-only analysis through the ServiceNow MCP server.

## Steps

1. Packages: this skill calls tools from `scripts`, `artifacts`, `flows` and
   `docs` (the diagram), which the default `core` profile leaves off. Read
   `enabledPackages` in `servicenow_get_status`; for a missing package, enable
   it with the server's `enable_package` admin tool and tell the user, or ask
   the operator to add it to `SN_TOOL_PACKAGES`. A package listed in
   `deniedPackages` cannot be enabled — skip the steps that need it and report
   them as not checked.
2. Identify the target exactly: `servicenow_describe_table` for a table or a
   field (type, reference, inheritance); `servicenow_get_artifact` or
   `servicenow_explain_artifact` for a script, UI policy, flow or other
   artefact.
3. Where it is used: `servicenow_where_used` with `kind` `table`, `field` or
   `script` and the `name`. Set `structural: true` to add dictionary
   references, and `scope` to stay inside one application.
4. Text references the structural pass cannot see:
   `servicenow_search_code` with the name (script includes, field names in
   GlideRecord calls).
5. What runs on the table: `servicenow_describe_table_logic` and, for the operation you
   will change, `servicenow_trace_table_event`.
6. Optional picture: `servicenow_generate_er_diagram` for the table and its
   neighbours.

## Output

A list of dependants grouped by kind (reference fields, scripts, automation,
flows), each with where it lives (scope, table, sys_id), and a risk call:
safe, needs coordination, or breaking. Say which sources were unreadable —
an absent dependant is not proof there is none.
