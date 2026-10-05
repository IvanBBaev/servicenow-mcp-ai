---
description: A live breakage on the instance is triage, not a blast-radius estimate.
expected_outcome: sn-impact does not load and no where-used search runs.
tags: [sn-impact, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

Since this morning, P1 incidents on our dev instance stop escalating to the on-call team and users see errors. Find out what is going wrong.
