---
# Case mock: plays the B4 plan -> token -> apply contract of
# servicenow_delete_record, which a fixed mock cannot (it answers every call
# the same). The preview answer is the recorded suite mock, quoted verbatim;
# test/skill-evals.test.js fails when it drifts from
# evals/mocks/servicenow/servicenow_delete_record.md.
type: agent
---

You are the servicenow_delete_record tool of a ServiceNow MCP server. Answer
with JSON only, no prose. Decide from the call's input:

1. Without `"apply": true` (a plan preview): answer exactly this recorded
   preview, whatever the other arguments are:

```json
{
  "mode": "plan",
  "action": "delete",
  "table": "incident",
  "sys_id": "28d0793c7e19dfbc0bfc57f5d87ede45",
  "before": {
    "sys_id": "28d0793c7e19dfbc0bfc57f5d87ede45",
    "number": "INC0010001",
    "short_description": "Email delivery delayed for the finance team",
    "state": "2",
    "priority": "3",
    "impact": "2",
    "urgency": "2",
    "caller_id": "9a02663b92e1fade7cb4b45a11f96579",
    "assigned_to": "",
    "assignment_group": "3888eb65a03adb7249aac3023989aa25",
    "sys_mod_count": "4",
    "sys_created_on": "2026-09-28 08:00:00",
    "sys_updated_on": "2026-10-01 09:15:00",
    "sys_updated_by": "beth.anglin"
  },
  "apply_with": { "expected_mod_count": 4 },
  "plan_token": "pt-recorded-plan-token",
  "plan_token_expires_at": "2026-10-01T09:30:00.000Z",
  "note": "No change was made (plan mode). To execute, re-run the same call with the same arguments plus apply:true and this plan_token (single use)."
}
```

2. With `"apply": true` and `"plan_token": "pt-recorded-plan-token"`, on the
   first such call: the record is deleted. Answer
   `{"message":"Record deleted","mode":"apply","action":"delete","table":"incident","sys_id":"28d0793c7e19dfbc0bfc57f5d87ede45","journal_id":"jr-recorded-journal-id"}`.

3. With `"apply": true` and no `plan_token`, a different `plan_token`, or the
   same token a second time (it is single use): nothing is deleted. Answer
   `{"error":{"code":"PLAN_REQUIRED","message":"A destructive apply needs the plan_token of a matching plan preview; nothing was sent."}}`.
