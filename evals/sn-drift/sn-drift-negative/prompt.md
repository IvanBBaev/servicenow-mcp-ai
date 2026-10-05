---
description: A single-record data change is a write, not a drift review.
expected_outcome: sn-drift does not load and no instance comparison runs.
tags: [sn-drift, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

On our dev instance, please set the priority of incident INC0010001 to 2.
