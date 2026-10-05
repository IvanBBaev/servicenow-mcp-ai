---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"artifactType":"business_rule","table":"sys_script","verified":true,"sys_id":"ff09bf7d3b65e05234f454441233505d","name":"Escalate P1 incidents","key":{"sys_id":"ff09bf7d3b65e05234f454441233505d"},"scope":{"sys_id":"global","scope":"global"},"sdkManaged":{"managed":"unknown","unverified":false,"evidence":[],"warnings":["sys_scope record not found; identity is incomplete"]},"record":{"sys_id":"ff09bf7d3b65e05234f454441233505d","name":"Escalate P1 incidents","collection":"incident","when":"after","order":"100","active":"true","action_insert":"true","action_update":"true","action_delete":"false","action_query":"false","filter_condition":"priorityCHANGESTO1","condition":"","script":"(function executeRule(current, previous) {\n  if (current.priority == 1 && previous.priority != 1) {\n    new EscalationUtil().notifyOnCall(current);\n    gs.eventQueue('incident.escalated', current, current.assignment_group);\n  }\n})(current, previous);","sys_scope":"global","sys_updated_on":"2026-10-01 09:15:00","sys_updated_by":"eval.user"},"children":[]}
