---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"table":"incident","count":10,"columns":[{"element":"assigned_to","label":"Assigned to","type":"reference","mandatory":false,"maxLength":40,"reference":"sys_user","sourceTable":"task"},{"element":"assignment_group","label":"Assignment group","type":"reference","mandatory":false,"maxLength":40,"reference":"sys_user_group","sourceTable":"task"},{"element":"caller_id","label":"Caller","type":"reference","mandatory":false,"maxLength":40,"reference":"sys_user","sourceTable":"incident"},{"element":"impact","label":"Impact","type":"integer","mandatory":false,"maxLength":40,"sourceTable":"incident"},{"element":"number","label":"Number","type":"string","mandatory":false,"maxLength":160,"sourceTable":"task"},{"element":"priority","label":"Priority","type":"integer","mandatory":false,"maxLength":40,"sourceTable":"task"},{"element":"short_description","label":"Short description","type":"string","mandatory":false,"maxLength":160,"sourceTable":"task"},{"element":"state","label":"State","type":"integer","mandatory":false,"maxLength":40,"sourceTable":"task"},{"element":"u_vendor_contract","label":"Vendor contract","type":"reference","mandatory":false,"maxLength":40,"reference":"u_vendor_contract","sourceTable":"incident"},{"element":"urgency","label":"Urgency","type":"integer","mandatory":false,"maxLength":40,"sourceTable":"incident"}]}
