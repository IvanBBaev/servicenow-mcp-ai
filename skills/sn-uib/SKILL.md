---
name: sn-uib
description: Review a ServiceNow UI Builder (UIB) experience or workspace page — its page map, what a change would touch, data broker security and page weight. Use when asked to explain, audit or assess a UI Builder page, workspace or experience before changing it.
---

# sn-uib — review a UI Builder page

Read-only review through the ServiceNow MCP server. The same walk is
available as the server's "Review a UI Builder page" MCP prompt.

## Steps

1. Packages: this skill calls tools from `ui`, `artifacts`, `scripts`,
   `updatesets`, `codecheck` and `instance`, which the default `core` profile
   leaves off. Read `enabledPackages` in `servicenow_get_status`; for a missing
   package, enable it with the server's `enable_package` admin tool and tell
   the user, or ask the operator to add it to `SN_TOOL_PACKAGES`. A package
   listed in `deniedPackages` cannot be enabled — skip the steps that need it
   and report them as not checked.
2. The page map: `servicenow_explain_ui_experience` with the experience
   `path` (e.g. `now/sow`) or its sys_ux_page_registry `sys_id`. It lists
   routes, screens, macroponents, data brokers, ACLs and form actions. Ask
   for `format: "file"` when you need element props, bindings, event chains
   and page metrics.
3. What a change would touch: `servicenow_get_artifact_dependencies` for the
   page's macroponent (`artifactType: "uib_macroponent"`,
   `direction: "both"`), then `servicenow_where_used` with `kind: "script"`
   for a script include the page's data brokers call. When the page is part
   of an update set, `servicenow_get_update_set` shows whether the UIB
   records travel together.
4. Data broker security: read the explain answer's broker hints, then
   `servicenow_check_code_health` with `domains: true` for the data broker
   and UI Builder checks.
5. Page weight and composition: read the explain answer's page hints
   (element count, nesting, data resources). To compare the page with
   another instance, `servicenow_compare_instances` with
   `types: ["uib_macroponent"]`.

## Output

A short review per page: what it is (route, screen, macroponent), what
depends on it and what it depends on, broker security findings, weight
and composition notes, then a risk call — safe to change, needs
coordination, or risky. Say which sources were unreadable — an absent
finding is not proof there is none. Do not change any record.
