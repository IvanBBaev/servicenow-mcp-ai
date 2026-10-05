---
description: A read-only question about incidents is not a write.
expected_outcome: sn-safe-write does not load and no write tool is called.
tags: [sn-safe-write, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

How many priority 1 incidents are there on our dev instance right now? Just tell me the count and their numbers.
