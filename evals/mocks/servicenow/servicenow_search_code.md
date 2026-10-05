---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"count":2,"matches":[{"type":"business_rule","sys_id":"ff09bf7d3b65e05234f454441233505d","name":"Escalate P1 incidents","table":"incident","field":"script","line":3,"snippet":"new EscalationUtil().notifyOnCall(current);","hits":[{"field":"script","line":3,"text":"new EscalationUtil().notifyOnCall(current);","before":"if (current.priority == 1 && previous.priority != 1) {","after":"gs.eventQueue('incident.escalated', current, current.assignment_group);"}],"hitCount":1},{"type":"script_include","sys_id":"be548a6900e4a7320b56913aec87b5a5","name":"EscalationUtil","field":"script","line":1,"snippet":"var EscalationUtil = Class.create();","hits":[{"field":"script","line":1,"text":"var EscalationUtil = Class.create();","after":"EscalationUtil.prototype = {"},{"field":"script","line":2,"text":"EscalationUtil.prototype = {","before":"var EscalationUtil = Class.create();","after":"initialize: function() {},"},{"field":"script","line":12,"text":"type: 'EscalationUtil'","before":"},","after":"};"}],"hitCount":3}]}
