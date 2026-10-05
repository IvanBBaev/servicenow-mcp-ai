---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"artifactType":"business_rule","table":"sys_script","verified":true,"sys_id":"ff09bf7d3b65e05234f454441233505d","name":"Escalate P1 incidents","key":{"sys_id":"ff09bf7d3b65e05234f454441233505d"},"scope":{"sys_id":"global","scope":"global"},"sdkManaged":{"managed":"unknown","unverified":false,"evidence":[],"warnings":["sys_scope record not found; identity is incomplete"]},"summary":"business_rule 'Escalate P1 incidents' (sys_script); applies to incident; active; scope global","when":{"when":"after","order":"100","action_insert":"true","action_update":"true","action_delete":"false","action_query":"false","filter_condition":"priorityCHANGESTO1"},"fields":{"name":"Escalate P1 incidents","collection":"incident","when":"after","order":"100","active":"true","script":"(function executeRule(current, previous) {\n  if (current.priority == 1 && previous.priority != 1) {\n    new EscalationUtil().notifyOnCall(current);\n    gs.eventQueue('incident.escalated', current, current.assignment_group);\n  }\n})(current, previous);","action_delete":"false","action_insert":"true","action_query":"false","action_update":"true","filter_condition":"priorityCHANGESTO1"},"children":[],"references":[],"decoded":[]}
