---
description: Suggesting assignees for unassigned incidents is advice; the user makes the change.
expected_outcome: sn-safe-write does not load, no write tool is called, and the agent only suggests assignees.
tags: [sn-safe-write, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

Which open incidents on our dev instance have no assignee yet? Suggest who should take each one. I will assign them myself.
