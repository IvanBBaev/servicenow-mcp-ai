---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"tables":["incident"],"mermaid":"erDiagram\n  incident {\n    reference assigned_to\n    reference assignment_group\n    reference caller_id\n    integer impact\n    string number\n    integer priority\n    string short_description\n    integer state\n    reference u_vendor_contract\n    integer urgency\n  }\n  incident }o--|| sys_user : \"assigned_to\"\n  incident }o--|| sys_user_group : \"assignment_group\"\n  incident }o--|| sys_user : \"caller_id\"\n  incident }o--|| u_vendor_contract : \"u_vendor_contract\""}
