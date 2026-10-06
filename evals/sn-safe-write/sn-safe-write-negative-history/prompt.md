---
description: A question about past changes to a record reads its history; it is not a write.
expected_outcome: sn-safe-write does not load and no write tool is called.
tags: [sn-safe-write, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

Who changed the priority of incident INC0010001 on our dev instance, and when? I want to know what happened to it.
