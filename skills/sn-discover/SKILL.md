---
name: sn-discover
description: Map a ServiceNow instance into Markdown (version and counts, custom applications, per-scope tables and artefacts) with the server's own document generator. Use when asked to discover, survey, inventory or document an instance or its custom apps.
---

# sn-discover — native instance discovery

Discovery runs inside the ServiceNow MCP server: one call to
`servicenow_document_instance` with a `depth` writes the files under
`<SN_DOCS_DIR>/<profile>/discovery/`. This skill holds **no credentials** and
makes no HTTP calls of its own — the server's profile, table policy,
redaction, capability preflight and write journal apply to every read and
file.

## Steps

1. Confirm the target: `servicenow_list_instances`, then
   `servicenow_test_connection` for the profile you will document. Switch with
   `servicenow_use_instance` only if the user asked for another instance.
2. Pick the tier (cumulative):
   - `overview` — `discovery/overview.md`: version, counts, automation.
   - `apps` — adds `discovery/apps.md` and `discovery/tables-<scope>.md` per
     custom application (tables and their own dictionary columns).
   - `artefacts` — adds `discovery/artifacts-<scope>.md` per scope: every
     artefact type the server knows, with "collected / not collected and why"
     (no records, unverified, unreadable, package off, cap).
3. Call `servicenow_document_instance({ depth })`. Pass `apps: [...]` to limit
   the scopes; without it every `sys_app` scope is covered (at most 50 per run
   — the rest are listed as a caveat). Add `write: false` for a dry run that
   returns the Markdown instead of writing it.
4. Read the result back with `servicenow_docs_read` (for example
   `default/discovery/overview.md`) and summarise: counts, the largest scopes,
   and every Caveats line — a caveat is where the map is incomplete.
5. For one scope in depth, follow up with `servicenow_document_app` or
   `servicenow_document_table`; `servicenow_docs_search` finds text across the
   written documents.

## Rules

- Read-only against the instance: the tool writes local Markdown only.
- Re-running with the same depth over unchanged metadata leaves the files
  `unchanged`; hand-written text inside `sn:manual` blocks survives re-runs.
- Report the tool's `failed` entries verbatim; do not retry a scope blindly.
