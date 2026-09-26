---
name: sn-safe-write
description: Change ServiceNow data safely — plan first, apply only after review, verify, and know how to revert. Use whenever a create, update, upsert or delete on an instance is requested.
---

# sn-safe-write — plan, review, apply, verify

The server runs writes in plan mode by default: a write tool called without
`apply: true` returns a before/after preview and changes nothing. Keep it
that way.

## Steps

1. Check the mode and the target: `servicenow_get_status` (write mode,
   active profile). Never switch profiles or write modes silently.
2. Read the current state: `servicenow_get_record` or
   `servicenow_query_table` for the rows you will touch.
3. Plan: call `servicenow_create_record`, `servicenow_update_record`,
   `servicenow_upsert_record` or `servicenow_delete_record` **without**
   `apply`. Show the user the preview (the fields that change, before and
   after).
4. Apply only after the user approves this preview: repeat the same call with
   `apply: true`. For configuration records pass `update_set` so the change is
   captured.
5. Verify: read the record back with `servicenow_get_record`.
6. Undo path: `servicenow_list_writes` shows the local write journal;
   `servicenow_revert_write` (the opt-in `revert` package) plans the inverse
   of an entry and applies it with `apply: true`.

## Rules

- One approval covers one previewed call. A changed payload needs a new plan.
- Bulk changes go through `servicenow_batch` only after a single-record dry
  run succeeded.
- Never paste secrets into `fields`; credentials change through
  `servicenow_set_credentials` only.
