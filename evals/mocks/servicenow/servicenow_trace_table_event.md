---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"table":"incident","tables":["incident","task"],"operation":"update","chain":[{"phase":"database","type":"database","name":"database write"},{"phase":"after","type":"business_rule","name":"Escalate P1 incidents","order":100,"condition":"priorityCHANGESTO1","sys_id":"ff09bf7d3b65e05234f454441233505d","table":"incident"}],"mermaid":"flowchart TD\n  start[/\"update on incident\"/]\n  db[(\"database write\")]\n  start --> db\n  subgraph P_after[\"after\"]\n    direction TB\n    n0[\"Escalate P1 incidents\"]\n  end\n  db --> P_after\n  P_after --> done([done])","warnings":[]}
