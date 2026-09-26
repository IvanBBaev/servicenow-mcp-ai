---
name: sn-drift
description: Find configuration drift between two ServiceNow instances or against a saved snapshot, or review what an update set will change. Use when comparing dev / test / prod, checking a promotion, or reviewing an update set.
---

# sn-drift — what differs, and where

Read-only against the instances; snapshots are written locally.

## Steps

1. Both sides must be configured profiles: `servicenow_list_instances`.
2. Baseline: `servicenow_snapshot_instance` on the reference instance
   (optionally limited with `sections` or `tables`). A cancelled or failed
   snapshot resumes with `resume`.
3. Compare: `servicenow_compare_instances` with `a` and `b` (profile names),
   or `from_snapshot` to compare a live instance against the saved baseline.
   Use `format: "file"` for a large result.
4. Update sets: `servicenow_list_update_sets`, then
   `servicenow_compare_update_set` to see what an update set would change
   against the target (`with_profile` or `with_snapshot`), and
   `servicenow_get_update_set` for its records.
5. Drill into a difference with `servicenow_get_artifact` or
   `servicenow_explain_artifact` on each side.

## Output

Group differences into added / removed / changed per artefact type, flag
anything security-relevant (ACLs, roles, cross-scope privileges) first, and
name the update set or the manual change that would reconcile each item.
