---
name: sn-safe-write
description: Change ServiceNow data safely — plan first, apply only after review, verify, and know how to revert. Use whenever a create, update, upsert or delete on an instance is requested.
---

# sn-safe-write — plan, review, apply, verify

A write tool called without `apply: true` returns a before/after preview and
changes nothing **only while the server is in plan mode** (the default). In
apply mode (`SN_WRITE_MODE=apply`) the same call executes at once. So the
first step is always to learn the mode — never send a write call before it.

## Steps

1. Check the mode and the target: `servicenow_get_status` — `writeMode`,
   `policy.destructiveConfirm`, the active profile and its entry in
   `profileDetails` (`env`, `writeMode`, `writeModeHold`). Never switch
   profiles or write modes silently.
2. Pick the branch from that answer:
   - **Plan mode** (`writeMode: "plan"`) — continue with step 3; a call
     without `apply` is a safe preview.
   - **Apply mode on a non-prod profile** (`writeMode: "apply"`) — there is no
     preview: every write call, with or without `apply`, changes the instance,
     and destructive tools skip the `plan_token` check. **Stop and ask the
     user** before any write call: describe the exact change (table, record,
     fields, old and new values from step 3's read) and wait for an explicit
     yes. Offer to have the operator switch this profile to plan mode instead.
   - **Prod profile** (`env: "prod"`) — a prod profile configured for apply
     stays in plan mode (`writeModeHold` says why) until the operator
     acknowledges it with `SN_PROD_WRITES=I_UNDERSTAND` (or the per-profile
     form); while held, follow the plan branch and say the target is
     production when you show the preview. If prod really is in apply mode,
     follow the apply branch above, and expect destructive
     tools to ask for a client confirmation (or to fail with
     `CONFIRM_REQUIRED` when the client cannot confirm).
3. Read the current state: `servicenow_get_record` or
   `servicenow_query_table` for the rows you will touch.
4. Plan (plan mode only): call `servicenow_create_record`,
   `servicenow_update_record`, `servicenow_upsert_record` or
   `servicenow_delete_record` **without** `apply`. Check that the answer says
   `mode: "plan"`, then show the user the preview (the fields that change,
   before and after).
5. Apply only after the user approves this preview: repeat the same call with
   `apply: true`. A non-destructive write (create, update, upsert) needs
   nothing else. A destructive apply (`servicenow_delete_record`, a writing
   `servicenow_batch`, `servicenow_revert_write`, …) also needs the
   `plan_token` from that preview — the server refuses it with
   `PLAN_REQUIRED` otherwise, and the plugin's hook stops it before it is
   sent. In apply mode, the approved call from step 2 is the one and only
   call. For configuration records pass `update_set` so the change is
   captured.
6. Verify: read the record back with `servicenow_get_record`.
7. Undo path: `servicenow_list_writes` shows the local write journal;
   `servicenow_revert_write` (the opt-in `revert` package) plans the inverse
   of an entry and applies it with `apply: true`.

## Rules

- One approval covers one previewed call. A changed payload needs a new plan.
- Never assume plan mode: a write call made before step 1 may already be a
  change on the instance.
- Bulk changes go through `servicenow_batch` only after a single-record dry
  run succeeded.
- Never paste secrets into `values`; credentials change through
  `servicenow_set_credentials` only.
