---
name: sn-triage
description: Triage a ServiceNow incident or a failing behaviour — instance health, recent errors, what automation runs on the table, and what changed on the record. Use when something is broken, slow or erroring on an instance.
---

# sn-triage — first look at a problem

Read-only. Every call goes through the ServiceNow MCP server with the active
profile; nothing here writes to the instance.

## When not to use

- Assessing a planned change — use sn-impact; comparing environments — use
  sn-drift.
- Fixing the problem — once the cause is known, the fix goes through
  sn-safe-write.
- Hand-off: a long, read-heavy dig (many records, flows or scripts) goes to
  the `sn-investigator` subagent (where the client has it), so the main
  conversation keeps only its report.

## Steps

1. Packages: this skill calls tools from `ops`, `history`, `scripts`, `flows`
   and `codecheck`, which the default `core` profile leaves off. Read
   `enabledPackages` in `servicenow_get_status`; for a missing package, enable
   it with the server's `enable_package` admin tool and tell the user, or ask
   the operator to add it to `SN_TOOL_PACKAGES`. A package listed in
   `deniedPackages` cannot be enabled — skip the steps that need it and report
   them as not checked.
2. Health: the same `servicenow_get_status` answer (profile, write mode) and
   `servicenow_check_capabilities` (what this user can read). A missing
   capability explains many "empty" answers.
3. Symptoms: `servicenow_read_ops` with `kind: "syslog"` and `level: "error"`
   for the last minutes; `kind: "jobs"` with `filter: "overdue"` for stuck
   scheduled work; `kind: "email_queue"` for mail problems;
   `kind: "transactions"`, `"integrations"` and `"mid"` for slow pages,
   failing outbound calls and MID / ECC queue trouble.
4. The record: `servicenow_get_record` for the current state, then
   `servicenow_get_record_history` to see who changed which field and when.
5. The automation that touches it: `servicenow_describe_table_logic` for the table's
   business rules, client scripts, UI policies, UI actions and ACLs, and
   `servicenow_trace_table_event` (`operation: "update"` or `"insert"`) for the
   order they run in. `servicenow_get_flow_runs` shows flow executions for the
   record.
6. Suspect code: `servicenow_get_script` and `servicenow_lint_script` on the
   script the trace points at; `servicenow_search_code` for an error message
   text.

## Output

A short report: the symptom, the evidence (log lines, history entries, the
rule or script in the trace), the most likely cause, and the next step. Never
paste credentials or property values that look like secrets.
