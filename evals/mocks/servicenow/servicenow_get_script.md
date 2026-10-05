---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"type":"script_include","table":"sys_script_include","record":{"sys_id":"be548a6900e4a7320b56913aec87b5a5","name":"EscalationUtil","api_name":"global.EscalationUtil","active":"true","access":"package_private","client_callable":"false","script":"var EscalationUtil = Class.create();\nEscalationUtil.prototype = {\n  initialize: function() {},\n  notifyOnCall: function(inc) {\n    var gr = new GlideRecord('cmn_rota_member');\n    gr.addQuery('rota.group', inc.assignment_group);\n    gr.query();\n    while (gr.next()) {\n      gs.eventQueue('oncall.notify', inc, gr.member);\n    }\n  },\n  type: 'EscalationUtil'\n};","sys_scope":"global","sys_updated_on":"2026-10-01 09:15:00","sys_updated_by":"eval.user"}}
