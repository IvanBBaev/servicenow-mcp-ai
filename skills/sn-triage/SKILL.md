---
name: sn-triage
description: Triage a ServiceNow incident or a failing behaviour — instance health, recent errors, what automation runs on the table, and what changed on the record. Use when something is broken, slow or erroring on an instance.
---

# sn-triage — first look at a problem

Read-only. Every call goes through the ServiceNow MCP server with the active
profile; nothing here writes to the instance.

## Steps

1. Health first: `servicenow_get_status` (profile, packages, write mode) and
   `servicenow_check_capabilities` (what this user can read). A missing
   capability explains many "empty" answers.
2. Symptoms: `servicenow_read_ops` with `kind: "syslog"` and `level: "error"`
   for the last minutes; `kind: "jobs"` with `filter: "overdue"` for stuck
   scheduled work; `kind: "email_queue"` for mail problems;
   `kind: "transactions"`, `"integrations"` and `"mid"` for slow pages,
   failing outbound calls and MID / ECC queue trouble.
3. The record: `servicenow_get_record` for the current state, then
   `servicenow_get_record_history` to see who changed which field and when.
4. The automation that touches it: `servicenow_describe_table_logic` for the table's
   business rules, client scripts, UI policies, UI actions and ACLs, and
   `servicenow_trace_table_event` (`operation: "update"` or `"insert"`) for the
   order they run in. `servicenow_get_flow_runs` shows flow executions for the
   record.
5. Suspect code: `servicenow_get_script` and `servicenow_lint_script` on the
   script the trace points at; `servicenow_search_code` for an error message
   text.

## Output

A short report: the symptom, the evidence (log lines, history entries, the
rule or script in the trace), the most likely cause, and the next step. Never
paste credentials or property values that look like secrets.
