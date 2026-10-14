---
description: A failing business rule is triage, not an access review.
expected_outcome: sn-security does not load, no access explanation or security scan runs, and nothing is written.
tags: [sn-security, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

Since this morning, P1 incidents on our dev instance stop escalating to the on-call team and the system log shows errors. Find out what is going wrong.
