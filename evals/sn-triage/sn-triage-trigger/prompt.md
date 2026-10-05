---
description: A failing behaviour on an instance must load sn-triage.
expected_outcome: sn-triage loads, the agent reads recent errors with servicenow_read_ops and traces the failure to EscalationUtil.
tags: [sn-triage, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

Since this morning, P1 incidents on our dev instance stop escalating to the on-call team and users see errors. Find out what is going wrong.
